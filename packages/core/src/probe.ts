import posix from 'node:path/posix'
import { AgentToolsError, invalidArgument } from './errors.js'
import type { ExecOptions, ExecResult } from './remote-ops.js'
import type { UsrLayout, UsrLayoutEntry } from './sandbox.js'

/**
 * Host probe (ADR-007, ADR-012).
 *
 * Resolves the exploration root, discovers the filesystem layout the sandbox must
 * reproduce, records which search tools exist, and proves the sandbox can
 * actually be created.
 *
 * The probe necessarily runs *outside* the sandbox: bwrap cannot be configured
 * until the root is known. That is acceptable only because its content is built
 * purely from configuration and contains nothing model-derived.
 *
 * It is deliberately one round trip. Each additional trip is latency on every
 * first use of a host, and the parts are not independently useful — a root
 * without a working sandbox is refused anyway.
 */

/** Paths the sandbox may need to reproduce for the toolchain to run. */
const TOOLCHAIN_PATHS = ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/etc'] as const

/** Commands worth knowing about before choosing how to implement a tool. */
const PROBED_TOOLS = ['rg', 'grep', 'find', 'ls', 'stat', 'cat', 'realpath'] as const

/** Mirrors config validation. Re-checked here because this is the one command
 * that contains an unquoted expansion. */
const SAFE_ROOT = /^(?:\/[^\0]*|\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}))$/

export interface ProbeResult {
  /** Canonical absolute root, as resolved by the remote host. */
  readonly root: string
  readonly layout: UsrLayout
  readonly tools: ReadonlySet<string>
  readonly sandboxAvailable: boolean
}

/** A raw, unsandboxed exec. Only the probe uses one. */
export type RawExec = (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>

/**
 * Build the probe script.
 *
 * Output is tab-separated records rather than anything requiring a parser on the
 * remote, so this works on a host with nothing but a POSIX shell and coreutils.
 *
 * The root expression is interpolated unquoted, because a variable root such as
 * `$PROJECTDIR` can only be expanded by the remote login shell. Config validation
 * restricts it to an absolute path or a bare variable name, and that restriction
 * is re-applied here — this is the single place where an injection would become
 * remote execution.
 */
export function buildProbeScript(rootExpression: string): string {
  if (!SAFE_ROOT.test(rootExpression)) {
    throw invalidArgument(
      `Unsafe root expression ${JSON.stringify(rootExpression)}.`,
      'Roots must be an absolute path or a bare variable such as "$PROJECTDIR".',
    )
  }

  const layoutChecks = TOOLCHAIN_PATHS.map(
    (path) =>
      `if [ -L ${path} ]; then printf 'LAYOUT\\t%s\\tsymlink\\t%s\\n' ${path} "$(readlink ${path})"; ` +
      `elif [ -d ${path} ]; then printf 'LAYOUT\\t%s\\tdirectory\\n' ${path}; fi`,
  ).join('\n')

  const toolChecks = PROBED_TOOLS.map(
    (tool) => `command -v ${tool} >/dev/null 2>&1 && printf 'TOOL\\t%s\\n' ${tool}`,
  ).join('\n')

  // `cd` then `pwd -P` canonicalises without depending on realpath(1), which is
  // absent on some minimal hosts. Failure to cd is fatal: a root that does not
  // exist is not something to work around.
  return [
    'set -u',
    `cd -- ${rootExpression} 2>/dev/null || { printf 'ERROR\\troot-unreachable\\n'; exit 1; }`,
    `printf 'ROOT\\t%s\\n' "$(pwd -P)"`,
    layoutChecks,
    toolChecks,
    // Presence of the binary proves nothing: a hardened host ships bwrap and
    // refuses the unshare. Attempt a real namespace (ADR-012 finding 5).
    "if command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --unshare-net true >/dev/null 2>&1; then printf 'SANDBOX\\tok\\n'; else printf 'SANDBOX\\tno\\n'; fi",
  ].join('\n')
}

function parseLayoutEntry(
  path: string,
  kind: string | undefined,
  target: string | undefined,
): UsrLayoutEntry | undefined {
  if (kind === 'symlink' && target !== undefined) return { path, kind: 'symlink', target }
  if (kind === 'directory') return { path, kind: 'directory' }
  return undefined
}

function validateProbedRoot(root: string | undefined): string {
  if (root === undefined) {
    throw new AgentToolsError('PROBE_FAILED', 'Probe did not report a root directory.', {
      remedy: 'Check that the configured root exists on the host.',
    })
  }
  if (!posix.isAbsolute(root)) {
    throw new AgentToolsError(
      'PROBE_FAILED',
      `Probe reported a non-absolute root ${JSON.stringify(root)}.`,
    )
  }
  return root
}

/** Parse the probe's tab-separated output. */
export function parseProbeOutput(stdout: string): ProbeResult {
  let root: string | undefined
  let sandboxAvailable = false
  const entries: UsrLayoutEntry[] = []
  const tools = new Set<string>()

  for (const line of stdout.split('\n')) {
    // Anything unrecognised is shell noise — a login banner, a warning — and is
    // ignored rather than treated as a failure.
    const [kind, first, second, third] = line.split('\t')
    if (first === undefined) continue

    if (kind === 'ROOT') root = first
    else if (kind === 'SANDBOX') sandboxAvailable = first === 'ok'
    else if (kind === 'TOOL') tools.add(first)
    else if (kind === 'LAYOUT') {
      const entry = parseLayoutEntry(first, second, third)
      if (entry !== undefined) entries.push(entry)
    }
  }

  return {
    root: validateProbedRoot(root),
    layout: { entries },
    tools,
    sandboxAvailable,
  }
}

/**
 * Run the probe and enforce the fail-closed rule.
 *
 * A host without a working sandbox is refused outright. ADR-006 has no degraded
 * mode: it was put to the user that this locks out hardened hosts, and
 * fail-closed was chosen anyway.
 */
export async function probeHost(
  exec: RawExec,
  rootExpression: string,
  options: ExecOptions = {},
): Promise<ProbeResult> {
  const script = buildProbeScript(rootExpression)

  const result = await exec(['sh', '-c', script], options)

  if (result.exitCode !== 0) {
    throw new AgentToolsError(
      'PROBE_FAILED',
      `Probe failed on the host (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      { remedy: 'Check that the configured root exists and is readable.' },
    )
  }

  const probe = parseProbeOutput(result.stdout)

  if (!probe.sandboxAvailable) {
    throw new AgentToolsError(
      'SANDBOX_UNAVAILABLE',
      'This host cannot create a bwrap sandbox, so it will not be explored.',
      {
        remedy:
          'Install bubblewrap and ensure unprivileged user namespaces are permitted ' +
          '(kernel.unprivileged_userns_clone=1). There is no unsandboxed mode.',
      },
    )
  }

  return probe
}
