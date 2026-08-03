import { AgentToolsError } from '@agent-tools/core'
import { Type } from 'typebox'
import { stringEnum } from '../schema.js'
import { type ToolDefinition, type ToolResult, toolError } from '../tool.js'
import {
  outputLines,
  rejectOptionLike,
  relativiseToRoot,
  resolveTarget,
  truncationNote,
} from './shared.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2000

const TYPE_FLAGS: Record<string, string> = {
  file: 'f',
  directory: 'd',
  symlink: 'l',
}

const parameters = Type.Object({
  host: Type.String({ description: 'Alias of a configured host, as reported by remote_hosts.' }),
  path: Type.Optional(
    Type.String({
      description: "Directory to search under, relative to the host's root. Defaults to the root.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        'Glob matched against the entry name only, not the whole path — for example "*.log". ' +
        'Must not begin with "-".',
    }),
  ),
  type: Type.Optional(
    stringEnum(['file', 'directory', 'symlink'], {
      description: 'Restrict results to one entry type.',
    }),
  ),
  maxDepth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: 'Maximum directory depth to descend, counting the search directory as 0.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum results to return (default ${DEFAULT_LIMIT}).`,
    }),
  ),
})

export const remoteFind: ToolDefinition<typeof parameters> = {
  name: 'remote_find',
  label: 'Remote find files',
  summary: 'Find files and directories by name, type or depth on a remote host',
  description:
    'Find files and directories by name, type or depth on a configured remote host. ' +
    "Results are paths relative to the host's root. Use this to locate files; use " +
    'remote_grep to search their contents.',
  parameters,

  async handler({ host, path, name, type, maxDepth, limit }, context): Promise<ToolResult> {
    try {
      const session = await context.session(host)
      const target = await resolveTarget(session, path)
      const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)

      // `find` reads its predicates positionally and there is no `--` that
      // protects a `-name` pattern, so an option-like value is refused rather
      // than handed over to be reinterpreted as syntax.
      if (name !== undefined) rejectOptionLike(name, 'name')

      const argv = ['find', target]
      // -mindepth 1 excludes the search directory itself, which is never a useful
      // result and would otherwise always appear.
      argv.push('-mindepth', '1')
      if (maxDepth !== undefined) argv.push('-maxdepth', String(maxDepth))
      if (type !== undefined) {
        const flag = TYPE_FLAGS[type]
        if (flag === undefined) {
          throw new AgentToolsError('INVALID_ARGUMENT', `Unsupported type ${JSON.stringify(type)}.`)
        }
        argv.push('-type', flag)
      }
      if (name !== undefined) argv.push('-name', name)
      argv.push('-print')

      const result = await session.ops.exec(argv)

      // find exits non-zero for unreadable subdirectories while still returning
      // useful results, so output presence matters more than the exit code.
      if (result.exitCode !== 0 && result.stdout.length === 0) {
        throw new AgentToolsError(
          'REMOTE_COMMAND_FAILED',
          `Could not search ${JSON.stringify(path ?? '.')} on host "${host}".`,
          { remedy: result.stderr.trim() || 'Check that the path exists and is a directory.' },
        )
      }

      const all = outputLines(result.stdout).map((line) => relativiseToRoot(session.root, line))

      if (all.length === 0) {
        return {
          text: 'No matches.',
          details: { matches: [], truncated: false, total: 0 },
        }
      }

      const matches = all.slice(0, cap)
      const truncated = all.length > matches.length
      const note = truncated
        ? truncationNote(matches.length, all.length, 'narrow with "name", "type" or "maxDepth"')
        : ''

      return {
        text: `${matches.join('\n')}${note}`,
        details: { matches, truncated, total: all.length },
      }
    } catch (error) {
      return toolError(error)
    }
  },
}
