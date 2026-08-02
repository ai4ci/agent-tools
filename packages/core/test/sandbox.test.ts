import { buildSandboxCommand, type UsrLayout } from '@agent-tools/core'
import { describe, expect, it } from 'vitest'

/**
 * Sandbox command construction (ADR-006, ADR-012).
 *
 * Tier 1 pins the argv. Whether the resulting sandbox actually holds is tier 3,
 * which runs real bwrap — but the properties below are the ones that were found
 * empirically to matter, so they are worth asserting cheaply and directly.
 */

const SPLIT_USR: UsrLayout = {
  entries: [
    { path: '/usr', kind: 'directory' },
    { path: '/bin', kind: 'directory' },
    { path: '/lib', kind: 'directory' },
    { path: '/etc', kind: 'directory' },
  ],
}

const MERGED_USR: UsrLayout = {
  entries: [
    { path: '/usr', kind: 'directory' },
    { path: '/bin', kind: 'symlink', target: 'usr/bin' },
    { path: '/lib', kind: 'symlink', target: 'usr/lib' },
    { path: '/etc', kind: 'directory' },
  ],
}

const ROOT = '/srv/app'

function build(overrides: Partial<Parameters<typeof buildSandboxCommand>[0]> = {}): string[] {
  return buildSandboxCommand({
    root: ROOT,
    argv: ['grep', '-r', 'needle', '.'],
    layout: SPLIT_USR,
    ...overrides,
  })
}

describe('buildSandboxCommand', () => {
  it('invokes bwrap', () => {
    expect(build()[0]).toBe('bwrap')
  })

  it('passes the payload argv after a -- separator', () => {
    const argv = build()
    const separator = argv.lastIndexOf('--')
    expect(argv.slice(separator + 1)).toEqual(['grep', '-r', 'needle', '.'])
  })

  it('establishes the tmpfs before binding the root', () => {
    // ADR-012 finding 1. bwrap applies operations in order, so a tmpfs on /tmp
    // placed after the root bind mounts straight over a root that lives under
    // /tmp, and the root disappears. Production cannot assume the root is
    // elsewhere.
    const argv = build()
    const tmpfsAt = argv.indexOf('--tmpfs')
    const rootBindAt = argv.indexOf(ROOT)
    expect(tmpfsAt).toBeGreaterThanOrEqual(0)
    expect(tmpfsAt).toBeLessThan(rootBindAt)
  })

  it('works when the root is itself under /tmp', () => {
    const argv = build({ root: '/tmp/work/root' })
    expect(argv.indexOf('--tmpfs')).toBeLessThan(argv.indexOf('/tmp/work/root'))
  })

  it('binds the exploration root read-only', () => {
    const argv = build()
    const at = argv.indexOf(ROOT)
    expect(argv[at - 1]).toBe('--ro-bind')
    expect(argv[at + 1]).toBe(ROOT)
  })

  it('never emits a writable bind', () => {
    // The invariant that matters most: any --bind at all would make the root
    // mutable and silently void ADR-006.
    const argv = build()
    expect(argv).not.toContain('--bind')
    expect(argv).not.toContain('--bind-try')
    expect(argv).not.toContain('--dev-bind')
  })

  it('unshares the network', () => {
    expect(build()).toContain('--unshare-net')
  })

  it('unshares pids and dies with the parent', () => {
    const argv = build()
    expect(argv).toContain('--unshare-pid')
    expect(argv).toContain('--die-with-parent')
  })

  it('runs with the root as the working directory', () => {
    const argv = build()
    expect(argv[argv.indexOf('--chdir') + 1]).toBe(ROOT)
  })

  describe('usr layout', () => {
    it('binds real directories read-only on a split-usr host', () => {
      const argv = build({ layout: SPLIT_USR })
      const at = argv.indexOf('/bin')
      expect(argv[at - 1]).toBe('--ro-bind')
      expect(argv[at + 1]).toBe('/bin')
    })

    it('recreates symlinks on a merged-usr host', () => {
      // ADR-012 finding 2. A --ro-bind of a symlinked /bin is wrong on a
      // merged-usr host; the link must be recreated instead.
      const argv = build({ layout: MERGED_USR })
      const at = argv.indexOf('--symlink')
      expect(argv[at + 1]).toBe('usr/bin')
      expect(argv[at + 2]).toBe('/bin')
      expect(argv.filter((entry) => entry === '--symlink')).toHaveLength(2)
    })

    it('rejects a symlink entry with no target', () => {
      expect(() => build({ layout: { entries: [{ path: '/bin', kind: 'symlink' }] } })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    })
  })

  describe('rejections', () => {
    it('rejects an empty payload argv', () => {
      expect(() => build({ argv: [] })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    })

    it('rejects a relative root', () => {
      expect(() => build({ root: 'relative' })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    })

    it('rejects an empty layout, which would produce a sandbox with no toolchain', () => {
      expect(() => build({ layout: { entries: [] } })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    })
  })
})
