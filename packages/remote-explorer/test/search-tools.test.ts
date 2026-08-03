import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseConfig } from '@agent-tools/core'
import {
  createToolContext,
  remoteFind,
  remoteGrep,
  remoteRead,
  remoteStat,
  type ToolContext,
} from '@agent-tools/remote-explorer'
import { createTestRemoteOps, type TestRemoteOps } from '@agent-tools/test-support'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Search and read tools, tier 1 (ADR-011).
 *
 * Driven against a real fixture tree through the real binaries, so parsing is
 * tested against genuine output. Every tool must enforce containment itself
 * rather than relying on core alone, since each one resolves its own paths.
 */

let ops: TestRemoteOps
let context: ToolContext
let root: string

beforeEach(async () => {
  ops = await createTestRemoteOps({ alias: 'box' })
  root = await ops.root()
  await ops.writeTree({
    'README.md': '# Title\nneedle here\n',
    'src/index.ts': 'export const alpha = 1\nexport const needle = 2\n',
    'src/other.ts': 'export const beta = 3\n',
    'src/nested/deep.txt': 'needle in the deep\n',
    'logs/app.log': 'line one\nline two\nline three\nline four\nline five\n',
    'notes.txt': 'nothing interesting\n',
  })

  const config = parseConfig(
    { version: 1, hosts: { box: { ssh: { target: 'u@box' }, root } } },
    'test',
  )
  context = createToolContext({ config, createOps: () => ops })
})

afterEach(async () => {
  await context?.close()
  await ops?.close()
})

describe('remote_stat', () => {
  it('reports a file with its size and type', async () => {
    const result = await remoteStat.handler({ host: 'box', path: 'notes.txt' }, context)
    expect(result.isError).toBeFalsy()
    const details = result.details as { type: string; size: number }
    expect(details.type).toMatch(/file/i)
    expect(details.size).toBeGreaterThan(0)
  })

  it('reports a directory as such', async () => {
    const result = await remoteStat.handler({ host: 'box', path: 'src' }, context)
    const details = result.details as { type: string }
    expect(details.type).toMatch(/directory/i)
  })

  it('errors on a missing path', async () => {
    const result = await remoteStat.handler({ host: 'box', path: 'nope' }, context)
    expect(result.isError).toBe(true)
  })

  it('refuses a path outside the root', async () => {
    const result = await remoteStat.handler({ host: 'box', path: '../../etc/passwd' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })
})

describe('remote_find', () => {
  it('finds files below the root', async () => {
    const result = await remoteFind.handler({ host: 'box' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('README.md')
    expect(result.text).toContain('src/index.ts')
  })

  it('reports paths relative to the root, not absolute host paths', async () => {
    // Absolute paths leak the host layout into the transcript and are longer for
    // no benefit; the model works in root-relative terms everywhere else.
    const result = await remoteFind.handler({ host: 'box' }, context)
    expect(result.text).not.toContain(root)
  })

  it('filters by name pattern', async () => {
    const result = await remoteFind.handler({ host: 'box', name: '*.ts' }, context)
    expect(result.text).toContain('index.ts')
    expect(result.text).not.toContain('README.md')
  })

  it('filters to directories only', async () => {
    const result = await remoteFind.handler({ host: 'box', type: 'directory' }, context)
    expect(result.text).toContain('src')
    expect(result.text).not.toContain('README.md')
  })

  it('honours a maximum depth', async () => {
    const result = await remoteFind.handler({ host: 'box', maxDepth: 1 }, context)
    expect(result.text).toContain('README.md')
    expect(result.text).not.toContain('deep.txt')
  })

  it('searches within a subdirectory', async () => {
    const result = await remoteFind.handler({ host: 'box', path: 'src' }, context)
    expect(result.text).toContain('index.ts')
    expect(result.text).not.toContain('notes.txt')
  })

  it('says so plainly when nothing matches', async () => {
    const result = await remoteFind.handler({ host: 'box', name: '*.nonexistent' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toMatch(/no match|nothing/i)
  })

  it('states truncation explicitly', async () => {
    const result = await remoteFind.handler({ host: 'box', limit: 2 }, context)
    expect(result.text).toMatch(/truncat/i)
  })

  it('refuses a path outside the root', async () => {
    const result = await remoteFind.handler({ host: 'box', path: '../..' }, context)
    expect(result.isError).toBe(true)
  })

  it('rejects a name pattern that is really a find expression', async () => {
    // A value like this must be an argument, never syntax. find would otherwise
    // accept -delete as a further predicate.
    const result = await remoteFind.handler({ host: 'box', name: '-delete' }, context)
    // Either rejected outright or treated as a literal pattern matching nothing;
    // what must not happen is the file tree being modified.
    const after = await remoteFind.handler({ host: 'box' }, context)
    expect(after.text).toContain('README.md')
    expect(result.isError === true || after.text.includes('README.md')).toBe(true)
  })
})

describe('remote_grep', () => {
  it('finds matching lines with their file and line number', async () => {
    const result = await remoteGrep.handler({ host: 'box', pattern: 'needle' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('README.md')
    expect(result.text).toMatch(/needle/)
  })

  it('reports root-relative paths', async () => {
    const result = await remoteGrep.handler({ host: 'box', pattern: 'needle' }, context)
    expect(result.text).not.toContain(root)
  })

  it('reports no matches as a normal result, not an error', async () => {
    // grep exits 1 for "no matches", which is an answer.
    const result = await remoteGrep.handler({ host: 'box', pattern: 'zzz-not-present' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toMatch(/no match/i)
  })

  it('searches only within the given subdirectory', async () => {
    const result = await remoteGrep.handler(
      { host: 'box', pattern: 'needle', path: 'src' },
      context,
    )
    expect(result.text).toContain('index.ts')
    expect(result.text).not.toContain('README.md')
  })

  it('supports case-insensitive search', async () => {
    const result = await remoteGrep.handler(
      { host: 'box', pattern: 'NEEDLE', ignoreCase: true },
      context,
    )
    expect(result.text).toMatch(/needle/i)
    expect(result.text).not.toMatch(/no match/i)
  })

  it('treats the pattern as a pattern, not as shell input', async () => {
    const result = await remoteGrep.handler({ host: 'box', pattern: 'needle; echo pwned' }, context)
    // The pattern is quoted back in the "no matches" message, so asserting the
    // word is absent would be testing the wrong thing. What matters is that the
    // injected command did not run: no output line is the echo's output, and the
    // search legitimately found nothing.
    const details = result.details as { matches: string[] }
    expect(details.matches).toHaveLength(0)
    expect(result.text.split('\n').some((line) => line.trim() === 'pwned')).toBe(false)
  })

  it('does not let a pattern beginning with a dash become a flag', async () => {
    const result = await remoteGrep.handler({ host: 'box', pattern: '-e' }, context)
    // Must be treated as a literal search term or refused; never parsed as an
    // option to the search binary.
    expect(result.isError === true || !result.text.includes('Usage')).toBe(true)
  })

  it('states truncation explicitly', async () => {
    const result = await remoteGrep.handler({ host: 'box', pattern: 'export', limit: 1 }, context)
    expect(result.text).toMatch(/truncat/i)
  })

  it('refuses a path outside the root', async () => {
    const result = await remoteGrep.handler(
      { host: 'box', pattern: 'root', path: '../../etc' },
      context,
    )
    expect(result.isError).toBe(true)
  })

  it('works when the host has no ripgrep, falling back to grep', async () => {
    // ENV-004: without this the fallback is never exercised on a machine that has
    // rg installed.
    const thin = await createTestRemoteOps({ alias: 'thin', tools: ['grep', 'find', 'realpath'] })
    try {
      await thin.writeTree({ 'a.txt': 'needle\n' })
      const config = parseConfig(
        { version: 1, hosts: { thin: { ssh: { target: 'u@t' }, root: await thin.root() } } },
        'test',
      )
      const thinContext = createToolContext({ config, createOps: () => thin })
      const result = await remoteGrep.handler({ host: 'thin', pattern: 'needle' }, thinContext)
      expect(result.isError).toBeFalsy()
      expect(result.text).toContain('a.txt')
    } finally {
      await thin.close()
    }
  })
})

describe('remote_read', () => {
  it('reads a whole small file', async () => {
    const result = await remoteRead.handler({ host: 'box', path: 'notes.txt' }, context)
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('nothing interesting')
  })

  it('reads from an offset', async () => {
    const result = await remoteRead.handler(
      { host: 'box', path: 'logs/app.log', offset: 3 },
      context,
    )
    expect(result.text).toContain('line three')
    expect(result.text).not.toContain('line one')
  })

  it('limits the number of lines', async () => {
    const result = await remoteRead.handler(
      { host: 'box', path: 'logs/app.log', limit: 2 },
      context,
    )
    expect(result.text).toContain('line one')
    expect(result.text).not.toContain('line three')
  })

  it('states truncation when a limit cut the file short', async () => {
    const result = await remoteRead.handler(
      { host: 'box', path: 'logs/app.log', limit: 2 },
      context,
    )
    expect(result.text).toMatch(/truncat/i)
  })

  it('errors on a directory rather than dumping something strange', async () => {
    const result = await remoteRead.handler({ host: 'box', path: 'src' }, context)
    expect(result.isError).toBe(true)
  })

  it('errors on a missing file', async () => {
    const result = await remoteRead.handler({ host: 'box', path: 'nope.txt' }, context)
    expect(result.isError).toBe(true)
  })

  it('refuses a path outside the root', async () => {
    const result = await remoteRead.handler({ host: 'box', path: '../../etc/passwd' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })

  it('refuses a symlink that escapes the root', async () => {
    await symlink('/etc/hostname', join(root, 'escape'))
    const result = await remoteRead.handler({ host: 'box', path: 'escape' }, context)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/root/i)
  })
})
