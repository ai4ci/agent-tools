import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentToolsError,
  buildSandboxCommand,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type ExecOptions,
  type ExecResult,
  invalidArgument,
  type ProbeResult,
  probeHost,
  type RemoteCapabilities,
  type RemoteOps,
  truncateToBytes,
} from '@agent-tools/core'

/**
 * Test tier 3 (ADR-011) — real bwrap, no SSH.
 *
 * Runs the production probe and the production sandbox builder against the local
 * machine. That makes sandbox correctness testable without a remote host, and it
 * is the only tier that can currently verify any of it: this development sandbox
 * has no sshd, so tier 4 is CI-only (ENV-003).
 *
 * SECURITY: test-only, same warning as TestRemoteOps. Never reachable from
 * production configuration (ADR-011).
 */

export interface LocalSandboxRemoteOps extends RemoteOps {
  readonly probe: ProbeResult
  /** Run a command *outside* the sandbox, for arranging fixtures. */
  execUnsandboxed(argv: readonly string[]): Promise<ExecResult>
}

function runLocal(argv: readonly string[], cwd: string, options: ExecOptions): Promise<ExecResult> {
  const [command, ...args] = argv as [string, ...string[]]
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: Math.max(maxOutputBytes * 2, 10 * 1024 * 1024),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null

        if (failure !== null && failure.killed === true) {
          reject(new AgentToolsError('TIMEOUT', `Command timed out: ${command}`, { cause: error }))
          return
        }
        if (failure !== null && typeof failure.code === 'string') {
          reject(
            new AgentToolsError(
              'REMOTE_COMMAND_FAILED',
              `Could not run ${command}: ${failure.code}`,
              {
                cause: error,
              },
            ),
          )
          return
        }

        const truncated = truncateToBytes(stdout, maxOutputBytes)
        const exitCode = failure === null ? 0 : typeof failure.code === 'number' ? failure.code : 1

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

class LocalSandboxRemoteOpsImpl implements LocalSandboxRemoteOps {
  readonly alias = 'local-sandbox'
  readonly probe: ProbeResult
  #root: string
  #closed = false

  constructor(root: string, probe: ProbeResult) {
    this.#root = root
    this.probe = probe
  }

  root(): Promise<string> {
    return Promise.resolve(this.#root)
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({ tools: this.probe.tools, hasSandbox: true })
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (this.#closed) {
      throw new AgentToolsError('REMOTE_COMMAND_FAILED', 'Ops has been closed.')
    }
    if (argv.length === 0) throw invalidArgument('Cannot execute an empty argument list.')

    const sandboxed = buildSandboxCommand({
      root: this.#root,
      argv,
      layout: this.probe.layout,
    })

    // cwd is irrelevant to the sandboxed process — bwrap --chdir sets it — but
    // bwrap itself must start somewhere that exists.
    return runLocal(sandboxed, this.#root, options)
  }

  execUnsandboxed(argv: readonly string[]): Promise<ExecResult> {
    return runLocal(argv, this.#root, {})
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await rm(this.#root, { recursive: true, force: true })
  }
}

/**
 * Probe the local machine and return sandboxed ops rooted at a temp directory.
 *
 * Uses the production `probeHost`, so a machine without a working bwrap is
 * refused here exactly as a remote host would be — the fail-closed path is the
 * same code.
 */
export async function createLocalSandboxRemoteOps(): Promise<LocalSandboxRemoteOps> {
  const created = await mkdtemp(join(tmpdir(), 'agent-tools-sandbox-'))
  const root = await realpath(created)

  const probe = await probeHost((argv, options) => runLocal(argv, root, options ?? {}), root)

  return new LocalSandboxRemoteOpsImpl(root, probe)
}
