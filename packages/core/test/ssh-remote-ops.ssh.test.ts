import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicaliseWithinRoot, getHost, parseConfig, SshRemoteOps } from '@agent-tools/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Test tier 4 (ADR-011) — the full stack against a real sshd on localhost.
 *
 * This is the only tier that exercises escaping, sandboxing and transport
 * together, and therefore the only one that can catch a disagreement between
 * them. It is also the only tier that has never run in the development sandbox,
 * which has no sshd (ENV-003) — CI is where these first execute.
 *
 * Requires: sshd on localhost, passwordless key auth, bwrap with working user
 * namespaces. See .github/workflows/ci.yml.
 */

let ops: SshRemoteOps
let root: string

function makeOps(rootPath: string): SshRemoteOps {
  const identityFile = process.env.AGENT_TOOLS_TEST_SSH_KEY
  const config = parseConfig(
    {
      version: 1,
      hosts: {
        localhost: {
          ssh: {
            target: 'localhost',
            ...(identityFile === undefined ? {} : { identityFile }),
            options: { StrictHostKeyChecking: 'no', UserKnownHostsFile: '/dev/null' },
          },
          root: rootPath,
          limits: { timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
        },
      },
    },
    'tier-4-test',
  )
  return new SshRemoteOps({ host: getHost(config, 'localhost') })
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agent-tools-ssh-')))
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'sub', 'file.txt'), 'needle in the haystack\n')
  await writeFile(join(root, 'spaced name.txt'), 'spaced content\n')
  ops = makeOps(root)
})

afterAll(async () => {
  await ops?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('connection and probe', () => {
  it('resolves the root over SSH', async () => {
    expect(await ops.root()).toBe(root)
  })

  it('reports a sandbox, since the host would otherwise be refused', async () => {
    expect((await ops.capabilities()).hasSandbox).toBe(true)
  })

  it('discovers search tools', async () => {
    expect((await ops.capabilities()).tools.has('grep')).toBe(true)
  })
})

describe('command execution end to end', () => {
  it('runs a command and returns stdout', async () => {
    const result = await ops.exec(['grep', '-r', 'needle', '.'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('needle')
  })

  it('returns a non-zero exit code as a result, not an error', async () => {
    const result = await ops.exec(['grep', '-r', 'no-such-content-anywhere', '.'])
    expect(result.exitCode).toBe(1)
  })

  it('survives arguments the remote shell would otherwise interpret', async () => {
    // The whole escaping story, verified against a genuine remote shell rather
    // than the tier 2 bash harness.
    const result = await ops.exec(['printf', '%s', '$HOME; echo pwned `id` && rm -rf /'])
    expect(result.stdout).toBe('$HOME; echo pwned `id` && rm -rf /')
  })

  it('handles paths containing spaces', async () => {
    const result = await ops.exec(['cat', './spaced name.txt'])
    expect(result.stdout).toBe('spaced content\n')
  })

  it('does not glob arguments on the remote', async () => {
    const result = await ops.exec(['printf', '%s', '*.txt'])
    expect(result.stdout).toBe('*.txt')
  })
})

describe('sandbox holds over SSH', () => {
  it('refuses a write to the root', async () => {
    const result = await ops.exec(['sh', '-c', 'echo mutated > ./sub/file.txt'])
    expect(result.exitCode).not.toBe(0)
  })

  it('blocks outbound network access', async () => {
    const result = await ops.exec(['sh', '-c', 'cat < /dev/tcp/1.1.1.1/53'])
    expect(result.exitCode).not.toBe(0)
  })

  it('hides paths outside the root', async () => {
    const result = await ops.exec(['ls', '/home'])
    expect(result.exitCode).not.toBe(0)
  })
})

describe('containment over SSH', () => {
  it('rejects a symlink that escapes the root', async () => {
    await symlink('/etc/hostname', join(root, 'escape'))
    const exec = (argv: readonly string[]) => ops.exec(argv)
    const capabilities = await ops.capabilities()

    await expect(
      canonicaliseWithinRoot(exec, root, 'escape', capabilities.tools.has('realpath')),
    ).rejects.toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }))
  })

  it('rejects lexical traversal', async () => {
    const exec = (argv: readonly string[]) => ops.exec(argv)
    await expect(canonicaliseWithinRoot(exec, root, '../..', true)).rejects.toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
    )
  })
})

describe('failure handling', () => {
  it('reports an unreachable host rather than hanging', async () => {
    const config = parseConfig(
      {
        version: 1,
        hosts: {
          nope: {
            ssh: {
              target: 'localhost',
              port: 1,
              options: { StrictHostKeyChecking: 'no', UserKnownHostsFile: '/dev/null' },
            },
            root: '/tmp',
          },
        },
      },
      'tier-4-test',
    )
    const bad = new SshRemoteOps({
      host: getHost(config, 'nope'),
      connectTimeoutSeconds: 3,
      multiplex: false,
    })

    try {
      await expect(bad.root()).rejects.toThrow(
        expect.objectContaining({ code: 'HOST_UNREACHABLE' }),
      )
    } finally {
      await bad.close()
    }
  })

  it('refuses a root that does not exist', async () => {
    const bad = makeOps('/nonexistent-root-path')
    try {
      await expect(bad.root()).rejects.toThrow(expect.objectContaining({ code: 'PROBE_FAILED' }))
    } finally {
      await bad.close()
    }
  })
})

describe('session lifecycle', () => {
  it('reuses one probe across calls rather than probing per command', async () => {
    const session = makeOps(root)
    try {
      const [a, b] = await Promise.all([session.root(), session.root()])
      expect(a).toBe(b)
    } finally {
      await session.close()
    }
  })

  it('tolerates being closed twice', async () => {
    const session = makeOps(root)
    await session.close()
    await expect(session.close()).resolves.toBeUndefined()
  })

  it('refuses to execute after close', async () => {
    const session = makeOps(root)
    await session.close()
    await expect(session.exec(['true'])).rejects.toThrow(
      expect.objectContaining({ code: 'REMOTE_COMMAND_FAILED' }),
    )
  })
})
