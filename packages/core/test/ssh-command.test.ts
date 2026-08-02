import {
  buildSshCommand,
  controlPathFor,
  getHost,
  type HostConfig,
  parseConfig,
} from '@agent-tools/core'
import { describe, expect, it } from 'vitest'

/**
 * SSH invocation construction (ADR-008).
 *
 * Tier 1 covers the argv we hand to `ssh`. Whether the connection then works is
 * tier 4, which needs an sshd and is CI-only here (ENV-003) — but a wrong flag
 * set fails identically on every host, so it is worth pinning down cheaply.
 */

function host(overrides: Record<string, unknown> = {}): HostConfig {
  return getHost(
    parseConfig(
      {
        version: 1,
        hosts: { h: { ssh: { target: 'deploy@example.com', ...overrides }, root: '/srv' } },
      },
      'test',
    ),
    'h',
  )
}

describe('buildSshCommand', () => {
  it('invokes ssh with the target and the remote command last', () => {
    const argv = buildSshCommand({ host: host(), remoteCommand: "'ls' '-la'" })
    expect(argv[0]).toBe('ssh')
    expect(argv.at(-1)).toBe("'ls' '-la'")
    expect(argv.at(-2)).toBe('deploy@example.com')
  })

  it('passes the remote command as a single argv element', () => {
    // If this were split, the local execFile would hand ssh several arguments and
    // ssh would join them with spaces, changing the command the remote sees.
    const remoteCommand = "'grep' '-r' 'two words' '.'"
    const argv = buildSshCommand({ host: host(), remoteCommand })
    expect(argv.filter((entry) => entry === remoteCommand)).toHaveLength(1)
  })

  it('disables password prompts so a missing key fails fast', () => {
    const argv = buildSshCommand({ host: host(), remoteCommand: 'true' })
    expect(argv).toContain('BatchMode=yes')
  })

  it('sets a connect timeout', () => {
    const argv = buildSshCommand({
      host: host(),
      remoteCommand: 'true',
      connectTimeoutSeconds: 7,
    })
    expect(argv).toContain('ConnectTimeout=7')
  })

  it('requests no pseudo-terminal', () => {
    expect(buildSshCommand({ host: host(), remoteCommand: 'true' })).toContain('-T')
  })

  it('adds the port only when configured', () => {
    expect(buildSshCommand({ host: host(), remoteCommand: 'true' })).not.toContain('-p')
    const argv = buildSshCommand({ host: host({ port: 2222 }), remoteCommand: 'true' })
    expect(argv).toContain('-p')
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222')
  })

  it('adds the identity file only when configured', () => {
    expect(buildSshCommand({ host: host(), remoteCommand: 'true' })).not.toContain('-i')
    const argv = buildSshCommand({
      host: host({ identityFile: '/keys/id_ed25519' }),
      remoteCommand: 'true',
    })
    expect(argv[argv.indexOf('-i') + 1]).toBe('/keys/id_ed25519')
  })

  it('enables connection multiplexing when given a control path', () => {
    const argv = buildSshCommand({
      host: host(),
      remoteCommand: 'true',
      controlPath: '/tmp/socket',
    })
    expect(argv).toContain('ControlMaster=auto')
    expect(argv).toContain('ControlPath=/tmp/socket')
    expect(argv.some((entry) => entry.startsWith('ControlPersist='))).toBe(true)
  })

  it('omits multiplexing entirely when no control path is given', () => {
    const argv = buildSshCommand({ host: host(), remoteCommand: 'true' })
    expect(argv.some((entry) => entry.startsWith('Control'))).toBe(false)
  })

  it('places configured options before our defaults so the operator wins', () => {
    // ssh uses the *first* value it obtains for an option, so precedence here is
    // positional. An operator setting BatchMode=no must actually take effect.
    const argv = buildSshCommand({
      host: host({ options: { BatchMode: 'no' } }),
      remoteCommand: 'true',
    })
    expect(argv.indexOf('BatchMode=no')).toBeLessThan(argv.indexOf('BatchMode=yes'))
  })

  it('passes configured options as separate -o arguments', () => {
    const argv = buildSshCommand({
      host: host({ options: { StrictHostKeyChecking: 'yes', ServerAliveInterval: '30' } }),
      remoteCommand: 'true',
    })
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('ServerAliveInterval=30')
  })

  it('rejects a target that could be read as an ssh flag', () => {
    expect(() =>
      buildSshCommand({
        host: host({ target: '-oProxyCommand=touch /tmp/x' }),
        remoteCommand: 'true',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('rejects an empty remote command', () => {
    expect(() => buildSshCommand({ host: host(), remoteCommand: '' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })
})

describe('controlPathFor', () => {
  it('produces an absolute path', () => {
    expect(controlPathFor('prod', 'deploy@example.com').startsWith('/')).toBe(true)
  })

  it('differs per host so two hosts cannot share a socket', () => {
    expect(controlPathFor('a', 'x@h1')).not.toBe(controlPathFor('b', 'x@h2'))
  })

  it('is stable for the same host within a process', () => {
    expect(controlPathFor('a', 'x@h')).toBe(controlPathFor('a', 'x@h'))
  })

  it('stays within the unix socket path length limit', () => {
    // A unix domain socket path is capped near 104 bytes on some platforms, and
    // ssh fails obscurely when it is exceeded — so the alias must not be
    // interpolated raw.
    const path = controlPathFor('a-very-long-alias-'.repeat(10), 'user@some.very.long.hostname')
    expect(path.length).toBeLessThan(100)
  })

  it('contains no path separators from the alias', () => {
    expect(controlPathFor('../escape', 'u@h')).not.toContain('..')
  })
})
