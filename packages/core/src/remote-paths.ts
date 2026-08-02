import { AgentToolsError } from './errors.js'
import { isPathWithin, resolveWithinRoot } from './paths.js'
import type { ExecResult } from './remote-ops.js'

/**
 * Remote canonicalisation — the third containment layer (ADR-012 finding 3).
 *
 * Lexical containment rejects `../`, and the bwrap namespace removes everything
 * outside the root and the toolchain from view. Neither closes this case: `/etc`
 * and `/usr` must be bound or nothing can execute, so a symlink *inside* the root
 * pointing at `/etc/hostname` resolves normally. The prototype demonstrated it
 * reading the file from inside the sandbox.
 *
 * The path handed to the tool is entirely legitimate, so the only way to catch it
 * is to ask the host what the path actually resolves to, and check that answer.
 * This runs inside the sandbox, so what it resolves is exactly what the tool
 * would have read.
 */

export type SandboxedExec = (argv: readonly string[]) => Promise<ExecResult>

/**
 * Canonicalisation for hosts without `realpath(1)`.
 *
 * `cd` plus `pwd -P` resolves symlinks in the *directory* portion of a path, but
 * not a symlinked final component — which is precisely the case that matters
 * here, since the escape is a link sitting inside the root. The final component
 * is therefore followed explicitly before the directory is resolved.
 *
 * The hop counter guards against a symlink cycle, which would otherwise spin
 * until the command timeout.
 */
const FALLBACK_CANONICALISE = `
p=$1
hops=0
while [ -L "$p" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 40 ]; then
    echo "too many symbolic links" >&2
    exit 1
  fi
  target=$(readlink -- "$p") || exit 1
  case "$target" in
    /*) p=$target ;;
    *)  p=$(dirname -- "$p")/$target ;;
  esac
done
if [ -d "$p" ]; then
  cd -- "$p" && pwd -P
else
  d=$(dirname -- "$p") && b=$(basename -- "$p") && cd -- "$d" && printf '%s/%s\\n' "$(pwd -P)" "$b"
fi
`

/**
 * Resolve a caller-supplied path to its canonical location and prove it is inside
 * the root once symlinks have been followed.
 *
 * @param exec Sandboxed exec — resolution must happen in the same view the tool
 *   will see, otherwise the answer describes a different filesystem.
 * @param root Canonical absolute root from the probe.
 * @param input Caller-supplied path.
 * @param hasRealpath Whether the host has `realpath(1)`, per the probe.
 */
export async function canonicaliseWithinRoot(
  exec: SandboxedExec,
  root: string,
  input: string,
  hasRealpath: boolean,
): Promise<string> {
  // Cheap lexical check first: no point paying a round trip for '../../etc'.
  const lexical = resolveWithinRoot(root, input)

  const result = hasRealpath
    ? await exec(['realpath', '--', lexical])
    : await exec(['sh', '-c', FALLBACK_CANONICALISE, 'sh', lexical])

  if (result.exitCode !== 0) {
    throw new AgentToolsError(
      'INVALID_ARGUMENT',
      `Path ${JSON.stringify(input)} could not be resolved on the host.`,
      { remedy: 'Check that the path exists below the connection root.' },
    )
  }

  const canonical = result.stdout.trim()

  if (canonical.length === 0) {
    throw new AgentToolsError(
      'INVALID_ARGUMENT',
      `Path ${JSON.stringify(input)} resolved to nothing on the host.`,
    )
  }

  if (!isPathWithin(root, canonical)) {
    // Reached via a symlink out of the root. The lexical check could not see it
    // and the sandbox does not prevent it.
    throw new AgentToolsError(
      'PATH_OUTSIDE_ROOT',
      `Path ${JSON.stringify(input)} resolves outside the connection root via a symbolic link.`,
      { remedy: 'Use a path that stays within the connection root once links are followed.' },
    )
  }

  return canonical
}
