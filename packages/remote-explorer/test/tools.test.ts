import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseConfig } from '@agent-tools/core'
import {
  createToolContext,
  remoteHosts,
  remoteLs,
  type ToolContext,
} from '@agent-tools/remote-explorer'
import { createTestRemoteOps, type TestRemoteOps } from '@agent-tools/test-support'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Tool handlers, tier 1 (ADR-011).
 *
 * Driven through TestRemoteOps against a real fixture tree, so `ls` output is
 * parsed from what the real binary emits rather than from a reimplementation.
 */

let ops: TestRemoteOps
let context: ToolContext
let root: string

async function setup(): Promise<void> {
  ops = await createTestRemoteOps({ alias: 'box' })
  root = await ops.root()
  await ops.writeTree({
    'README.md': '# hello\n',
    'src/index.ts': 'export const x = 1\n',
    'src/nested/deep.txt': 'needle\n',
    '.hidden': 'hidden\n',
    'spaced name.txt': 'spaced\n',
  })

  const config = parseConfig(
    { version: 1, hosts: { box: { ssh: { target: 'u@box' }, root } } },
    'test',
  )
  context = createToolContext({ config, createOps: () => ops })
}

afterEach(async () => {
  await context?.close()
  await ops?.close()
})

describe('remote_hosts', () => {
  it('is named for the model without a namespace prefix', () => {
    expect(remoteHosts.name).toBe('remote_hosts')
  })

  it('lists configured aliases and roots', async () => {
    await setup()
    const result = await remoteHosts.handler({}, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('box')
    expect(result.text).toContain(root)
  })

  it('says so plainly when nothing is configured', async () => {
    const config = parseConfig({ version: 1, hosts: {} }, 'test')
    const empty = createToolContext({ config, createOps: () => ops })
    const result = await remoteHosts.handler({}, empty)
    expect(result.text).toMatch(/no hosts|none/i)
  })

  it('takes no parameters', () => {
    expect(Object.keys(remoteHosts.parameters.properties ?? {})).toHaveLength(0)
  })
})

describe('remote_ls', () => {
  it('lists entries at the root', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('README.md')
    expect(result.text).toContain('src')
  })

  it('marks directories distinguishably from files', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box' }, context)
    const details = result.details as { entries: Array<{ name: string; type: string }> }
    const src = details.entries.find((entry) => entry.name === 'src')
    const readme = details.entries.find((entry) => entry.name === 'README.md')
    expect(src?.type).toBe('directory')
    expect(readme?.type).toBe('file')
  })

  it('includes dotfiles, which are the point of exploring a remote box', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box' }, context)
    expect(result.text).toContain('.hidden')
  })

  it('lists a subdirectory', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box', path: 'src' }, context)
    expect(result.text).toContain('index.ts')
    expect(result.text).toContain('nested')
  })

  it('handles a name containing a space', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box' }, context)
    expect(result.text).toContain('spaced name.txt')
  })

  it('rejects a path outside the root', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box', path: '../..' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('rejects a symlink that escapes the root', async () => {
    await setup()
    await symlink('/etc', join(root, 'escape'))
    const result = await remoteLs.handler({ host: 'box', path: 'escape' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('reports an unknown host as an error result rather than throwing', async () => {
    await setup()
    // A thrown exception would surface as a crash in the host agent; tools must
    // return errors the model can read and act on.
    const result = await remoteLs.handler({ host: 'nope' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('box')
  })

  it('reports a missing directory as an error result', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box', path: 'no-such-dir' }, context)
    expect(result.isError).toBe(true)
  })

  it('states explicitly when the listing was truncated', async () => {
    await setup()
    const tree: Record<string, string> = {}
    for (let index = 0; index < 50; index++) tree[`file-${index}.txt`] = 'x'
    await ops.writeTree(tree)

    const result = await remoteLs.handler({ host: 'box', limit: 10 }, context)
    expect(result.text).toMatch(/truncat/i)
    const details = result.details as { entries: unknown[]; truncated: boolean }
    expect(details.entries).toHaveLength(10)
    expect(details.truncated).toBe(true)
  })

  it('does not claim truncation when everything fits', async () => {
    await setup()
    const result = await remoteLs.handler({ host: 'box' }, context)
    expect(result.text).not.toMatch(/truncat/i)
  })

  it('declares host as a required parameter', () => {
    expect(remoteLs.parameters.required).toContain('host')
  })
})
