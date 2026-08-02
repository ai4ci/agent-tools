import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AgentToolsError,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type ExecOptions,
  type ExecResult,
  invalidArgument,
  type RemoteCapabilities,
  type RemoteOps,
  truncateToBytes,
} from '@agent-tools/core'

/**
 * Test tier 1 RemoteOps (ADR-011).
 *
 * Executes the argv it is given locally, against a temporary directory standing
 * in for the connection root, using the real `grep`/`find`/`rg` binaries. It does
 * not reimplement any tool, so behaviour above the seam is tested against genuine
 * output.
 *
 * SECURITY: this executes commands locally with no sandbox and no containment. It
 * is a test double and must never be reachable from production configuration —
 * `scripts/check-boundaries.mjs` enforces that no shipped package can depend on
 * or import this package (ADR-011).
 *
 * What this cannot cover, by construction:
 *   - escaping, since no shell is involved (tier 2 covers it)
 *   - the bwrap sandbox (tiers 3 and 4)
 */

/** A fixture tree: path relative to the root, mapped to file contents. */
export type FileTree = Readonly<Record<string, string>>

export interface TestRemoteOpsOptions {
  /**
   * Override the reported tool set. Without this, capabilities reflect whatever
   * the developer's machine happens to have, so a fallback path (for example
   * "no rg, use grep") would never be exercised locally — see ENV-004.
   */
  readonly tools?: readonly string[]
  readonly alias?: string
}

export interface TestRemoteOps extends RemoteOps {
  /** Materialise a fixture tree under the root, creating parent directories. */
  writeTree(tree: FileTree): Promise<void>
}

const PROBED_TOOLS = ['rg', 'grep', 'find', 'ls', 'stat', 'cat'] as const

class TestRemoteOpsImpl implements TestRemoteOps {
  readonly alias: string
  #root: string
  #tools: ReadonlySet<string> | undefined
  #overriddenTools: readonly string[] | undefined
  #closed = false

  constructor(root: string, options: TestRemoteOpsOptions) {
    this.#root = root
    this.alias = options.alias ?? 'test'
    this.#overriddenTools = options.tools
  }

  root(): Promise<string> {
    return Promise.resolve(this.#root)
  }

  async capabilities(): Promise<RemoteCapabilities> {
    if (this.#tools === undefined) {
      this.#tools =
        this.#overriddenTools === undefined
          ? await this.#probeTools()
          : new Set(this.#overriddenTools)
    }
    // hasSandbox is always false: nothing here runs under bwrap, and claiming
    // otherwise would let a fail-closed test pass for the wrong reason.
    return { tools: this.#tools, hasSandbox: false }
  }

  async #probeTools(): Promise<ReadonlySet<string>> {
    const present = new Set<string>()
    await Promise.all(
      PROBED_TOOLS.map(async (tool) => {
        try {
          const result = await this.#run(['sh', '-c', `command -v ${tool}`], {})
          if (result.exitCode === 0) present.add(tool)
        } catch {
          // Treated as absent.
        }
      }),
    )
    return present
  }

  // Declared async so that argument rejections surface as a rejected promise
  // rather than a synchronous throw. Callers await a single code path.
  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (this.#closed) {
      throw new AgentToolsError('REMOTE_COMMAND_FAILED', 'TestRemoteOps has been closed.')
    }
    if (argv.length === 0) {
      throw invalidArgument('Cannot execute an empty argument list.')
    }
    return this.#run(argv, options)
  }

  #run(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    const [command, ...args] = argv as [string, ...string[]]
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<ExecResult>((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd: this.#root,
          timeout: timeoutMs,
          // Capture generously, then apply our own cap so truncation is reported
          // rather than surfacing as a maxBuffer crash.
          maxBuffer: Math.max(maxOutputBytes * 2, 10 * 1024 * 1024),
          encoding: 'utf8',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            const failure = error as NodeJS.ErrnoException & {
              killed?: boolean
              signal?: NodeJS.Signals
            }

            if (failure.killed === true && failure.signal === 'SIGTERM') {
              reject(
                new AgentToolsError(
                  'TIMEOUT',
                  `Command timed out after ${timeoutMs}ms: ${command}`,
                  { remedy: 'Narrow the query or raise the timeout.', cause: error },
                ),
              )
              return
            }

            // An exit code means the command ran; that is a result, not an error.
            // Only a failure to run at all reaches here as an error.
            if (typeof failure.code === 'string') {
              reject(
                new AgentToolsError(
                  'REMOTE_COMMAND_FAILED',
                  `Could not run ${command}: ${failure.code}`,
                  { cause: error },
                ),
              )
              return
            }
          }

          const truncatedStdout = truncateToBytes(stdout, maxOutputBytes)
          resolve({
            stdout: truncatedStdout.text,
            stderr,
            exitCode: exitCodeOf(error),
            stdoutTruncated: truncatedStdout.truncated,
          })
        },
      )
    })
  }

  async writeTree(tree: FileTree): Promise<void> {
    for (const [relativePath, contents] of Object.entries(tree)) {
      const target = join(this.#root, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents, 'utf8')
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await rm(this.#root, { recursive: true, force: true })
  }
}

function exitCodeOf(error: unknown): number {
  if (error === null || error === undefined) return 0
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : 1
}

/**
 * Create a RemoteOps backed by a fresh temporary directory.
 *
 * The root is canonicalised, because `os.tmpdir()` is a symlink on some systems
 * and a non-canonical root would make containment comparisons disagree with the
 * paths the tools actually report.
 */
export async function createTestRemoteOps(
  options: TestRemoteOpsOptions = {},
): Promise<TestRemoteOps> {
  const created = await mkdtemp(join(tmpdir(), 'agent-tools-test-'))
  const canonical = await realpath(created)
  return new TestRemoteOpsImpl(canonical, options)
}
