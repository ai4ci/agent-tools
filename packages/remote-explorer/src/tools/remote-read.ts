import { AgentToolsError } from '@agent-tools/core'
import { Type } from 'typebox'
import { type ToolDefinition, type ToolResult, toolError } from '../tool.js'
import { outputLines, relativiseToRoot, resolveTarget, truncationNote } from './shared.js'

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 5000

const parameters = Type.Object({
  host: Type.String({ description: 'Alias of a configured host, as reported by remote_hosts.' }),
  path: Type.String({ description: "File to read, relative to the host's root." }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: 'First line to return, counting from 1. Defaults to the start of the file.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum lines to return (default ${DEFAULT_LIMIT}).`,
    }),
  ),
})

export const remoteRead: ToolDefinition<typeof parameters> = {
  name: 'remote_read',
  label: 'Remote read file',
  summary: 'Read lines from a file on a remote host',
  description:
    'Read lines from a file on a configured remote host. Reading is read-only and confined ' +
    "to the host's root. Use offset and limit to page through a large file rather than " +
    'requesting all of it.',
  parameters,

  async handler({ host, path, offset, limit }, context): Promise<ToolResult> {
    try {
      const session = await context.session(host)
      const target = await resolveTarget(session, path)

      const start = offset ?? 1
      const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      // One past the last wanted line, so a full page can be distinguished from a
      // page that happens to end exactly at the file's end.
      const end = start + cap

      // A directory would otherwise be read as though it were a file, producing
      // either an error buried in stderr or, on some systems, binary noise.
      const kind = await session.ops.exec(['test', '-f', target])
      if (kind.exitCode !== 0) {
        throw new AgentToolsError(
          'INVALID_ARGUMENT',
          `${JSON.stringify(path)} on host "${host}" is not a regular file.`,
          { remedy: 'Use remote_ls for a directory, or check the path exists.' },
        )
      }

      // sed with an explicit range rather than head/tail piped together: a pipe
      // would need a shell, and the range bounds here are validated integers we
      // generated, never caller text.
      const result = await session.ops.exec(['sed', '-n', `${start},${end}p`, '--', target])

      if (result.exitCode !== 0) {
        throw new AgentToolsError(
          'REMOTE_COMMAND_FAILED',
          `Could not read ${JSON.stringify(path)} on host "${host}".`,
          { remedy: result.stderr.trim() || 'Check that the file is readable.' },
        )
      }

      const lines = outputLines(result.stdout)
      const returned = lines.slice(0, cap)
      // More lines came back than were asked for, so the file continues.
      const truncated = lines.length > cap || result.stdoutTruncated

      const relative = relativiseToRoot(session.root, target)
      const note = truncated
        ? truncationNote(
            returned.length,
            start + returned.length,
            `continue with offset ${start + returned.length}`,
          )
        : ''

      const header = `${relative} (lines ${start}-${start + returned.length - 1})`

      return {
        text: `${header}\n${returned.join('\n')}${note}`,
        details: {
          path: relative,
          offset: start,
          lines: returned,
          truncated,
        },
      }
    } catch (error) {
      return toolError(error)
    }
  },
}
