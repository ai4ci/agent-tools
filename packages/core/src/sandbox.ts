import posix from 'node:path/posix'
import { invalidArgument } from './errors.js'

/**
 * bwrap sandbox construction (ADR-006, ADR-012).
 *
 * Every remote command runs inside this. The shape is not guesswork — it is what
 * `design/prototype/probe-bwrap.sh` verified against a real bwrap, and the
 * ordering and layout rules below exist because the obvious versions of them were
 * observed to fail.
 *
 * What this does buy: the root is read-only, the network is gone, and nothing
 * outside the root and the toolchain is in the filesystem view.
 *
 * What it does NOT buy: confidentiality within what is reachable. `/etc` must be
 * bound or `ld.so` cannot start a process, so `/etc` is readable from inside.
 * More sharply, a symlink *inside* the root pointing at a bound path resolves
 * normally — bwrap has no reason to stop it. That gap is closed by remote
 * canonicalisation, not here (ADR-012 finding 3).
 */

/** How a toolchain path must be reproduced inside the sandbox. */
export interface UsrLayoutEntry {
  readonly path: string
  readonly kind: 'directory' | 'symlink'
  /** Link target, required when `kind` is `symlink`. */
  readonly target?: string
}

/**
 * The host's filesystem layout, as discovered by the probe.
 *
 * This cannot be hardcoded. A split-usr host has `/bin` as a real directory
 * needing `--ro-bind`; a merged-usr host has it as a symlink into `/usr`, where a
 * bind is wrong and the link must be recreated (ADR-012 finding 2).
 */
export interface UsrLayout {
  readonly entries: readonly UsrLayoutEntry[]
}

export interface BuildSandboxCommandOptions {
  /** Canonical absolute exploration root. */
  readonly root: string
  /** The command to run inside the sandbox. */
  readonly argv: readonly string[]
  readonly layout: UsrLayout
}

export function buildSandboxCommand(options: BuildSandboxCommandOptions): string[] {
  const { root, argv, layout } = options

  if (argv.length === 0) {
    throw invalidArgument('Refusing to build a sandbox around an empty command.')
  }
  if (!posix.isAbsolute(root)) {
    throw invalidArgument(`Sandbox root ${JSON.stringify(root)} must be an absolute path.`)
  }
  if (layout.entries.length === 0) {
    throw invalidArgument(
      'Sandbox layout is empty, which would produce a sandbox containing no toolchain.',
      'Probe the host layout before building a sandbox command.',
    )
  }

  const command = ['bwrap']

  // Order is significant. The tmpfs must be established before the root is bound,
  // or a root under /tmp is mounted over and vanishes (ADR-012 finding 1).
  command.push('--tmpfs', '/tmp')

  for (const entry of layout.entries) {
    if (entry.kind === 'symlink') {
      if (entry.target === undefined || entry.target.length === 0) {
        throw invalidArgument(
          `Layout entry ${JSON.stringify(entry.path)} is a symlink with no target.`,
        )
      }
      command.push('--symlink', entry.target, entry.path)
    } else {
      command.push('--ro-bind', entry.path, entry.path)
    }
  }

  command.push('--ro-bind', root, root)

  command.push('--proc', '/proc')
  command.push('--dev', '/dev')

  command.push('--unshare-net')
  command.push('--unshare-pid')
  command.push('--die-with-parent')
  command.push('--new-session')

  command.push('--chdir', root)
  command.push('--', ...argv)

  return command
}
