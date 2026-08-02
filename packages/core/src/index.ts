export const PACKAGE_NAME = '@agent-tools/core'

export {
  type AgentToolsConfig,
  CONFIG_VERSION,
  getHost,
  type HostConfig,
  type HostLimits,
  type LoadConfigOptions,
  loadConfig,
  parseConfig,
  type SshConfig,
} from './config.js'
export {
  AgentToolsError,
  type AgentToolsErrorCode,
  type AgentToolsErrorOptions,
  invalidArgument,
  isAgentToolsError,
} from './errors.js'
export { resolveWithinRoot } from './paths.js'
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type ExecOptions,
  type ExecResult,
  type RemoteCapabilities,
  type RemoteOps,
  truncateToBytes,
} from './remote-ops.js'
export { shellJoin, shellQuote } from './shell.js'
export {
  type BuildSshCommandOptions,
  buildSshCommand,
  controlPathFor,
} from './ssh-command.js'
