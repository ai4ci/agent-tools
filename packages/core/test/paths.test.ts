import { resolveWithinRoot } from '@agent-tools/core'
import { describe, expect, it } from 'vitest'

/**
 * Path containment (ADR-007, ADR-011).
 *
 * Lives in core above the RemoteOps seam, so every test tier exercises it rather
 * than only the tiers that involve SSH. Remote paths are always POSIX regardless
 * of what the operator's machine runs, so this must not use platform path
 * semantics.
 *
 * Phase 1 covers lexical containment only. Symlinks that point outside the root
 * cannot be detected without asking the remote host, and are handled in Phase 2.
 */

const ROOT = '/home/deploy/project'

describe('resolveWithinRoot', () => {
  it('resolves a relative path against the root', () => {
    expect(resolveWithinRoot(ROOT, 'src/index.ts')).toBe('/home/deploy/project/src/index.ts')
  })

  it('treats an empty path as the root itself', () => {
    expect(resolveWithinRoot(ROOT, '')).toBe(ROOT)
  })

  it('treats "." as the root itself', () => {
    expect(resolveWithinRoot(ROOT, '.')).toBe(ROOT)
  })

  it('accepts an absolute path that is inside the root', () => {
    expect(resolveWithinRoot(ROOT, '/home/deploy/project/src')).toBe('/home/deploy/project/src')
  })

  it('accepts the root given as an absolute path', () => {
    expect(resolveWithinRoot(ROOT, ROOT)).toBe(ROOT)
  })

  it('normalises redundant separators and segments', () => {
    expect(resolveWithinRoot(ROOT, 'src//lib/./x')).toBe('/home/deploy/project/src/lib/x')
  })

  it('normalises interior traversal that stays inside the root', () => {
    expect(resolveWithinRoot(ROOT, 'src/../lib')).toBe('/home/deploy/project/lib')
  })

  it('strips a trailing separator', () => {
    expect(resolveWithinRoot(ROOT, 'src/')).toBe('/home/deploy/project/src')
  })

  it('uses POSIX semantics regardless of host platform', () => {
    // A backslash is an ordinary filename character on the remote, not a separator.
    expect(resolveWithinRoot(ROOT, 'a\\b')).toBe('/home/deploy/project/a\\b')
  })

  describe('rejections', () => {
    const outside: Array<[name: string, input: string]> = [
      ['parent traversal', '../secrets'],
      ['traversal via an interior segment', 'src/../../secrets'],
      ['traversal to the filesystem root', '../../../../etc/passwd'],
      ['bare parent', '..'],
      ['an unrelated absolute path', '/etc/passwd'],
      ['an absolute path above the root', '/home/deploy'],
    ]

    for (const [name, input] of outside) {
      it(`rejects ${name}`, () => {
        expect(() => resolveWithinRoot(ROOT, input)).toThrow(
          expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
        )
      })
    }

    it('rejects a sibling directory sharing the root as a string prefix', () => {
      // The classic containment bug: '/home/deploy/project-secrets' starts with the
      // root string but is not inside the root.
      expect(() => resolveWithinRoot(ROOT, '/home/deploy/project-secrets')).toThrow(
        expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
      )
    })

    it('rejects a NUL byte', () => {
      expect(() => resolveWithinRoot(ROOT, 'a\0b')).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    })

    it('rejects a relative root, which would make containment meaningless', () => {
      expect(() => resolveWithinRoot('relative/root', 'x')).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    })
  })

  it('names the offending path and the root, so the model can correct itself', () => {
    try {
      resolveWithinRoot(ROOT, '../../etc/passwd')
      expect.unreachable('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('../../etc/passwd')
      expect(message).toContain(ROOT)
    }
  })
})
