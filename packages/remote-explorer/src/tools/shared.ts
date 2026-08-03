import posix from 'node:path/posix'
import { AgentToolsError, canonicaliseWithinRoot } from '@agent-tools/core'
import type { HostSession } from '../tool.js'

/**
 * Helpers shared by the remote tools.
 *
 * Every tool resolves its own paths through `resolveTarget`, so containment is
 * enforced per tool rather than only inside core. A tool that forgot to call it
 * would be the one hole in three layers of containment, so this is deliberately
 * the only path-accepting entry point the tools use.
 */

/**
 * Resolve a caller-supplied path against the session root, following symlinks on
 * the host (ADR-012 finding 3).
 */
export function resolveTarget(session: HostSession, path: string | undefined): Promise<string> {
  return canonicaliseWithinRoot(
    (argv) => session.ops.exec(argv),
    session.root,
    path ?? '.',
    session.capabilities.tools.has('realpath'),
  )
}

/**
 * Express an absolute host path relative to the root.
 *
 * Absolute host paths leak the host's layout into a transcript and are longer for
 * no benefit, so results are reported root-relative — the same terms the model
 * supplies paths in.
 */
export function relativiseToRoot(root: string, absolute: string): string {
  if (absolute === root) return '.'
  const prefix = root.endsWith('/') ? root : `${root}/`
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute
}

/** Split command output into lines, dropping the trailing empty one. */
export function outputLines(stdout: string): string[] {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Reject an argument that a tool would otherwise pass where the underlying binary
 * could read it as an option.
 *
 * Most invocations are protected by a `--` separator, but not every predicate
 * position accepts one — `find -name` is followed by a pattern that `find` will
 * happily interpret as a further predicate. Refusing the input is better than
 * silently running something else.
 */
export function rejectOptionLike(value: string, field: string): void {
  if (value.startsWith('-')) {
    throw new AgentToolsError(
      'INVALID_ARGUMENT',
      `The ${field} value ${JSON.stringify(value)} starts with "-", which the remote command ` +
        'would read as an option rather than a value.',
      { remedy: `Provide a ${field} that does not begin with "-".` },
    )
  }
}

/** Render a truncation note. Truncation is never silent (ADR-009). */
export function truncationNote(shown: number, total: number, advice: string): string {
  return `\n\n[truncated: showing ${shown} of ${total}; ${advice}]`
}

/** Guard against a path escaping via `..` after any local composition. */
export function assertNoTraversal(path: string): void {
  if (posix.normalize(path).startsWith('..')) {
    throw new AgentToolsError('PATH_OUTSIDE_ROOT', 'Resolved path escapes the connection root.')
  }
}
