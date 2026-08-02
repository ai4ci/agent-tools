import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentToolsError, getHost, loadConfig, parseConfig } from '@agent-tools/core'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Host configuration (ADR-004).
 *
 * The agent supplies an alias and nothing else, so this file is the entire
 * boundary of where the tools can reach. Validation errors are read by an
 * operator, so they must name the offending field; unknown-alias errors are read
 * by a model, so they must list what is available.
 */

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-tools-config-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

const VALID = {
  version: 1,
  hosts: {
    'prod-web': {
      ssh: { target: 'deploy@web1.example.com' },
      root: '/srv/app',
    },
  },
}

describe('parseConfig', () => {
  it('accepts a minimal valid config', () => {
    const config = parseConfig(VALID, 'test')
    const host = getHost(config, 'prod-web')
    expect(host.alias).toBe('prod-web')
    expect(host.ssh.target).toBe('deploy@web1.example.com')
    expect(host.root).toBe('/srv/app')
  })

  it('applies default limits when none are given', () => {
    const host = getHost(parseConfig(VALID, 'test'), 'prod-web')
    expect(host.limits.timeoutMs).toBeGreaterThan(0)
    expect(host.limits.maxOutputBytes).toBeGreaterThan(0)
  })

  it('carries explicit limits through', () => {
    const config = parseConfig(
      {
        version: 1,
        hosts: {
          h: {
            ssh: { target: 'a@b' },
            root: '/r',
            limits: { timeoutMs: 5000, maxOutputBytes: 2048 },
          },
        },
      },
      'test',
    )
    expect(getHost(config, 'h').limits).toEqual({ timeoutMs: 5000, maxOutputBytes: 2048 })
  })

  it('accepts optional ssh port, identity file, and extra options', () => {
    const config = parseConfig(
      {
        version: 1,
        hosts: {
          h: {
            ssh: {
              target: 'a@b',
              port: 2222,
              identityFile: '/home/me/.ssh/id_ed25519',
              options: { StrictHostKeyChecking: 'yes' },
            },
            root: '/r',
          },
        },
      },
      'test',
    )
    const { ssh } = getHost(config, 'h')
    expect(ssh.port).toBe(2222)
    expect(ssh.identityFile).toBe('/home/me/.ssh/id_ed25519')
    expect(ssh.options).toEqual({ StrictHostKeyChecking: 'yes' })
  })

  describe('root values', () => {
    const accepted = ['/srv/app', '/', '$HOME', '${PROJECTDIR}', '$PROJECT_DIR_2']

    for (const root of accepted) {
      it(`accepts ${root}`, () => {
        const config = parseConfig(
          { version: 1, hosts: { h: { ssh: { target: 'a@b' }, root } } },
          'test',
        )
        expect(getHost(config, 'h').root).toBe(root)
      })
    }

    // The probe must expand a variable root on the remote, which means the probe
    // command contains an unquoted expansion. Restricting roots to a bare
    // variable name is what keeps that safe (ADR-007).
    const rejected = [
      'relative/path',
      '$(whoami)',
      '`whoami`',
      '$HOME; rm -rf /',
      '${HOME:-/etc}',
      '$HOME/sub',
      '',
      '$',
    ]

    for (const root of rejected) {
      it(`rejects ${JSON.stringify(root)}`, () => {
        expect(() =>
          parseConfig({ version: 1, hosts: { h: { ssh: { target: 'a@b' }, root } } }, 'test'),
        ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }))
      })
    }
  })

  describe('rejections', () => {
    const bad: Array<[name: string, value: unknown]> = [
      ['a non-object', 42],
      ['null', null],
      ['a missing version', { hosts: {} }],
      ['an unsupported version', { version: 99, hosts: {} }],
      ['missing hosts', { version: 1 }],
      ['hosts as an array', { version: 1, hosts: [] }],
      ['a host without ssh', { version: 1, hosts: { h: { root: '/r' } } }],
      ['a host without a root', { version: 1, hosts: { h: { ssh: { target: 'a@b' } } } }],
      ['an empty ssh target', { version: 1, hosts: { h: { ssh: { target: '' }, root: '/r' } } }],
      [
        'a non-integer port',
        { version: 1, hosts: { h: { ssh: { target: 'a@b', port: 1.5 }, root: '/r' } } },
      ],
      [
        'an out-of-range port',
        { version: 1, hosts: { h: { ssh: { target: 'a@b', port: 70000 }, root: '/r' } } },
      ],
      [
        'a negative timeout',
        {
          version: 1,
          hosts: { h: { ssh: { target: 'a@b' }, root: '/r', limits: { timeoutMs: -1 } } },
        },
      ],
      ['an unknown top-level field', { version: 1, hosts: {}, extra: true }],
      [
        'an unknown host field',
        { version: 1, hosts: { h: { ssh: { target: 'a@b' }, root: '/r', sandbox: 'off' } } },
      ],
    ]

    for (const [name, value] of bad) {
      it(`rejects ${name}`, () => {
        expect(() => parseConfig(value, 'test')).toThrow(
          expect.objectContaining({ code: 'CONFIG_INVALID' }),
        )
      })
    }

    it('names the offending field and the source in the message', () => {
      try {
        parseConfig({ version: 1, hosts: { h: { ssh: { target: 'a@b' } } } }, '/etc/x.json')
        expect.unreachable('should have thrown')
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain('root')
        expect(message).toContain('/etc/x.json')
      }
    })
  })
})

describe('getHost', () => {
  it('rejects an unknown alias and lists the known ones', () => {
    const config = parseConfig(VALID, 'test')
    try {
      getHost(config, 'staging')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('UNKNOWN_HOST')
      // A model that guessed wrong must be able to correct itself from the error
      // alone, rather than falling through to a live SSH attempt (ADR-004).
      // toToolMessage() is the rendering the model actually receives.
      expect((error as AgentToolsError).toToolMessage()).toContain('prod-web')
    }
  })

  it('does not treat an inherited object property as a host', () => {
    const config = parseConfig(VALID, 'test')
    expect(() => getHost(config, 'toString')).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_HOST' }),
    )
  })
})

describe('loadConfig', () => {
  it('reads an explicitly specified file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify(VALID))
    const config = await loadConfig({ explicitPath: path })
    expect(getHost(config, 'prod-web').root).toBe('/srv/app')
  })

  it('fails when the explicit file is missing', async () => {
    await expect(loadConfig({ explicitPath: '/nonexistent/config.json' })).rejects.toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    )
  })

  it('reports malformed JSON as a config error rather than a syntax error', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.json')
    await writeFile(path, '{ not json')
    await expect(loadConfig({ explicitPath: path })).rejects.toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    )
  })

  it('discovers a project config under .agent-tools/', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, '.agent-tools'), { recursive: true })
    await writeFile(join(dir, '.agent-tools', 'config.json'), JSON.stringify(VALID))
    const config = await loadConfig({ cwd: dir, home: await tempDir() })
    expect(getHost(config, 'prod-web')).toBeDefined()
  })

  it('merges user and project configs, with project winning per alias', async () => {
    const home = await tempDir()
    const cwd = await tempDir()

    await mkdir(join(home, '.config', 'agent-tools'), { recursive: true })
    await writeFile(
      join(home, '.config', 'agent-tools', 'config.json'),
      JSON.stringify({
        version: 1,
        hosts: {
          shared: { ssh: { target: 'user@user-host' }, root: '/user' },
          'user-only': { ssh: { target: 'a@b' }, root: '/u' },
        },
      }),
    )

    await mkdir(join(cwd, '.agent-tools'), { recursive: true })
    await writeFile(
      join(cwd, '.agent-tools', 'config.json'),
      JSON.stringify({
        version: 1,
        hosts: { shared: { ssh: { target: 'proj@proj-host' }, root: '/proj' } },
      }),
    )

    const config = await loadConfig({ cwd, home })
    expect(getHost(config, 'shared').ssh.target).toBe('proj@proj-host')
    expect(getHost(config, 'user-only').ssh.target).toBe('a@b')
  })

  it('ignores ambient XDG_CONFIG_HOME when an explicit home is given', async () => {
    // Regression. An explicit `home` must scope discovery completely, or a
    // caller that believes it has isolated itself silently reads the real user's
    // configuration. Found on a CI runner that sets XDG_CONFIG_HOME where the
    // development machine does not, so it passed locally and failed there.
    const home = await tempDir()
    const decoy = await tempDir()

    await mkdir(join(home, '.config', 'agent-tools'), { recursive: true })
    await writeFile(
      join(home, '.config', 'agent-tools', 'config.json'),
      JSON.stringify({
        version: 1,
        hosts: { 'from-home': { ssh: { target: 'a@b' }, root: '/h' } },
      }),
    )

    await mkdir(join(decoy, 'agent-tools'), { recursive: true })
    await writeFile(
      join(decoy, 'agent-tools', 'config.json'),
      JSON.stringify({
        version: 1,
        hosts: { 'from-decoy': { ssh: { target: 'a@b' }, root: '/d' } },
      }),
    )

    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = decoy
    try {
      const config = await loadConfig({ cwd: await tempDir(), home })
      expect(getHost(config, 'from-home')).toBeDefined()
      expect(() => getHost(config, 'from-decoy')).toThrow()
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })

  it('honours XDG_CONFIG_HOME when no explicit home is given', async () => {
    const xdg = await tempDir()
    await mkdir(join(xdg, 'agent-tools'), { recursive: true })
    await writeFile(
      join(xdg, 'agent-tools', 'config.json'),
      JSON.stringify({
        version: 1,
        hosts: { 'from-xdg': { ssh: { target: 'a@b' }, root: '/x' } },
      }),
    )

    const config = await loadConfig({ cwd: await tempDir(), xdgConfigHome: xdg })
    expect(getHost(config, 'from-xdg')).toBeDefined()
  })

  it('returns an empty host set when no config exists anywhere', async () => {
    const config = await loadConfig({ cwd: await tempDir(), home: await tempDir() })
    expect(config.hosts.size).toBe(0)
  })

  it('reports which files it read, so an operator can see what took effect', async () => {
    const dir = await tempDir()
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify(VALID))
    const config = await loadConfig({ explicitPath: path })
    expect(config.sources).toEqual([path])
  })
})
