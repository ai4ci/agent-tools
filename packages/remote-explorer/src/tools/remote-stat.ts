import { AgentToolsError } from '@agent-tools/core'
import { Type } from 'typebox'
import { type ToolDefinition, type ToolResult, toolError } from '../tool.js'
import { relativiseToRoot, resolveTarget } from './shared.js'

/**
 * Field separator for `stat -c`. A tab is safe because none of the requested
 * fields can contain one.
 */
const STAT_FORMAT = '%F\t%s\t%Y\t%A\t%U\t%G'

export interface StatDetails {
  readonly path: string
  readonly type: string
  readonly size: number
  readonly modified: string
  readonly permissions: string
  readonly owner: string
  readonly group: string
}

/**
 * `stat -c` is used rather than parsing `ls -l`.
 *
 * Portability is not a concern here in the way it first appears: bwrap is
 * Linux-only, so every host this can reach is Linux, and both GNU coreutils and
 * BusyBox support `stat -c` with these specifiers. A BSD host could never have
 * passed the probe.
 */
export function parseStatOutput(stdout: string, path: string): StatDetails {
  const [type, size, mtime, permissions, owner, group] = stdout.trim().split('\t')

  if (type === undefined || size === undefined || mtime === undefined) {
    throw new AgentToolsError('REMOTE_COMMAND_FAILED', 'Could not interpret stat output.')
  }

  const epoch = Number.parseInt(mtime, 10)

  return {
    path,
    type,
    size: Number.parseInt(size, 10),
    modified: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : 'unknown',
    permissions: permissions ?? '',
    owner: owner ?? '',
    group: group ?? '',
  }
}

const parameters = Type.Object({
  host: Type.String({ description: 'Alias of a configured host, as reported by remote_hosts.' }),
  path: Type.String({ description: "Path to inspect, relative to the host's root." }),
})

export const remoteStat: ToolDefinition<typeof parameters> = {
  name: 'remote_stat',
  label: 'Remote file metadata',
  description:
    'Report the type, size, modification time, permissions and ownership of a path on a ' +
    "configured remote host. Paths are relative to the host's root and paths outside it " +
    'are refused.',
  parameters,

  async handler({ host, path }, context): Promise<ToolResult> {
    try {
      const session = await context.session(host)
      const target = await resolveTarget(session, path)

      const result = await session.ops.exec(['stat', '-c', STAT_FORMAT, '--', target])

      if (result.exitCode !== 0) {
        throw new AgentToolsError(
          'REMOTE_COMMAND_FAILED',
          `Could not stat ${JSON.stringify(path)} on host "${host}".`,
          { remedy: result.stderr.trim() || 'Check that the path exists.' },
        )
      }

      const relative = relativiseToRoot(session.root, target)
      const details = parseStatOutput(result.stdout, relative)

      const text = [
        `${relative}`,
        `  type:        ${details.type}`,
        `  size:        ${details.size} bytes`,
        `  modified:    ${details.modified}`,
        `  permissions: ${details.permissions}`,
        `  owner:       ${details.owner}:${details.group}`,
      ].join('\n')

      return { text, details }
    } catch (error) {
      return toolError(error)
    }
  },
}
