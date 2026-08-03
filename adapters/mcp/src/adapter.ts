import { isAgentToolsError } from '@agent-tools/core'
import type { ToolContext, ToolDefinition } from '@agent-tools/remote-explorer'

/**
 * Mapping from tool definitions to MCP (ADR-002, ADR-003).
 *
 * The instructive difference from the pi adapter is error handling, and the two
 * are exact opposites. pi flags a failure only when `execute` throws, and treats
 * a returned object as success. MCP carries `isError` on the result itself, and a
 * thrown error becomes a *protocol* error rather than a tool failure the model can
 * read. So the same `ToolResult` maps one way here and the other way there —
 * neither adapter's approach would work for the other host.
 */

export interface McpContent {
  readonly type: 'text'
  readonly text: string
}

export interface McpToolResult {
  readonly content: McpContent[]
  readonly isError?: boolean
  /** Structured payload, for hosts that read it. */
  readonly structuredContent?: unknown
}

export interface McpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
}

export interface JsonSchemaObject {
  readonly type: string
  readonly properties?: unknown
  readonly required?: string[]
  readonly [key: string]: unknown
}

export type ContextProvider = () => ToolContext

/**
 * Convert a TypeBox schema to plain JSON Schema.
 *
 * TypeBox schemas already *are* JSON Schema, and its internal `~kind` marker is
 * non-enumerable so it does not survive serialisation. The conversion is still
 * explicit rather than a bare pass-through: relying on that non-enumerability
 * silently would break if TypeBox changed it, and MCP puts this on the wire as
 * JSON, so anything that does not round trip is lost in transit anyway. Doing the
 * round trip here means what the tests check is what the client receives.
 */
export function toJsonSchema(schema: object): JsonSchemaObject {
  return JSON.parse(JSON.stringify(schema)) as JsonSchemaObject
}

/** Build the MCP tool list. Names stay bare; the host adds its own namespace. */
export function listTools(definitions: readonly ToolDefinition[]): McpToolDescriptor[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: toJsonSchema(definition.parameters),
  }))
}

/** Dispatch a tool call, rendering every failure as an error result. */
export async function callTool(
  definitions: readonly ToolDefinition[],
  name: string,
  args: unknown,
  getContext: ContextProvider,
): Promise<McpToolResult> {
  const definition = definitions.find((entry) => entry.name === name)

  if (definition === undefined) {
    const available = definitions.map((entry) => entry.name).join(', ')
    return {
      content: [
        { type: 'text', text: `Unknown tool ${JSON.stringify(name)}. Available: ${available}.` },
      ],
      isError: true,
    }
  }

  try {
    const result = await definition.handler((args ?? {}) as never, getContext())
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.isError === true ? { isError: true } : {}),
      ...(result.details === undefined ? {} : { structuredContent: result.details }),
    }
  } catch (error) {
    // Returned rather than rethrown: a throw here becomes a protocol-level error,
    // which the model cannot see or act on. Only the taxonomy's message and remedy
    // are exposed — never a stack trace, which would put internal paths into a
    // transcript.
    return {
      content: [{ type: 'text', text: describeError(error) }],
      isError: true,
    }
  }
}

export function describeError(error: unknown): string {
  if (isAgentToolsError(error)) return error.toToolMessage()
  return error instanceof Error ? error.message : String(error)
}
