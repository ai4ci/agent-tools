export const PACKAGE_NAME = '@agent-tools/core'

export {
  AgentToolsError,
  type AgentToolsErrorCode,
  type AgentToolsErrorOptions,
  invalidArgument,
  isAgentToolsError,
} from './errors.js'
export { resolveWithinRoot } from './paths.js'
export { shellJoin, shellQuote } from './shell.js'
