import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestRemoteOps, type TestRemoteOps } from '@agent-tools/test-support'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Test tier 1 (ADR-011) — TestRemoteOps.
 *
 * TestRemoteOps is the substitute for a real host: it receives the same argv an
 * SSHRemoteOps would, and executes it locally against a temporary root using the
 * real grep/find/rg binaries. That is the point of putting the seam at exec(argv)
 * rather than at ls()/grep() — the fake never reimplements tool behaviour, so
 * these tests are about real output.
 *
 * These tests cover the fake itself. If the fake is wrong, every tier 1 test
 * built on it is worthless.
 */

const instances: TestRemoteOps[] = []

async function makeOps(): Promise<TestRemoteOps> {
  const ops = await createTestRemoteOps()
  instances.push(ops)
  return ops
}

afterEach(async () => {
  while (instances.length > 0) {
    const ops = instances.pop()
    await ops?.close()
  }
})

describe('createTestRemoteOps', () => {
  it('exposes a canonical absolute root', async () => {
    const ops = await makeOps()
    const root = await ops.root()
    expect(root.startsWith('/')).toBe(true)
    // Must be canonical: /tmp is a symlink on some systems, and a non-canonical
    // root would make containment comparisons wrong in a way only visible there.
    expect(root).not.toContain('..')
  })

  it('creates the root directory on disk', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['test', '-d', await ops.root()])
    expect(result.exitCode).toBe(0)
  })

  it('removes the root on close', async () => {
    const ops = await createTestRemoteOps()
    const root = await ops.root()
    await ops.close()
    const { existsSync } = await import('node:fs')
    expect(existsSync(root)).toBe(false)
  })

  it('tolerates being closed twice', async () => {
    const ops = await createTestRemoteOps()
    await ops.close()
    await expect(ops.close()).resolves.toBeUndefined()
  })
})

describe('exec', () => {
  it('returns stdout and a zero exit code', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['printf', 'hello'])
    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutTruncated).toBe(false)
  })

  it('captures stderr without conflating it with stdout', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['sh', '-c', 'printf out; printf err >&2'])
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
  })

  it('reports a non-zero exit code rather than throwing', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['false'])
    expect(result.exitCode).toBe(1)
  })

  it('passes arguments literally, with no shell interpretation', async () => {
    const ops = await makeOps()
    // The whole reason the seam is at argv: a value like this must never be
    // interpreted. SSHRemoteOps achieves that by escaping; this achieves it by
    // never involving a shell. Both must agree on the observable result.
    const result = await ops.exec(['printf', '%s', '$HOME; echo pwned `id`'])
    expect(result.stdout).toBe('$HOME; echo pwned `id`')
  })

  it('does not glob its arguments', async () => {
    const ops = await makeOps()
    await writeFile(join(await ops.root(), 'a.txt'), 'x')
    const result = await ops.exec(['printf', '%s', '*.txt'])
    expect(result.stdout).toBe('*.txt')
  })

  it('runs with the root as the working directory', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['pwd'])
    expect(result.stdout.trim()).toBe(await ops.root())
  })

  it('rejects an empty argv', async () => {
    const ops = await makeOps()
    await expect(ops.exec([])).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })

  it('maps a missing command to a typed error', async () => {
    const ops = await makeOps()
    await expect(ops.exec(['definitely-not-a-real-command-xyz'])).rejects.toThrow(
      expect.objectContaining({ code: 'REMOTE_COMMAND_FAILED' }),
    )
  })

  it('times out a long-running command', async () => {
    const ops = await makeOps()
    await expect(ops.exec(['sleep', '30'], { timeoutMs: 250 })).rejects.toThrow(
      expect.objectContaining({ code: 'TIMEOUT' }),
    )
  })

  it('honours an abort signal', async () => {
    const ops = await makeOps()
    const controller = new AbortController()
    const pending = ops.exec(['sleep', '30'], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('truncates stdout at the byte cap and flags it', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['printf', '%s', 'x'.repeat(5000)], {
      maxOutputBytes: 1000,
    })
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1000)
  })

  it('does not flag truncation when output fits', async () => {
    const ops = await makeOps()
    const result = await ops.exec(['printf', '%s', 'short'], { maxOutputBytes: 1000 })
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stdout).toBe('short')
  })
})

describe('capabilities', () => {
  it('reports the search tools present on this machine', async () => {
    const ops = await makeOps()
    const capabilities = await ops.capabilities()
    // grep and find are POSIX and present anywhere these tests can run at all.
    expect(capabilities.tools.has('grep')).toBe(true)
    expect(capabilities.tools.has('find')).toBe(true)
  })

  it('allows capabilities to be overridden so a thinner host can be simulated', async () => {
    // ENV-004: tier 1 otherwise inherits whatever the developer happens to have
    // installed, so a fallback path would never be exercised locally.
    const ops = await createTestRemoteOps({ tools: ['grep', 'find'] })
    instances.push(ops)
    const capabilities = await ops.capabilities()
    expect(capabilities.tools.has('rg')).toBe(false)
    expect(capabilities.tools.has('grep')).toBe(true)
  })

  it('reports no sandbox, since nothing here is sandboxed', async () => {
    const ops = await makeOps()
    expect((await ops.capabilities()).hasSandbox).toBe(false)
  })
})

describe('fixture helpers', () => {
  it('materialises a file tree under the root', async () => {
    const ops = await makeOps()
    await ops.writeTree({
      'README.md': '# hello\n',
      'src/index.ts': 'export const x = 1\n',
      'src/nested/deep.txt': 'needle\n',
    })

    const found = await ops.exec(['find', '.', '-type', 'f'])
    expect(found.stdout).toContain('./README.md')
    expect(found.stdout).toContain('./src/index.ts')
    expect(found.stdout).toContain('./src/nested/deep.txt')
  })

  it('produces a tree that real grep can search', async () => {
    const ops = await makeOps()
    await ops.writeTree({ 'a/b.txt': 'alpha needle omega\n' })
    const result = await ops.exec(['grep', '-r', 'needle', '.'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('needle')
  })

  it('creates parent directories for nested fixture paths', async () => {
    const ops = await makeOps()
    await ops.writeTree({ 'x/y/z/file.txt': 'content' })
    await expect(readFile(join(await ops.root(), 'x/y/z/file.txt'), 'utf8')).resolves.toBe(
      'content',
    )
  })
})
