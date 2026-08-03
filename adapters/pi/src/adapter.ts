import { isAgentToolsError } from '@agent-tools/core'
import type { ToolContext, ToolDefinition } from '@agent-tools/remote-explorer'

/**
 * Mapping from a tool definition to pi's tool shape (ADR-003).
 *
 * The adapter carries no behaviour of its own. It exists because two of pi's
 * conventions do not match the definition's, and both fail silently if ignored.
 *
 * Typed structurally rather than against pi's own types: importing
 * `@earendil-works/pi-coding-agent` for types alone would make it a build
 * dependency of this package, and pi supplies the real implementation at load
 * time. The shapes below are the subset the extension actually uses.
 */

export interface PiToolContent {
  readonly type: 'text'
  readonly text: string
}

export interface PiToolResult {
  readonly content: PiToolContent[]
  readonly details: Record<string, unknown>
}

export interface PiTool {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly promptSnippet: string
  readonly parameters: unknown
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ): Promise<PiToolResult>
}

/** Resolved lazily so registration never triggers a connection. */
export type ContextProvider = () => ToolContext

export function toPiTool(definition: ToolDefinition, getContext: ContextProvider): PiTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    // Without promptSnippet, pi registers the tool but omits it from the
    // "Available tools" section of the system prompt — so the model never learns
    // it exists.
    promptSnippet: definition.summary,
    parameters: definition.parameters,

    async execute(_toolCallId, params, signal): Promise<PiToolResult> {
      if (signal?.aborted === true) {
        return { content: [{ type: 'text', text: 'Cancelled.' }], details: {} }
      }

      const result = await definition.handler(params as never, getContext())

      // pi sets isError on a tool result only for a *thrown* error; a returned
      // object is treated as success whatever it contains. Our tools return
      // errors as results deliberately, so the flag has to be converted here or
      // every failure would be reported to the model as a success.
      if (result.isError === true) {
        throw new Error(result.text)
      }

      return {
        content: [{ type: 'text', text: result.text }],
        // pi expects a details object; omitting it is not the same as an empty one.
        details: (result.details as Record<string, unknown>) ?? {},
      }
    },
  }
}

/** Render an unexpected error for a tool result, without leaking a stack trace. */
export function describeError(error: unknown): string {
  if (isAgentToolsError(error)) return error.toToolMessage()
  return error instanceof Error ? error.message : String(error)
}
