import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicaliseWithinRoot } from '@agent-tools/core'
import { createLocalSandboxRemoteOps, type LocalSandboxRemoteOps } from '@agent-tools/test-support'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Test tier 3 (ADR-011) — real bwrap, no SSH.
 *
 * These are the properties ADR-006 and ADR-012 claim. They are asserted against a
 * real sandbox built by the production code path, not by the prototype script:
 * the prototype established what is true, this keeps it true.
 *
 * Skipped unless tier 3 is enabled (see vitest.config.ts), because a machine
 * without a working bwrap should not report failures it cannot fix.
 */

let ops: LocalSandboxRemoteOps
let root: string

beforeEach(async () => {
  ops = await createLocalSandboxRemoteOps()
  root = await ops.root()
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'sub', 'file.txt'), 'needle in the haystack\n')
})

afterEach(async () => {
  await ops?.close()
})

describe('probe', () => {
  it('confirms the sandbox is available, or the host would have been refused', () => {
    expect(ops.probe.sandboxAvailable).toBe(true)
  })

  it('discovers a non-empty usr layout', () => {
    expect(ops.probe.layout.entries.length).toBeGreaterThan(0)
  })

  it('reports the search tools it found', () => {
    expect(ops.probe.tools.has('grep')).toBe(true)
  })

  it('resolves the root to a canonical absolute path', () => {
    expect(ops.probe.root).toBe(root)
  })
})

describe('the toolchain runs inside the sandbox', () => {
  for (const tool of ['grep', 'find', 'ls', 'cat']) {
    it(`${tool} executes`, async () => {
      const result = await ops.exec([tool, '--version'])
      expect(result.exitCode).toBe(0)
    })
  }

  it('grep returns matches from the root', async () => {
    const result = await ops.exec(['grep', '-r', 'needle', '.'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('needle')
  })
})

describe('the root is read-only', () => {
  it('refuses a write to an existing file', async () => {
    const result = await ops.exec(['sh', '-c', 'echo mutated > ./sub/file.txt'])
    expect(result.exitCode).not.toBe(0)
  })

  it('leaves the file unchanged on the host', async () => {
    await ops.exec(['sh', '-c', 'echo mutated > ./sub/file.txt'])
    const check = await ops.execUnsandboxed(['cat', join(root, 'sub', 'file.txt')])
    expect(check.stdout).toBe('needle in the haystack\n')
  })

  it('refuses creation of a new file', async () => {
    const result = await ops.exec(['sh', '-c', 'touch ./newfile'])
    expect(result.exitCode).not.toBe(0)
  })

  it('refuses deletion', async () => {
    const result = await ops.exec(['rm', '-f', './sub/file.txt'])
    expect(result.exitCode).not.toBe(0)
  })
})

describe('isolation', () => {
  it('blocks outbound network access', async () => {
    const result = await ops.exec(['sh', '-c', 'cat < /dev/tcp/1.1.1.1/53'])
    expect(result.exitCode).not.toBe(0)
  })

  it('hides /home', async () => {
    const result = await ops.exec(['ls', '/home'])
    expect(result.exitCode).not.toBe(0)
  })

  it('gives /tmp a private tmpfs that does not leak to the host', async () => {
    const result = await ops.exec(['sh', '-c', 'echo x > /tmp/canary && cat /tmp/canary'])
    expect(result.exitCode).toBe(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync('/tmp/canary')).toBe(false)
  })

  it('works when the root itself lives under /tmp', async () => {
    // ADR-012 finding 1: the tmpfs must be established before the root bind, or
    // this exact case mounts over the root. Every temp root exercises it.
    expect(root.startsWith('/tmp')).toBe(true)
    const result = await ops.exec(['ls', '.'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('sub')
  })
})

describe('symlink containment (ADR-012 finding 3)', () => {
  it('bwrap alone does not prevent a symlink into a bound path', async () => {
    // Recorded deliberately. /etc must be bound or nothing executes, so this link
    // resolves and bwrap has no reason to stop it. If this ever starts failing,
    // the sandbox got stricter and the extra layer below may be revisited — but
    // it must not be removed on the strength of one host's behaviour.
    await symlink('/etc/hostname', join(root, 'link-to-etc'))
    const result = await ops.exec(['cat', './link-to-etc'])
    expect(result.exitCode).toBe(0)
  })

  it('canonicalisation rejects a symlink that leaves the root', async () => {
    // The layer that actually closes the gap.
    await symlink('/etc/hostname', join(root, 'link-to-etc'))
    const exec = (argv: readonly string[]) => ops.exec(argv)

    await expect(
      canonicaliseWithinRoot(exec, root, 'link-to-etc', ops.probe.tools.has('realpath')),
    ).rejects.toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }))
  })

  it('canonicalisation accepts a symlink that stays inside the root', async () => {
    await symlink(join(root, 'sub', 'file.txt'), join(root, 'inside-link'))
    const exec = (argv: readonly string[]) => ops.exec(argv)

    const resolved = await canonicaliseWithinRoot(
      exec,
      root,
      'inside-link',
      ops.probe.tools.has('realpath'),
    )
    expect(resolved).toBe(join(root, 'sub', 'file.txt'))
  })

  it('canonicalisation accepts an ordinary path', async () => {
    const exec = (argv: readonly string[]) => ops.exec(argv)
    const resolved = await canonicaliseWithinRoot(
      exec,
      root,
      'sub/file.txt',
      ops.probe.tools.has('realpath'),
    )
    expect(resolved).toBe(join(root, 'sub', 'file.txt'))
  })

  it('canonicalisation still rejects lexical traversal before any round trip', async () => {
    const exec = (argv: readonly string[]) => ops.exec(argv)
    await expect(canonicaliseWithinRoot(exec, root, '../../etc/passwd', true)).rejects.toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
    )
  })

  it('works without realpath(1), for minimal hosts', async () => {
    await symlink('/etc/hostname', join(root, 'link-to-etc'))
    const exec = (argv: readonly string[]) => ops.exec(argv)

    await expect(canonicaliseWithinRoot(exec, root, 'link-to-etc', false)).rejects.toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
    )
  })
})
