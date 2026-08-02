/**
 * Error taxonomy.
 *
 * Every failure an agent can provoke is one of these, carrying a stable `code`
 * that adapters map to tool-result text. Tools are called by a model, so the
 * message is part of the interface: it should say what went wrong and what would
 * fix it, and never leak a stack trace or an internal path into a transcript.
 */

export type AgentToolsErrorCode =
  /** Config file missing, unparseable, or failing schema validation. */
  | 'CONFIG_INVALID'
  /** The requested host alias is not declared in the config (ADR-004). */
  | 'UNKNOWN_HOST'
  /** A caller-supplied argument is malformed before any remote work happens. */
  | 'INVALID_ARGUMENT'
  /** The resolved path lies outside the connection root (ADR-007). */
  | 'PATH_OUTSIDE_ROOT'
  /** SSH could not reach the host. */
  | 'HOST_UNREACHABLE'
  /** SSH reached the host but authentication failed. */
  | 'AUTH_FAILED'
  /** A command exceeded its time budget. */
  | 'TIMEOUT'
  /** The host is refused because it cannot be sandboxed (ADR-006, fail-closed). */
  | 'SANDBOX_UNAVAILABLE'
  /** Probing the host failed, so neither root nor capabilities are known. */
  | 'PROBE_FAILED'
  /** The remote command ran and exited non-zero in a way the tool cannot interpret. */
  | 'REMOTE_COMMAND_FAILED'

export interface AgentToolsErrorOptions {
  readonly cause?: unknown
  /** Concrete next step for the operator or the model. Rendered after the message. */
  readonly remedy?: string
}

export class AgentToolsError extends Error {
  readonly code: AgentToolsErrorCode
  readonly remedy: string | undefined

  constructor(code: AgentToolsErrorCode, message: string, options: AgentToolsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentToolsError'
    this.code = code
    this.remedy = options.remedy
  }

  /** Single-line rendering suitable for a tool result. */
  toToolMessage(): string {
    return this.remedy === undefined ? this.message : `${this.message} ${this.remedy}`
  }
}

export function isAgentToolsError(value: unknown): value is AgentToolsError {
  return value instanceof AgentToolsError
}

export function invalidArgument(message: string, remedy?: string): AgentToolsError {
  return new AgentToolsError('INVALID_ARGUMENT', message, remedy === undefined ? {} : { remedy })
}
