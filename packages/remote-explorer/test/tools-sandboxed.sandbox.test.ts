import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseConfig } from '@agent-tools/core'
import {
  createToolContext,
  remoteFind,
  remoteGrep,
  remoteLs,
  remoteRead,
  remoteStat,
  type ToolContext,
} from '@agent-tools/remote-explorer'
import { createLocalSandboxRemoteOps, type LocalSandboxRemoteOps } from '@agent-tools/test-support'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The six tools, driven through a real bwrap sandbox — test tier 3 (ADR-011).
 *
 * Tier 1 already covers tool logic against real binaries, but it runs them
 * unsandboxed. That leaves a gap this closes: every invocation the tools issue
 * must also work *inside* the restricted mount namespace, where only the root and
 * the discovered toolchain paths exist. A missing bind, or a `stat`/`sed` that is
 * absent from the sandbox, would fail here and nowhere else.
 *
 * Skipped unless tier 3 is enabled (see vitest.config.ts).
 */

let ops: LocalSandboxRemoteOps
let context: ToolContext
let root: string

async function write(relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

beforeEach(async () => {
  ops = await createLocalSandboxRemoteOps()
  root = await ops.root()

  await write('README.md', '# Title\nneedle here\n')
  await write('src/index.ts', 'export const alpha = 1\nexport const needle = 2\n')
  await write('src/nested/deep.txt', 'needle in the deep\n')
  await write('logs/app.log', 'line one\nline two\nline three\nline four\nline five\n')

  const config = parseConfig(
    { version: 1, hosts: { box: { ssh: { target: 'unused@sandbox' }, root } } },
    'tier-3-test',
  )
  context = createToolContext({ config, createOps: () => ops })
})

afterEach(async () => {
  await context?.close()
  await ops?.close()
})

describe('the sandbox is genuinely in use', () => {
  it('reports a sandboxed session', async () => {
    const session = await context.session('box')
    expect(session.capabilities.hasSandbox).toBe(true)
  })

  it('cannot write, so every tool below is operating read-only', async () => {
    const result = await ops.exec(['sh', '-c', 'touch ./canary'])
    expect(result.exitCode).not.toBe(0)
  })
})

describe('remote_ls inside the sandbox', () => {
  it('lists the root', async () => {
    const result = await remoteLs.handler({ host: 'box' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('README.md')
    expect(result.text).toContain('src/')
  })

  it('lists a subdirectory', async () => {
    const result = await remoteLs.handler({ host: 'box', path: 'src' }, context)
    expect(result.text).toContain('index.ts')
  })
})

describe('remote_stat inside the sandbox', () => {
  it('runs stat -c and parses its output', async () => {
    // The specific risk: `stat` must exist inside the namespace and support the
    // -c format specifiers. Tier 1 proved that on the host, not in here.
    const result = await remoteStat.handler({ host: 'box', path: 'README.md' }, context)
    expect(result.isError).toBeFalsy()
    const details = result.details as { type: string; size: number; permissions: string }
    expect(details.type).toMatch(/file/i)
    expect(details.size).toBeGreaterThan(0)
    expect(details.permissions.length).toBeGreaterThan(0)
  })

  it('identifies a directory', async () => {
    const result = await remoteStat.handler({ host: 'box', path: 'src' }, context)
    expect((result.details as { type: string }).type).toMatch(/directory/i)
  })
})

describe('remote_find inside the sandbox', () => {
  it('finds files and reports root-relative paths', async () => {
    const result = await remoteFind.handler({ host: 'box' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('README.md')
    expect(result.text).toContain('src/nested/deep.txt')
    expect(result.text).not.toContain(root)
  })

  it('applies -maxdepth and -type inside the namespace', async () => {
    const result = await remoteFind.handler(
      { host: 'box', type: 'directory', maxDepth: 1 },
      context,
    )
    expect(result.text).toContain('src')
    expect(result.text).not.toContain('deep.txt')
  })
})

describe('remote_grep inside the sandbox', () => {
  it('searches contents and reports root-relative paths', async () => {
    const result = await remoteGrep.handler({ host: 'box', pattern: 'needle' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('README.md')
    expect(result.text).not.toContain(root)
  })

  it('reports no matches as a normal result', async () => {
    const result = await remoteGrep.handler(
      { host: 'box', pattern: 'zzz-definitely-absent' },
      context,
    )
    expect(result.isError).toBeFalsy()
    expect(result.text).toMatch(/no match/i)
  })
})

describe('remote_read inside the sandbox', () => {
  it('runs sed with a line range', async () => {
    // sed is not in the probe's tool list, so this is the only test proving it is
    // reachable inside the sandbox at all.
    const result = await remoteRead.handler({ host: 'box', path: 'logs/app.log' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('line one')
    expect(result.text).toContain('line five')
  })

  it('honours offset and limit', async () => {
    const result = await remoteRead.handler(
      { host: 'box', path: 'logs/app.log', offset: 2, limit: 2 },
      context,
    )
    expect(result.text).toContain('line two')
    expect(result.text).toContain('line three')
    expect(result.text).not.toContain('line five')
  })

  it('refuses a directory', async () => {
    const result = await remoteRead.handler({ host: 'box', path: 'src' }, context)
    expect(result.isError).toBe(true)
  })
})

describe('containment holds through the tools, inside the sandbox', () => {
  // The sharpest case (ADR-012 finding 3): /etc must be bound for the toolchain
  // to run, so a symlink to it resolves inside the sandbox. bwrap does not stop
  // this; the tools must.
  beforeEach(async () => {
    await symlink('/etc/hostname', join(root, 'escape-file'))
    await symlink('/etc', join(root, 'escape-dir'))
  })

  it('remote_ls refuses a symlinked directory leaving the root', async () => {
    const result = await remoteLs.handler({ host: 'box', path: 'escape-dir' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('remote_read refuses a symlinked file leaving the root', async () => {
    const result = await remoteRead.handler({ host: 'box', path: 'escape-file' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('remote_stat refuses a symlink leaving the root', async () => {
    const result = await remoteStat.handler({ host: 'box', path: 'escape-file' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('remote_grep refuses a search path leaving the root', async () => {
    const result = await remoteGrep.handler(
      { host: 'box', pattern: 'root', path: 'escape-dir' },
      context,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('remote_find refuses a search path leaving the root', async () => {
    const result = await remoteFind.handler({ host: 'box', path: 'escape-dir' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('every tool refuses lexical traversal', async () => {
    const outcomes = await Promise.all([
      remoteLs.handler({ host: 'box', path: '../..' }, context),
      remoteStat.handler({ host: 'box', path: '../../etc/passwd' }, context),
      remoteFind.handler({ host: 'box', path: '..' }, context),
      remoteGrep.handler({ host: 'box', pattern: 'x', path: '../..' }, context),
      remoteRead.handler({ host: 'box', path: '../../etc/passwd' }, context),
    ])
    expect(outcomes.map((outcome) => outcome.isError)).toEqual([true, true, true, true, true])
  })

  it('does not follow a contained symlink out of the root by accident', async () => {
    // A symlink that stays inside must still work, or containment has been
    // implemented by refusing all symlinks rather than by resolving them.
    await symlink(join(root, 'README.md'), join(root, 'inside-link'))
    const result = await remoteRead.handler({ host: 'box', path: 'inside-link' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('needle here')
  })
})
