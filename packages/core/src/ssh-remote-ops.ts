import { execFile } from 'node:child_process'
import type { HostConfig } from './config.js'
import { AgentToolsError, invalidArgument } from './errors.js'
import { type ProbeResult, probeHost } from './probe.js'
import {
  type ExecOptions,
  type ExecResult,
  type RemoteCapabilities,
  type RemoteOps,
  truncateToBytes,
} from './remote-ops.js'
import { buildSandboxCommand } from './sandbox.js'
import { shellJoin } from './shell.js'
import { buildSshCommand, controlPathFor } from './ssh-command.js'
import { classifySshFailure } from './ssh-failure.js'

/**
 * RemoteOps over SSH (ADR-006, ADR-007, ADR-008).
 *
 * Assembles the pieces the rest of core provides: the probe resolves the root and
 * proves the sandbox exists, `buildSandboxCommand` wraps the payload, `shellJoin`
 * flattens it for the remote login shell, and `buildSshCommand` produces the local
 * invocation.
 *
 * Ordering is the part worth stating. The payload argv is wrapped in bwrap
 * *first*, then the whole bwrap command is escaped as one unit. Escaping before
 * wrapping would leave the bwrap flags themselves unquoted, and a root containing
 * a space would break the sandbox rather than the command.
 */

/** Retained so a caller can dispose of a session's connections. */
const openSessions = new Set<SshRemoteOps>()

type LocalExecFailure = NodeJS.ErrnoException & {
  killed?: boolean
  signal?: NodeJS.Signals
}

/**
 * Failures of the *local* `ssh` process, as distinct from failures reported by
 * ssh about the connection (which `classifySshFailure` handles) and from the
 * remote command's own exit code (which is a result, not a failure).
 */
function mapLocalExecFailure(
  alias: string,
  error: unknown,
  timeoutMs: number,
): AgentToolsError | undefined {
  const failure = error as LocalExecFailure | null
  if (failure === null) return undefined

  if (failure.killed === true) {
    return new AgentToolsError('TIMEOUT', `Command on "${alias}" timed out after ${timeoutMs}ms.`, {
      remedy: 'Narrow the query or raise the timeout for this host.',
      cause: error,
    })
  }

  // A string `code` is an errno from spawning ssh itself — ENOENT means ssh is
  // not installed. A numeric one is the process exit status.
  if (typeof failure.code === 'string') {
    return new AgentToolsError(
      'HOST_UNREACHABLE',
      `Could not run ssh for host "${alias}": ${failure.code}`,
      { remedy: 'Check that ssh is installed and on PATH.', cause: error },
    )
  }

  return undefined
}

function exitCodeOf(error: unknown): number {
  if (error === null || error === undefined) return 0
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : 1
}

export interface SshRemoteOpsOptions {
  readonly host: HostConfig
  /** Disable connection multiplexing. Multiplexing is on by default (ADR-008). */
  readonly multiplex?: boolean
  readonly connectTimeoutSeconds?: number
}

export class SshRemoteOps implements RemoteOps {
  readonly alias: string
  #host: HostConfig
  #controlPath: string | undefined
  #connectTimeoutSeconds: number | undefined
  #probe: Promise<ProbeResult> | undefined
  #closed = false

  constructor(options: SshRemoteOpsOptions) {
    this.#host = options.host
    this.alias = options.host.alias
    this.#controlPath =
      options.multiplex === false
        ? undefined
        : controlPathFor(options.host.alias, options.host.ssh.target)
    this.#connectTimeoutSeconds = options.connectTimeoutSeconds
    openSessions.add(this)
  }

  /**
   * Probe once per session and cache it.
   *
   * Concurrent callers share the in-flight promise rather than each issuing a
   * probe — the first few tool calls in a session typically arrive together, and
   * probing per call would multiply the connection setup cost.
   */
  #probed(): Promise<ProbeResult> {
    this.#probe ??= probeHost(
      (argv, options) => this.#runRaw(argv, options ?? {}),
      this.#host.root,
      { timeoutMs: this.#host.limits.timeoutMs },
    )
    return this.#probe
  }

  async root(): Promise<string> {
    return (await this.#probed()).root
  }

  async capabilities(): Promise<RemoteCapabilities> {
    const probe = await this.#probed()
    // hasSandbox is unconditionally true here: probeHost refuses the host
    // otherwise, so reaching this point means the sandbox was verified.
    return { tools: probe.tools, hasSandbox: true }
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (this.#closed) {
      throw new AgentToolsError('REMOTE_COMMAND_FAILED', `Session for "${this.alias}" is closed.`)
    }
    if (argv.length === 0) throw invalidArgument('Cannot execute an empty argument list.')

    const probe = await this.#probed()

    // Wrap first, escape second. The reverse would leave bwrap's own flags
    // unquoted in the string handed to the remote shell.
    const sandboxed = buildSandboxCommand({
      root: probe.root,
      argv,
      layout: probe.layout,
    })

    return this.#runRaw(sandboxed, options)
  }

  /**
   * Run a command on the host with no sandbox.
   *
   * Only the probe legitimately needs this — bwrap cannot be configured before
   * the root is known (ADR-007). It is private so that no tool can reach it.
   */
  #runRaw(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    const remoteCommand = shellJoin(argv)
    const sshArgv = buildSshCommand({
      host: this.#host,
      remoteCommand,
      ...(this.#controlPath === undefined ? {} : { controlPath: this.#controlPath }),
      ...(this.#connectTimeoutSeconds === undefined
        ? {}
        : { connectTimeoutSeconds: this.#connectTimeoutSeconds }),
    })

    const maxOutputBytes = options.maxOutputBytes ?? this.#host.limits.maxOutputBytes
    const timeoutMs = options.timeoutMs ?? this.#host.limits.timeoutMs
    const [command, ...args] = sshArgv as [string, ...string[]]

    return new Promise<ExecResult>((resolve, reject) => {
      execFile(
        command,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: Math.max(maxOutputBytes * 2, 10 * 1024 * 1024),
          encoding: 'utf8',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (error, stdout, stderr) => {
          const exitCode = exitCodeOf(error)

          const failure =
            mapLocalExecFailure(this.alias, error, timeoutMs) ??
            classifySshFailure({ alias: this.alias, exitCode, stderr })

          if (failure !== undefined) {
            reject(failure)
            return
          }

          const truncated = truncateToBytes(stdout, maxOutputBytes)
          resolve({
            stdout: truncated.text,
            stderr,
            exitCode,
            stdoutTruncated: truncated.truncated,
          })
        },
      )
    })
  }

  /**
   * Close the multiplexed master connection.
   *
   * Not optional housekeeping. The pi adapter runs in-process for the lifetime of
   * a pi session (ADR-003), so a leaked control socket persists for that whole
   * session and holds a connection open on the remote (ADR-008).
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    openSessions.delete(this)

    if (this.#controlPath === undefined) return

    await new Promise<void>((resolve) => {
      execFile(
        'ssh',
        ['-o', `ControlPath=${this.#controlPath}`, '-O', 'exit', this.#host.ssh.target],
        // Best effort: if no master is running there is nothing to close, and
        // failing to tear down a connection must not fail a session teardown.
        () => resolve(),
      )
    })
  }
}

/** Close every session opened in this process. For adapter shutdown hooks. */
export async function closeAllSshSessions(): Promise<void> {
  await Promise.all([...openSessions].map((session) => session.close()))
}
