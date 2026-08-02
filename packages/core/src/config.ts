import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentToolsError } from './errors.js'
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from './remote-ops.js'

/**
 * Host configuration (ADR-004).
 *
 * The model supplies an alias and never an SSH target, so this file is the whole
 * boundary of where the tools can reach. Adding a host is a deliberate human act;
 * nothing here is ever written by a tool.
 *
 * Validation is hand-written rather than delegated to a schema library. The error
 * messages are the point — an operator needs to be told which field of which file
 * is wrong — and a dependency-free core keeps the pi extension light.
 */

export const CONFIG_VERSION = 1

/**
 * A root is either a literal absolute path or a bare shell variable reference.
 *
 * The restriction matters for safety, not tidiness. Only the remote login shell
 * can expand `$PROJECTDIR`, so the probe command necessarily contains an
 * unquoted expansion (ADR-007). Confining roots to a bare variable name means
 * that expansion cannot become command substitution: `$(whoami)`, `${HOME:-/etc}`
 * and `$HOME; rm -rf /` are all rejected here rather than executed there.
 */
const VARIABLE_ROOT = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/

export interface SshConfig {
  readonly target: string
  readonly port?: number
  readonly identityFile?: string
  /** Extra `-o Key=Value` pairs passed to ssh verbatim. */
  readonly options?: Readonly<Record<string, string>>
}

export interface HostLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface HostConfig {
  readonly alias: string
  readonly ssh: SshConfig
  /** Absolute path, or a bare variable to expand on the remote (ADR-007). */
  readonly root: string
  readonly limits: HostLimits
}

export interface AgentToolsConfig {
  readonly hosts: ReadonlyMap<string, HostConfig>
  /** Files that contributed, in the order applied. */
  readonly sources: readonly string[]
}

function fail(source: string, detail: string): never {
  throw new AgentToolsError('CONFIG_INVALID', `Invalid configuration in ${source}: ${detail}`, {
    remedy: 'Correct the configuration file and retry.',
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(
  source: string,
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(source, `${where} has unknown field ${JSON.stringify(key)}`)
    }
  }
}

function validateSshOptions(source: string, alias: string, options: unknown): void {
  if (!isPlainObject(options)) {
    fail(source, `host ${JSON.stringify(alias)} field "ssh.options" must be an object`)
  }
  for (const [key, entry] of Object.entries(options)) {
    if (typeof entry !== 'string') {
      fail(source, `host ${JSON.stringify(alias)} field "ssh.options.${key}" must be a string`)
    }
  }
}

function parseSsh(source: string, alias: string, value: unknown): SshConfig {
  if (!isPlainObject(value))
    fail(source, `host ${JSON.stringify(alias)} field "ssh" must be an object`)
  rejectUnknownKeys(source, `host ${JSON.stringify(alias)} field "ssh"`, value, [
    'target',
    'port',
    'identityFile',
    'options',
  ])

  const { target, port, identityFile, options } = value

  if (typeof target !== 'string' || target.length === 0) {
    fail(source, `host ${JSON.stringify(alias)} field "ssh.target" must be a non-empty string`)
  }

  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    fail(source, `host ${JSON.stringify(alias)} field "ssh.port" must be an integer 1-65535`)
  }

  if (identityFile !== undefined && typeof identityFile !== 'string') {
    fail(source, `host ${JSON.stringify(alias)} field "ssh.identityFile" must be a string`)
  }

  if (options !== undefined) validateSshOptions(source, alias, options)

  return {
    target,
    ...(port === undefined ? {} : { port: port as number }),
    ...(identityFile === undefined ? {} : { identityFile: identityFile as string }),
    ...(options === undefined ? {} : { options: options as Record<string, string> }),
  }
}

function parseLimits(source: string, alias: string, value: unknown): HostLimits {
  if (value === undefined) {
    return { timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES }
  }
  if (!isPlainObject(value)) {
    fail(source, `host ${JSON.stringify(alias)} field "limits" must be an object`)
  }
  rejectUnknownKeys(source, `host ${JSON.stringify(alias)} field "limits"`, value, [
    'timeoutMs',
    'maxOutputBytes',
  ])

  const read = (key: 'timeoutMs' | 'maxOutputBytes', fallback: number): number => {
    const entry = value[key]
    if (entry === undefined) return fallback
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry <= 0) {
      fail(source, `host ${JSON.stringify(alias)} field "limits.${key}" must be a positive integer`)
    }
    return entry
  }

  return {
    timeoutMs: read('timeoutMs', DEFAULT_TIMEOUT_MS),
    maxOutputBytes: read('maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES),
  }
}

function parseHost(source: string, alias: string, value: unknown): HostConfig {
  if (!isPlainObject(value)) fail(source, `host ${JSON.stringify(alias)} must be an object`)
  rejectUnknownKeys(source, `host ${JSON.stringify(alias)}`, value, ['ssh', 'root', 'limits'])

  const { ssh, root, limits } = value

  if (ssh === undefined)
    fail(source, `host ${JSON.stringify(alias)} is missing required field "ssh"`)
  if (root === undefined)
    fail(source, `host ${JSON.stringify(alias)} is missing required field "root"`)

  if (typeof root !== 'string' || (!root.startsWith('/') && !VARIABLE_ROOT.test(root))) {
    fail(
      source,
      `host ${JSON.stringify(alias)} field "root" must be an absolute path or a bare variable ` +
        `such as "$PROJECTDIR"; got ${JSON.stringify(root)}`,
    )
  }

  return {
    alias,
    ssh: parseSsh(source, alias, ssh),
    root,
    limits: parseLimits(source, alias, limits),
  }
}

/** Validate an already-parsed JSON value. `source` appears in error messages. */
export function parseConfig(raw: unknown, source: string): AgentToolsConfig {
  if (!isPlainObject(raw)) fail(source, 'the top level must be an object')
  rejectUnknownKeys(source, 'the top level', raw, ['version', 'hosts'])

  const { version, hosts } = raw

  if (version === undefined) fail(source, 'missing required field "version"')
  if (version !== CONFIG_VERSION) {
    fail(source, `unsupported "version" ${JSON.stringify(version)}; expected ${CONFIG_VERSION}`)
  }
  if (hosts === undefined) fail(source, 'missing required field "hosts"')
  if (!isPlainObject(hosts)) fail(source, 'field "hosts" must be an object keyed by alias')

  const parsed = new Map<string, HostConfig>()
  for (const [alias, host] of Object.entries(hosts)) {
    parsed.set(alias, parseHost(source, alias, host))
  }

  return { hosts: parsed, sources: [source] }
}

/**
 * Look up a host by alias.
 *
 * An unknown alias never falls through to a live SSH attempt (ADR-004). The error
 * lists the known aliases because a model that guessed wrong has to be able to
 * correct itself from the error alone.
 */
export function getHost(config: AgentToolsConfig, alias: string): HostConfig {
  const host = config.hosts.get(alias)
  if (host !== undefined) return host

  const known = [...config.hosts.keys()].sort()
  const available = known.length === 0 ? '(none configured)' : known.join(', ')
  throw new AgentToolsError('UNKNOWN_HOST', `Unknown host alias ${JSON.stringify(alias)}.`, {
    remedy: `Configured hosts: ${available}.`,
  })
}

export interface LoadConfigOptions {
  /** Use exactly this file. Missing or malformed is an error, not a fallback. */
  readonly explicitPath?: string
  readonly cwd?: string
  readonly home?: string
  /** Overrides the user-level directory. Defaults to `$XDG_CONFIG_HOME`. */
  readonly xdgConfigHome?: string
}

async function readIfPresent(path: string): Promise<AgentToolsConfig | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new AgentToolsError('CONFIG_INVALID', `Could not read configuration at ${path}.`, {
      cause: error,
    })
  }
  return parseText(text, path)
}

function parseText(text: string, source: string): AgentToolsConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new AgentToolsError(
      'CONFIG_INVALID',
      `Configuration at ${source} is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    )
  }
  return parseConfig(raw, source)
}

/**
 * Discover and merge configuration.
 *
 * Precedence, lowest first: the user-level file, then the project-level file.
 * Merging is per alias, so a project may override a shared host definition
 * without having to restate the rest of them.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentToolsConfig> {
  if (options.explicitPath !== undefined) {
    const loaded = await readIfPresent(options.explicitPath)
    if (loaded === undefined) {
      throw new AgentToolsError(
        'CONFIG_INVALID',
        `Configuration file not found: ${options.explicitPath}`,
        { remedy: 'Create the file or omit the explicit path.' },
      )
    }
    return loaded
  }

  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()

  // An explicitly supplied `home` scopes discovery completely: ambient
  // XDG_CONFIG_HOME must not reach past it. Consulting the environment first
  // meant a caller that thought it had isolated discovery silently read the real
  // user's configuration instead — which is how this was found, on a CI runner
  // that sets XDG_CONFIG_HOME where the development machine does not.
  const xdg =
    options.xdgConfigHome ??
    (options.home === undefined
      ? (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
      : join(options.home, '.config'))

  const candidates = [
    join(xdg, 'agent-tools', 'config.json'),
    join(cwd, '.agent-tools', 'config.json'),
  ]

  const hosts = new Map<string, HostConfig>()
  const sources: string[] = []

  for (const candidate of candidates) {
    const loaded = await readIfPresent(candidate)
    if (loaded === undefined) continue
    for (const [alias, host] of loaded.hosts) hosts.set(alias, host)
    sources.push(candidate)
  }

  return { hosts, sources }
}
