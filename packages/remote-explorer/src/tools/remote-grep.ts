import { AgentToolsError } from '@agent-tools/core'
import { Type } from 'typebox'
import { type HostSession, type ToolDefinition, type ToolResult, toolError } from '../tool.js'
import { outputLines, relativiseToRoot, resolveTarget, truncationNote } from './shared.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

const parameters = Type.Object({
  host: Type.String({ description: 'Alias of a configured host, as reported by remote_hosts.' }),
  pattern: Type.String({
    minLength: 1,
    description: 'Regular expression to search for in file contents.',
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Directory or file to search, relative to the host's root. Defaults to the root.",
    }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Match case-insensitively.' })),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum matching lines to return (default ${DEFAULT_LIMIT}).`,
    }),
  ),
})

/**
 * Build the search argv.
 *
 * Prefers ripgrep, which is faster and skips binary files by default, and falls
 * back to POSIX grep. Both receive the pattern via an explicit `-e`, so a pattern
 * beginning with `-` is a search term rather than an option — the `--` separator
 * alone would not achieve that, since it only protects the paths that follow.
 */
export function buildSearchArgv(options: {
  readonly session: HostSession
  readonly pattern: string
  readonly target: string
  readonly ignoreCase: boolean
  readonly limit: number
}): string[] {
  const { session, pattern, target, ignoreCase, limit } = options

  if (session.capabilities.tools.has('rg')) {
    const argv = ['rg', '--line-number', '--no-heading', '--color', 'never']
    // Cap at the remote end so a huge result set is not transferred only to be
    // discarded locally (ADR-009).
    argv.push('--max-count', String(limit))
    if (ignoreCase) argv.push('--ignore-case')
    argv.push('-e', pattern, '--', target)
    return argv
  }

  const argv = ['grep', '-rn']
  if (ignoreCase) argv.push('-i')
  argv.push('-m', String(limit))
  argv.push('-e', pattern, '--', target)
  return argv
}

export const remoteGrep: ToolDefinition<typeof parameters> = {
  name: 'remote_grep',
  label: 'Remote content search',
  description:
    'Search file contents on a configured remote host and return matching lines with their ' +
    "file and line number. Paths are relative to the host's root. Uses ripgrep where " +
    'available. Use remote_find to locate files by name instead.',
  parameters,

  async handler({ host, pattern, path, ignoreCase, limit }, context): Promise<ToolResult> {
    try {
      const session = await context.session(host)
      const target = await resolveTarget(session, path)
      const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)

      const result = await session.ops.exec(
        buildSearchArgv({
          session,
          pattern,
          target,
          ignoreCase: ignoreCase ?? false,
          limit: cap,
        }),
      )

      // Exit 1 means "no matches", which is an answer rather than a failure.
      // Anything above that is a real error — a bad regex, or an unreadable path.
      if (result.exitCode > 1) {
        throw new AgentToolsError('REMOTE_COMMAND_FAILED', `Search failed on host "${host}".`, {
          remedy: result.stderr.trim() || 'Check the pattern and the path.',
        })
      }

      const lines = outputLines(result.stdout).map((line) =>
        // Output is <path>:<line>:<text>; only the path prefix should be rewritten,
        // so the replacement is anchored to the start of the line.
        line.startsWith(session.root) ? relativiseToRoot(session.root, line) : line,
      )

      if (lines.length === 0) {
        return {
          text: `No matches for ${JSON.stringify(pattern)}.`,
          details: { matches: [], truncated: false, total: 0 },
        }
      }

      const matches = lines.slice(0, cap)
      const truncated = lines.length > matches.length || result.stdoutTruncated
      const note = truncated
        ? truncationNote(
            matches.length,
            lines.length,
            'narrow the pattern or search a subdirectory',
          )
        : ''

      return {
        text: `${matches.join('\n')}${note}`,
        details: { matches, truncated, total: lines.length },
      }
    } catch (error) {
      return toolError(error)
    }
  },
}
