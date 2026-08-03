import {
  type AgentToolsConfig,
  AgentToolsError,
  getHost,
  type HostConfig,
  isAgentToolsError,
  type RemoteCapabilities,
  type RemoteOps,
} from '@agent-tools/core'
import type { Static, TObject } from 'typebox'

/**
 * Tool definitions and the context they run in.
 *
 * Definitions are declared once here and mapped to each host's API by a thin
 * adapter (ADR-002), so pi and Claude Code cannot drift apart. Parameters are
 * TypeBox schemas because pi's registerTool takes TypeBox directly and TypeBox
 * emits JSON Schema for MCP — one source of truth, no hand-maintained second
 * copy.
 */

/** A live connection to one configured host. */
export interface HostSession {
  readonly alias: string
  readonly ops: RemoteOps
  /** Canonical root, already resolved by the probe. */
  readonly root: string
  readonly capabilities: RemoteCapabilities
}

export interface ToolContext {
  /** Configured hosts. Never reaches the network. */
  hosts(): readonly { alias: string; root: string }[]
  /**
   * Open (or reuse) a session for an alias.
   *
   * @throws AgentToolsError `UNKNOWN_HOST` for an alias that is not configured —
   *   never a fallthrough to a live connection attempt (ADR-004).
   */
  session(alias: string): Promise<HostSession>
  close(): Promise<void>
}

export interface ToolResult {
  /** Model-facing text. This is the tool's actual output. */
  readonly text: string
  /** Structured payload for hosts that can use one. */
  readonly details?: unknown
  readonly isError?: boolean
}

/**
 * A tool the model can call.
 *
 * `handler` takes the schema's inferred type, so a tool cannot declare one set of
 * parameters and read another. It is declared with method syntax deliberately:
 * that makes it bivariant, which is what allows differently-typed tools to live
 * in a single `ToolDefinition[]` for an adapter to iterate.
 */
export interface ToolDefinition<Parameters extends TObject = TObject> {
  readonly name: string
  /** Short human label for UIs that show one. */
  readonly label: string
  /**
   * One-line summary, no newlines.
   *
   * pi puts this in the system prompt's "Available tools" list and omits tools
   * that do not supply one, so without it the tool is registered but never
   * advertised.
   */
  readonly summary: string
  readonly description: string
  readonly parameters: Parameters
  handler(params: Static<Parameters>, context: ToolContext): Promise<ToolResult>
}

export interface CreateToolContextOptions {
  readonly config: AgentToolsConfig
  /**
   * Builds the transport for a host. Injected rather than hardcoded to
   * SshRemoteOps so tier 1 can drive the real handlers against TestRemoteOps
   * (ADR-011) — and so nothing in a shipped package need import test-support.
   */
  createOps(host: HostConfig): RemoteOps
}

export function createToolContext(options: CreateToolContextOptions): ToolContext {
  const { config, createOps } = options
  // Keyed by alias and holding the promise, not the resolved session, so that
  // concurrent calls share one connection attempt rather than racing to build
  // several.
  const sessions = new Map<string, Promise<HostSession>>()

  async function open(alias: string): Promise<HostSession> {
    // Throws UNKNOWN_HOST before any transport is constructed.
    const host = getHost(config, alias)
    const ops = createOps(host)

    try {
      const [root, capabilities] = await Promise.all([ops.root(), ops.capabilities()])
      return { alias, ops, root, capabilities }
    } catch (error) {
      // A failed probe must not leave a broken session cached, or every
      // subsequent call replays the same failure without retrying.
      sessions.delete(alias)
      await ops.close().catch(() => undefined)
      throw error
    }
  }

  return {
    hosts() {
      return [...config.hosts.values()]
        .map((host) => ({ alias: host.alias, root: host.root }))
        .sort((left, right) => left.alias.localeCompare(right.alias))
    },

    session(alias: string): Promise<HostSession> {
      const existing = sessions.get(alias)
      if (existing !== undefined) return existing

      // getHost throws synchronously for an unknown alias; wrapping keeps the
      // rejection on the promise so callers have one failure path.
      const pending = open(alias)
      sessions.set(alias, pending)
      // Prevent an unhandled rejection if the caller never awaits.
      pending.catch(() => undefined)
      return pending
    },

    async close() {
      const pending = [...sessions.values()]
      sessions.clear()
      await Promise.all(
        pending.map(async (session) => {
          try {
            await (await session).ops.close()
          } catch {
            // Teardown is best effort; one bad session must not block the rest.
          }
        }),
      )
    },
  }
}

/**
 * Render a thrown error as a tool result.
 *
 * Tools return errors rather than throwing them: a thrown exception surfaces as
 * a crash in the host agent, whereas a result is something the model can read
 * and act on. Only the taxonomy's message and remedy are exposed — never a stack
 * trace, which would put internal paths into a transcript.
 */
export function toolError(error: unknown): ToolResult {
  if (isAgentToolsError(error)) {
    return { text: error.toToolMessage(), isError: true }
  }
  if (error instanceof AgentToolsError) {
    return { text: error.toToolMessage(), isError: true }
  }
  return {
    text: `The operation failed: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
  }
}
