/**
 * The RemoteOps seam (ADR-011).
 *
 * Deliberately low-level: a command sink taking an argv, plus root resolution and
 * capability reporting. It is *not* an `ls()`/`grep()`/`find()` interface, because
 * a test implementation of that shape would have to reimplement those operations,
 * and the suite would then be validating the reimplementation rather than the
 * behaviour of the real tools.
 *
 * Because both implementations receive an identical argv, everything above this
 * seam — argv construction, output parsing, truncation, error mapping, path
 * containment — is exercised by the fast test tier against real tool output.
 */

/** Search and sandbox tooling discovered on a host. */
export interface RemoteCapabilities {
  /** Bare command names known to be present, e.g. `rg`, `grep`, `find`. */
  readonly tools: ReadonlySet<string>
  /** Whether commands are executing inside a verified sandbox (ADR-006). */
  readonly hasSandbox: boolean
}

export interface ExecOptions {
  /** Wall-clock budget. The implementation must kill the command when exceeded. */
  readonly timeoutMs?: number
  /** Byte cap on captured stdout. Output beyond it is dropped and flagged. */
  readonly maxOutputBytes?: number
  readonly signal?: AbortSignal
}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /** True when stdout hit `maxOutputBytes`. Never truncate silently (ADR-009). */
  readonly stdoutTruncated: boolean
}

export interface RemoteOps {
  /** Configured host alias, used in error messages (ADR-004). */
  readonly alias: string

  /**
   * Canonical absolute exploration root. Resolved once and cached — on a real
   * host this requires a round trip, since the root may be a shell variable that
   * only the remote login environment can expand (ADR-007).
   */
  root(): Promise<string>

  capabilities(): Promise<RemoteCapabilities>

  /**
   * Run a command. `argv[0]` is the program; no shell is involved on the caller's
   * side of this interface. Implementations that must cross a shell — SSH does —
   * are responsible for escaping such that the remote receives this exact argv.
   *
   * A non-zero exit code is returned in the result, not thrown: for `grep`, exit
   * 1 means "no matches", which is an ordinary answer rather than a failure.
   * Errors are reserved for cases where no meaningful result exists.
   */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>

  /** Release resources. Must be idempotent. */
  close(): Promise<void>
}

/** Default byte cap applied when a caller does not specify one. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000

/** Default per-command wall-clock budget. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Apply a byte cap to captured output.
 *
 * Truncates on a UTF-8 character boundary — cutting mid-sequence would emit a
 * replacement character and corrupt the last line of otherwise valid output.
 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, truncated: false }

  // Walk back to a lead byte so the slice ends on a complete character. A UTF-8
  // continuation byte matches 0b10xxxxxx; if the cut lands on one, the character
  // it belongs to is incomplete and must be dropped entirely.
  let end = maxBytes
  const isContinuation = (index: number): boolean => ((buffer[index] ?? 0) & 0xc0) === 0x80
  while (end > 0 && isContinuation(end)) end--

  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
}
