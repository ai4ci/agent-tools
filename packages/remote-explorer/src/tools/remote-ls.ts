import { AgentToolsError, canonicaliseWithinRoot } from '@agent-tools/core'
import { Type } from 'typebox'
import { type HostSession, type ToolDefinition, type ToolResult, toolError } from '../tool.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export type EntryType = 'directory' | 'file' | 'symlink'

export interface DirectoryEntry {
  readonly name: string
  readonly type: EntryType
}

/**
 * Parse `ls -1Ap` output.
 *
 * `-1` is one entry per line, `-A` includes dotfiles but not `.`/`..`, and `-p`
 * appends `/` to directories — which is how the type is determined without a
 * second round trip per entry.
 *
 * Known limitation: a filename containing a newline is split across lines and
 * misreported. `find -print0` would avoid it but needs GNU `-printf` to carry the
 * type in the same pass, and the probe does not yet distinguish GNU from BusyBox
 * (ENV-004). Recorded in design/active-issues.md as EXP-001.
 */
export function parseLsOutput(stdout: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = []

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue

    if (line.endsWith('/')) {
      entries.push({ name: line.slice(0, -1), type: 'directory' })
    } else if (line.endsWith('@')) {
      // Only emitted with -F; harmless to accept in case a host aliases ls.
      entries.push({ name: line.slice(0, -1), type: 'symlink' })
    } else {
      entries.push({ name: line, type: 'file' })
    }
  }

  return entries
}

async function resolveTarget(session: HostSession, path: string | undefined): Promise<string> {
  return canonicaliseWithinRoot(
    (argv) => session.ops.exec(argv),
    session.root,
    path ?? '.',
    session.capabilities.tools.has('realpath'),
  )
}

const remoteLsParameters = Type.Object({
  host: Type.String({
    description: 'Alias of a configured host, as reported by remote_hosts.',
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory to list, relative to the host's root. Omit to list the root itself.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum entries to return (default ${DEFAULT_LIMIT}).`,
    }),
  ),
})

export const remoteLs: ToolDefinition<typeof remoteLsParameters> = {
  name: 'remote_ls',
  label: 'Remote list directory',
  description:
    'List the contents of a directory on a configured remote host. Paths are relative to ' +
    "the host's root directory, and paths outside it are refused. Hidden entries are " +
    'included. Use remote_hosts to discover valid host aliases.',

  parameters: remoteLsParameters,

  async handler({ host, path, limit }, context): Promise<ToolResult> {
    try {
      const session = await context.session(host)
      const target = await resolveTarget(session, path)
      const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)

      const result = await session.ops.exec(['ls', '-1Ap', '--', target])

      if (result.exitCode !== 0) {
        throw new AgentToolsError(
          'REMOTE_COMMAND_FAILED',
          `Could not list ${JSON.stringify(path ?? '.')} on host "${host}".`,
          { remedy: result.stderr.trim() || 'Check that the path exists and is a directory.' },
        )
      }

      const all = parseLsOutput(result.stdout)
      const entries = all.slice(0, cap)
      const truncated = all.length > entries.length

      const rendered = entries
        .map((entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name))
        .join('\n')

      const header = `${target} — ${all.length} entr${all.length === 1 ? 'y' : 'ies'}`
      // Truncation is always stated, never silent (ADR-009).
      const note = truncated
        ? `\n\n[truncated: showing ${entries.length} of ${all.length}; raise "limit" or list a subdirectory]`
        : ''

      return {
        text: `${header}\n${rendered}${note}`,
        details: { root: session.root, path: target, entries, truncated, total: all.length },
      }
    } catch (error) {
      return toolError(error)
    }
  },
}
