#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { closeAllSshSessions, loadConfig, SshRemoteOps } from '@agent-tools/core'
import {
  createToolContext,
  remoteExplorerTools,
  type ToolContext,
} from '@agent-tools/remote-explorer'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { callTool, listTools } from './adapter.js'

export const PACKAGE_NAME = '@agent-tools/mcp-remote-explorer'

export {
  type ContextProvider,
  callTool,
  describeError,
  type JsonSchemaObject,
  listTools,
  type McpContent,
  type McpToolDescriptor,
  type McpToolResult,
  toJsonSchema,
} from './adapter.js'

const SERVER_NAME = 'remote-explorer'
const SERVER_VERSION = '0.1.0'

/**
 * stdio MCP server exposing the remote explorer tools (ADR-003).
 *
 * Claude Code has no way to register a tool other than through MCP, so this is
 * what makes the tools callable there. Tool names are the bare `remote_*` ones;
 * Claude Code presents them as `mcp__remote-explorer__remote_ls` itself, and
 * pre-namespacing here would double the prefix.
 *
 * IMPORTANT: stdout is the protocol transport. Anything written to it that is not
 * a protocol message corrupts the stream, so diagnostics go to stderr only.
 */
export function createServer(getContext: () => ToolContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: listTools(remoteExplorerTools) }),
  )

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = await callTool(
      remoteExplorerTools,
      request.params.name,
      request.params.arguments,
      getContext,
    )
    // Rebuilt as a mutable object typed by the SDK: our ToolResult uses readonly
    // fields, which do not satisfy the SDK's result union.
    return {
      content: result.content.map((entry) => ({ type: entry.type, text: entry.text })),
      ...(result.isError === true ? { isError: true } : {}),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent as Record<string, unknown> }),
    }
  })

  return server
}

async function main(): Promise<void> {
  // Configuration is read once at startup. Unlike the pi adapter, this process
  // exists only to serve these tools, so failing loudly here is right — there is
  // no wider session to protect.
  const config = await loadConfig()
  const context = createToolContext({
    config,
    createOps: (host) => new SshRemoteOps({ host }),
  })

  const server = createServer(() => context)
  await server.connect(new StdioServerTransport())

  const shutdown = async (): Promise<void> => {
    await context.close()
    // Control sockets would otherwise outlive the process (ADR-008).
    await closeAllSshSessions()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/**
 * True when this module is the process entry point.
 *
 * Compares resolved paths rather than basenames: a basename check would also
 * match any other `index.js` that happened to be the entry point, and starting a
 * server on stdio during a test run would corrupt the test reporter's output.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`remote-explorer MCP server failed to start: ${String(error)}\n`)
    process.exit(1)
  })
}
