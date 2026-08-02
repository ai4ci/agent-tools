import posix from 'node:path/posix'
import { AgentToolsError, invalidArgument } from './errors.js'

/**
 * Path containment.
 *
 * Deliberately placed in core, above the RemoteOps seam, so that every test tier
 * exercises it rather than only the tiers involving SSH (ADR-011). Remote paths
 * are POSIX whatever the operator's machine runs, so this uses `node:path/posix`
 * explicitly — using the platform `path` would silently treat a backslash as a
 * separator on Windows and change which paths are considered contained.
 *
 * This is *lexical* containment. A symlink inside the root that points outside it
 * resolves to an outside location on the remote, and nothing here can see that;
 * detecting it requires asking the remote host to canonicalise, which is Phase 2
 * work. Lexical containment is still worth having on its own: it is the check
 * that stops `../../etc/passwd` before a command is ever built.
 */

/** Normalise a root, rejecting anything that would make containment meaningless. */
function normaliseRoot(root: string): string {
  if (root.includes('\0')) {
    throw invalidArgument('Connection root contains a NUL byte.')
  }
  if (!posix.isAbsolute(root)) {
    throw invalidArgument(
      `Connection root ${JSON.stringify(root)} is not an absolute path.`,
      'Roots must be absolute; resolve the root on the remote host before use.',
    )
  }
  // Strips trailing separators and redundant segments. '/' normalises to '/'.
  return posix.normalize(root).replace(/\/+$/, '') || '/'
}

/**
 * Resolve a caller-supplied path against a connection root and prove it stays
 * inside.
 *
 * Accepts either a path relative to the root or an absolute path, because a model
 * will produce both — it sees absolute paths in earlier tool output and will echo
 * them back.
 *
 * @param root Absolute, already resolved on the remote host (ADR-007).
 * @param input Caller-supplied path. Relative paths are taken as relative to root.
 * @returns The normalised absolute path, guaranteed to be root or below it.
 * @throws AgentToolsError `INVALID_ARGUMENT` or `PATH_OUTSIDE_ROOT`.
 */
export function resolveWithinRoot(root: string, input: string): string {
  const normalisedRoot = normaliseRoot(root)

  if (input.includes('\0')) {
    throw invalidArgument('Path contains a NUL byte.', 'Remove the NUL byte from the path.')
  }

  const joined = posix.isAbsolute(input) ? input : posix.join(normalisedRoot, input)
  const resolved = posix.normalize(joined).replace(/\/+$/, '') || '/'

  if (!isWithin(normalisedRoot, resolved)) {
    throw new AgentToolsError(
      'PATH_OUTSIDE_ROOT',
      `Path ${JSON.stringify(input)} resolves outside the connection root ${normalisedRoot}.`,
      { remedy: 'Use a path at or below the connection root.' },
    )
  }

  return resolved
}

/**
 * Containment test on normalised absolute paths.
 *
 * Comparing string prefixes alone is the classic bug: '/home/u/project-secrets'
 * starts with '/home/u/project' but is not inside it. The separator check is what
 * makes the comparison correct.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  return isWithin(normaliseRoot(root), candidate)
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true
  if (root === '/') return candidate.startsWith('/')
  return candidate.startsWith(`${root}/`)
}
