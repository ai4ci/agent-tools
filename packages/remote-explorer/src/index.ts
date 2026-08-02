export const PACKAGE_NAME = '@agent-tools/remote-explorer'

export {
  type CreateToolContextOptions,
  createToolContext,
  type HostSession,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  toolError,
} from './tool.js'
export { remoteHosts } from './tools/remote-hosts.js'
export {
  type DirectoryEntry,
  type EntryType,
  parseLsOutput,
  remoteLs,
} from './tools/remote-ls.js'

import type { ToolDefinition } from './tool.js'
import { remoteHosts } from './tools/remote-hosts.js'
import { remoteLs } from './tools/remote-ls.js'

/** Every tool in this collection, for an adapter to register in one pass. */
export const remoteExplorerTools: readonly ToolDefinition[] = [remoteHosts, remoteLs]
