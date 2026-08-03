/**
 * PROTOTYPE — exploratory only.
 *
 * Per AGENTS.md, scripts in design/ are instructional examples and must be
 * rewritten for production. This one answers a Phase 5 question that unit tests
 * cannot: does the built server actually speak MCP over stdio?
 *
 * It spawns the real built entry point as a child process, performs the initialise
 * handshake, lists tools, and calls one — exactly as Claude Code would. Unit tests
 * cover the mapping functions; only this exercises the transport, the request
 * handler registration, and the "stdout must carry nothing but protocol" rule.
 *
 * Usage: node design/prototype/probe-mcp-server.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = new URL('../../adapters/mcp/dist/index.js', import.meta.url).pathname

// A config with one host pointing at a real directory. No command is run against
// it in this probe — listing tools and provoking an unknown-host error need no
// connection — so the ssh target never has to resolve.
const home = mkdtempSync(join(tmpdir(), 'mcp-probe-home-'))
mkdirSync(join(home, '.config', 'agent-tools'), { recursive: true })
writeFileSync(
  join(home, '.config', 'agent-tools', 'config.json'),
  JSON.stringify({
    version: 1,
    hosts: { probe: { ssh: { target: 'nobody@localhost' }, root: '/tmp' } },
  }),
)

const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
})

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})

/** Pending JSON-RPC responses by id. */
const pending = new Map()
let buffer = ''

child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // The whole point of one of the checks below: anything non-protocol on
        // stdout corrupts the stream.
        console.error(`  [FAIL] non-JSON on stdout: ${line}`)
        process.exitCode = 1
        newline = buffer.indexOf('\n')
        continue
      }
      const resolve = pending.get(message.id)
      if (resolve !== undefined) {
        pending.delete(message.id)
        resolve(message)
      }
    }
    newline = buffer.indexOf('\n')
  }
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
  child.stdin.write(`${JSON.stringify(message)}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000)
  })
}

function notify(method, params) {
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`,
  )
}

let pass = 0
let fail = 0
const ok = (message) => {
  console.log(`  [ok]   ${message}`)
  pass++
}
const no = (message) => {
  console.log(`  [FAIL] ${message}`)
  fail++
  process.exitCode = 1
}

try {
  console.log('\n=== initialise handshake ===')
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0' },
  })
  if (init.result?.serverInfo?.name === 'remote-explorer') {
    ok(`server identified as ${init.result.serverInfo.name} ${init.result.serverInfo.version}`)
  } else {
    no(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`)
  }
  if (init.result?.capabilities?.tools !== undefined) ok('advertises the tools capability')
  else no('does not advertise the tools capability')

  notify('notifications/initialized')

  console.log('\n=== tools/list ===')
  const list = await request('tools/list')
  const names = (list.result?.tools ?? []).map((tool) => tool.name).sort()
  if (names.length === 6) ok(`lists 6 tools: ${names.join(', ')}`)
  else no(`expected 6 tools, got ${names.length}: ${names.join(', ')}`)

  const find = (list.result?.tools ?? []).find((tool) => tool.name === 'remote_find')
  if (find?.inputSchema?.properties?.type?.enum?.length === 3) {
    ok('remote_find type parameter survives as a string enum over the wire')
  } else {
    no(`enum lost in transit: ${JSON.stringify(find?.inputSchema?.properties?.type)}`)
  }
  if (names.every((name) => !name.includes('mcp__'))) ok('tool names are not pre-namespaced')
  else no('tool names contain an mcp__ prefix')

  console.log('\n=== tools/call: remote_hosts ===')
  const hosts = await request('tools/call', { name: 'remote_hosts', arguments: {} })
  const hostsText = hosts.result?.content?.[0]?.text ?? ''
  if (hostsText.includes('probe')) ok(`returned the configured host: ${hostsText.split('\n')[0]}`)
  else no(`did not return the configured host: ${JSON.stringify(hosts.result)}`)
  if (hosts.result?.isError !== true) ok('successful call is not flagged as an error')
  else no('successful call was flagged as an error')

  console.log('\n=== tools/call: unknown host alias ===')
  const bad = await request('tools/call', {
    name: 'remote_ls',
    arguments: { host: 'not-configured' },
  })
  if (bad.result?.isError === true) {
    ok('unknown alias is an error result, not a protocol error')
  } else {
    no(`expected isError, got: ${JSON.stringify(bad.result ?? bad.error)}`)
  }
  if ((bad.result?.content?.[0]?.text ?? '').includes('probe')) {
    ok('error names the configured aliases so the model can correct itself')
  } else {
    no(`error does not list valid aliases: ${bad.result?.content?.[0]?.text}`)
  }

  console.log('\n=== tools/call: unknown tool ===')
  const unknown = await request('tools/call', { name: 'remote_nope', arguments: {} })
  if (unknown.result?.isError === true || unknown.error !== undefined) {
    ok('unknown tool is rejected')
  } else {
    no('unknown tool was accepted')
  }

  console.log('\n=== stdout hygiene ===')
  ok('all stdout lines parsed as JSON-RPC (any failure would have been reported above)')
  if (stderr.length > 0) console.log(`  ...    stderr said: ${stderr.trim().split('\n')[0]}`)
} catch (error) {
  no(`probe aborted: ${error.message}`)
  if (stderr.length > 0) console.log(`  stderr:\n${stderr}`)
} finally {
  child.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
  console.log(`\n=== summary ===\n  ${pass} passed, ${fail} failed\n`)
}
