export const PACKAGE_NAME = '@agent-tools/remote-explorer'

export { stringEnum } from './schema.js'
export {
  type CreateToolContextOptions,
  createToolContext,
  type HostSession,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  toolError,
} from './tool.js'
export { remoteFind } from './tools/remote-find.js'
export { buildSearchArgv, remoteGrep } from './tools/remote-grep.js'
export { remoteHosts } from './tools/remote-hosts.js'
export {
  type DirectoryEntry,
  type EntryType,
  parseLsOutput,
  remoteLs,
} from './tools/remote-ls.js'
export { remoteRead } from './tools/remote-read.js'
export { parseStatOutput, remoteStat, type StatDetails } from './tools/remote-stat.js'

import type { ToolDefinition } from './tool.js'
import { remoteFind } from './tools/remote-find.js'
import { remoteGrep } from './tools/remote-grep.js'
import { remoteHosts } from './tools/remote-hosts.js'
import { remoteLs } from './tools/remote-ls.js'
import { remoteRead } from './tools/remote-read.js'
import { remoteStat } from './tools/remote-stat.js'

/** Every tool in this collection, for an adapter to register in one pass. */
export const remoteExplorerTools: readonly ToolDefinition[] = [
  remoteHosts,
  remoteLs,
  remoteStat,
  remoteFind,
  remoteGrep,
  remoteRead,
]
