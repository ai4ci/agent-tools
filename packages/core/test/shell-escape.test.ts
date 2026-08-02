import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentToolsError, shellJoin, shellQuote } from '@agent-tools/core'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

/**
 * Test tier 2 (ADR-011) — escaper round-trip.
 *
 * SSH hands a single string to the remote login shell, so every argv we build has
 * to survive being flattened and re-split by that shell. TestRemoteOps executes
 * argv directly and never involves a shell, so it cannot catch a mistake here;
 * this harness is the only thing that does.
 *
 * The round trip runs the escaped command through `bash -c` against `printf`,
 * which writes each argument NUL-separated, and asserts the arguments come back
 * byte-identical. `printf` is used rather than a helper script because its
 * argument handling is unambiguous: the format string is consumed first, so
 * subsequent arguments are never parsed as options.
 */
async function roundTrip(args: string[]): Promise<string[]> {
  const command = shellJoin(['printf', '%s\\0', ...args])
  const { stdout } = await execFileAsync('bash', ['-c', command], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  const parts = stdout.split('\0')
  // printf emits a trailing NUL after the final argument.
  parts.pop()
  return parts
}

describe('shellQuote', () => {
  it('quotes a simple word', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('quotes an empty string to something the shell keeps as an argument', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('never emits an unquoted metacharacter', () => {
    const quoted = shellQuote('a; rm -rf /')
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
  })
})

describe('shellJoin', () => {
  it('separates arguments with a single space', () => {
    expect(shellJoin(['a', 'b'])).toBe("'a' 'b'")
  })

  it('rejects an empty argv rather than producing an empty command', () => {
    expect(() => shellJoin([])).toThrow(AgentToolsError)
    expect(() => shellJoin([])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('rejects a NUL byte rather than silently truncating the argument', () => {
    expect(() => shellQuote('a\0b')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})

describe('round trip through bash', () => {
  const cases: Array<[name: string, args: string[]]> = [
    ['plain words', ['alpha', 'beta']],
    ['empty argument', ['', 'after']],
    ['spaces', ['two words', ' leading', 'trailing ']],
    ['single quotes', ["it's", "''", "a'b'c"]],
    ['double quotes', ['say "hi"', '"']],
    ['dollar and variables', ['$HOME', '${HOME}', '$(whoami)', '$']],
    ['backticks', ['`whoami`', 'a`b']],
    ['backslashes', ['a\\b', '\\', '\\\\', 'a\\\\b']],
    ['newlines and tabs', ['line1\nline2', 'a\tb', '\n']],
    ['globs', ['*', '?', '[a-z]', '**/*.ts', '~', '~/x']],
    ['leading dashes', ['-rf', '--force', '-']],
    ['shell operators', ['a; rm -rf /', 'a && b', 'a || b', 'a | b', 'a > b', 'a & b']],
    ['redirection and subshells', ['<(cat)', '2>&1', '$((1+1))']],
    ['semicolons and hashes', ['a;b', '#comment', 'a #b']],
    ['unicode', ['héllo', '日本語', '🙂', 'é']],
    ['exclamation for history expansion', ['!', '!!', 'a!b']],
    ['null-adjacent control characters', ['\r', '\v\f', '']],
    ['long argument', ['x'.repeat(4096)]],
  ]

  for (const [name, args] of cases) {
    it(`preserves ${name}`, async () => {
      await expect(roundTrip(args)).resolves.toEqual(args)
    })
  }

  it('does not execute an injected command', async () => {
    const marker = 'INJECTION-CANARY'
    const result = await roundTrip([`x; echo ${marker}`])
    expect(result).toEqual([`x; echo ${marker}`])
    expect(result.join('')).not.toBe(marker)
  })

  it('does not expand a variable that exists in the environment', async () => {
    const result = await roundTrip(['$PATH'])
    expect(result).toEqual(['$PATH'])
  })
})
