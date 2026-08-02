import { parseConfig } from '@agent-tools/core'
import { createToolContext } from '@agent-tools/remote-explorer'
import { createTestRemoteOps, type TestRemoteOps } from '@agent-tools/test-support'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Tool context — resolves a host alias to a live session.
 *
 * The alias is the only host identifier a model ever supplies (ADR-004), so this
 * is where that boundary is enforced at the tool layer. The RemoteOps factory is
 * injected rather than hardcoded to SshRemoteOps, which is what lets tier 1 drive
 * the real tool handlers against TestRemoteOps.
 */

const created: TestRemoteOps[] = []

afterEach(async () => {
  while (created.length > 0) await created.pop()?.close()
})

async function contextWith(aliases: string[]) {
  const hosts: Record<string, unknown> = {}
  const opsByAlias = new Map<string, TestRemoteOps>()

  for (const alias of aliases) {
    const ops = await createTestRemoteOps({ alias })
    created.push(ops)
    opsByAlias.set(alias, ops)
    hosts[alias] = { ssh: { target: `user@${alias}` }, root: await ops.root() }
  }

  const config = parseConfig({ version: 1, hosts }, 'test')
  const context = createToolContext({
    config,
    createOps: (host) => {
      const ops = opsByAlias.get(host.alias)
      if (ops === undefined) throw new Error(`no stub ops for ${host.alias}`)
      return ops
    },
  })

  return { context, opsByAlias }
}

describe('createToolContext', () => {
  it('lists configured hosts with their roots', async () => {
    const { context, opsByAlias } = await contextWith(['alpha', 'beta'])
    const hosts = context.hosts()
    expect(hosts.map((host) => host.alias).sort()).toEqual(['alpha', 'beta'])
    expect(hosts.find((host) => host.alias === 'alpha')?.root).toBe(
      await opsByAlias.get('alpha')?.root(),
    )
  })

  it('opens a session for a configured alias', async () => {
    const { context } = await contextWith(['alpha'])
    const session = await context.session('alpha')
    expect(session.alias).toBe('alpha')
    expect(session.root.startsWith('/')).toBe(true)
  })

  it('exposes capabilities on the session', async () => {
    const { context } = await contextWith(['alpha'])
    const session = await context.session('alpha')
    expect(session.capabilities.tools.has('grep')).toBe(true)
  })

  it('rejects an unknown alias without attempting a connection', async () => {
    const { context } = await contextWith(['alpha'])
    await expect(context.session('nope')).rejects.toThrow(
      expect.objectContaining({ code: 'UNKNOWN_HOST' }),
    )
  })

  it('reuses one session per alias rather than reconnecting', async () => {
    const { context } = await contextWith(['alpha'])
    const [first, second] = await Promise.all([context.session('alpha'), context.session('alpha')])
    expect(first).toBe(second)
  })

  it('closes every open session', async () => {
    const { context } = await contextWith(['alpha', 'beta'])
    await context.session('alpha')
    await context.close()
    // Closing is idempotent and must not throw on a context with live sessions.
    await expect(context.close()).resolves.toBeUndefined()
  })
})
