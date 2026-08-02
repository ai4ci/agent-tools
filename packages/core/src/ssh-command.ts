import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostConfig } from './config.js'
import { invalidArgument } from './errors.js'

/**
 * SSH invocation construction (ADR-008).
 *
 * We shell out to the system `ssh` rather than using an in-process SSH library so
 * that `~/.ssh/config`, agent forwarding, jump hosts, and site policy all behave
 * exactly as the operator already expects. The cost is that everything is
 * expressed as command-line flags, which is what this module is for.
 */

/** How long a multiplexed master connection lingers after the last command. */
const CONTROL_PERSIST = '60s'

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10

export interface BuildSshCommandOptions {
  readonly host: HostConfig
  /** Already flattened by `shellJoin` — this is one argument, not many. */
  readonly remoteCommand: string
  /** Enables connection multiplexing. Omit to connect without a master. */
  readonly controlPath?: string
  readonly connectTimeoutSeconds?: number
}

/**
 * Build the local argv used to invoke `ssh`.
 *
 * Option precedence is positional: ssh uses the *first* value it obtains for any
 * given option, so operator-configured options are emitted before our defaults.
 * An operator who sets `BatchMode=no` gets `BatchMode=no`, which would silently
 * not happen if the defaults came first.
 */
export function buildSshCommand(options: BuildSshCommandOptions): string[] {
  const { host, remoteCommand, controlPath } = options
  const connectTimeout = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS

  if (remoteCommand.length === 0) {
    throw invalidArgument('Refusing to open an SSH session with no command.')
  }

  // A target beginning with '-' would be parsed by ssh as a flag. Config is
  // trusted input, but a typo here turns into arbitrary local execution via
  // -oProxyCommand, which is too sharp an edge to leave unguarded.
  if (host.ssh.target.startsWith('-')) {
    throw invalidArgument(
      `SSH target ${JSON.stringify(host.ssh.target)} starts with "-" and would be read as a flag.`,
      'Correct the "ssh.target" field for this host.',
    )
  }

  const argv = ['ssh', '-T']

  for (const [key, value] of Object.entries(host.ssh.options ?? {})) {
    argv.push('-o', `${key}=${value}`)
  }

  argv.push('-o', 'BatchMode=yes')
  argv.push('-o', `ConnectTimeout=${connectTimeout}`)

  if (controlPath !== undefined) {
    argv.push('-o', 'ControlMaster=auto')
    argv.push('-o', `ControlPath=${controlPath}`)
    argv.push('-o', `ControlPersist=${CONTROL_PERSIST}`)
  }

  if (host.ssh.port !== undefined) argv.push('-p', String(host.ssh.port))
  if (host.ssh.identityFile !== undefined) argv.push('-i', host.ssh.identityFile)

  argv.push(host.ssh.target, remoteCommand)
  return argv
}

/**
 * Path for a multiplexing control socket.
 *
 * Derived from a hash rather than the alias itself for two reasons: a unix domain
 * socket path is capped near 104 bytes on some platforms and ssh fails obscurely
 * past it, and an alias is free-form text that could otherwise contribute path
 * separators.
 */
export function controlPathFor(alias: string, target: string): string {
  const digest = createHash('sha256').update(`${alias}\0${target}`).digest('hex').slice(0, 16)
  return join(tmpdir(), `agent-tools-${digest}.sock`)
}
