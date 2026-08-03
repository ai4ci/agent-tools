import {
  type AgentToolsConfig,
  closeAllSshSessions,
  type HostConfig,
  loadConfig,
  SshRemoteOps,
} from '@agent-tools/core'
import {
  createToolContext,
  remoteExplorerTools,
  type ToolContext,
} from '@agent-tools/remote-explorer'
import { type ContextProvider, describeError, type PiTool, toPiTool } from './adapter.js'

export const PACKAGE_NAME = '@agent-tools/pi-remote-explorer'

export { type ContextProvider, describeError, type PiTool, toPiTool } from './adapter.js'

/**
 * pi extension exposing the remote explorer tools (ADR-003).
 *
 * pi loads this module and calls the default export with its ExtensionAPI. The
 * API is typed structurally rather than imported, so this package does not take a
 * build dependency on pi itself; pi provides the real object at load time.
 */

interface ExtensionApi {
  registerTool(tool: PiTool): void
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void
}

/** Everything the extension holds for the lifetime of a pi session. */
export interface ExtensionState {
  readonly tools: readonly PiTool[]
  close(): Promise<void>
}

/**
 * Build the tools and their shared context.
 *
 * Configuration is read once, but lazily: a pi session that never calls a remote
 * tool should not pay for reading a config file, and a malformed config should
 * surface as a tool result the model can read rather than as a startup crash that
 * takes the whole session with it.
 */
export function createExtensionState(
  loader: () => Promise<AgentToolsConfig>,
  createOps: (host: HostConfig) => SshRemoteOps = (host) => new SshRemoteOps({ host }),
): ExtensionState {
  let context: ToolContext | undefined
  let loadFailure: unknown

  // Loading is asynchronous but the tool handlers need a synchronous context, so
  // the first load is kicked off eagerly and awaited by whichever handler runs
  // first. Failures are captured and rethrown per call.
  const loading = loader()
    .then((config) => {
      context = createToolContext({ config, createOps })
    })
    .catch((error: unknown) => {
      loadFailure = error
    })

  const provider: ContextProvider = () => {
    if (loadFailure !== undefined) {
      throw new Error(`Could not load agent-tools configuration: ${describeError(loadFailure)}`)
    }
    if (context === undefined) {
      // Reached only if a handler runs before the config file has been read.
      throw new Error('agent-tools configuration is still loading; retry the call.')
    }
    return context
  }

  return {
    tools: remoteExplorerTools.map((definition) => {
      const tool = toPiTool(definition, provider)
      return {
        ...tool,
        async execute(toolCallId, params, signal, onUpdate, extensionContext) {
          // Ensure configuration has been read before the first handler runs.
          await loading
          return tool.execute(toolCallId, params, signal, onUpdate, extensionContext)
        },
      }
    }),

    async close() {
      await loading
      await context?.close()
      // Control sockets outlive a single session otherwise, holding a connection
      // open on the remote (ADR-008).
      await closeAllSshSessions()
    },
  }
}

export default function extension(pi: ExtensionApi): void {
  const state = createExtensionState(() => loadConfig())

  for (const tool of state.tools) pi.registerTool(tool)

  // A pi session is long-lived and in-process, so a leaked control socket
  // persists for the whole session (ADR-003, ADR-008).
  pi.on('session_end', () => state.close())
}
