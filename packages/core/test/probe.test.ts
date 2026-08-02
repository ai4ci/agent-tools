import { buildProbeScript, parseProbeOutput, probeHost } from '@agent-tools/core'
import { describe, expect, it, vi } from 'vitest'

/**
 * Host probe (ADR-007, ADR-012).
 *
 * The probe runs before any sandbox exists — bwrap cannot be configured until the
 * root is known — so its content must contain nothing model-derived. It is built
 * purely from configuration, and the root expression is already restricted by
 * config validation to an absolute path or a bare variable.
 */

describe('buildProbeScript', () => {
  it('expands a variable root, since only the remote shell can', () => {
    const script = buildProbeScript('$PROJECTDIR')
    expect(script).toContain('$PROJECTDIR')
  })

  it('embeds a literal root', () => {
    expect(buildProbeScript('/srv/app')).toContain('/srv/app')
  })

  it('canonicalises the root rather than reporting it verbatim', () => {
    const script = buildProbeScript('/srv/app')
    expect(script).toMatch(/pwd -P|realpath/)
  })

  it('attempts a real namespace rather than testing for the binary', () => {
    // ENV-005 / ADR-012 finding 5. A hardened host ships bwrap and refuses the
    // unshare, so `command -v bwrap` reports a sandbox that does not exist.
    const script = buildProbeScript('/srv/app')
    expect(script).toContain('--unshare-net')
  })

  it('rejects a root expression that config validation would not have allowed', () => {
    // Defence in depth: the probe is the one command containing an unquoted
    // expansion, so it re-checks rather than trusting its caller.
    for (const bad of ['$(whoami)', '`id`', '$HOME; rm -rf /', 'relative']) {
      expect(() => buildProbeScript(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      )
    }
  })
})

describe('parseProbeOutput', () => {
  const GOOD = [
    'ROOT\t/srv/app',
    'SANDBOX\tok',
    'LAYOUT\t/usr\tdirectory',
    'LAYOUT\t/bin\tsymlink\tusr/bin',
    'LAYOUT\t/etc\tdirectory',
    'TOOL\tgrep',
    'TOOL\tfind',
    'TOOL\trg',
  ].join('\n')

  it('extracts the canonical root', () => {
    expect(parseProbeOutput(GOOD).root).toBe('/srv/app')
  })

  it('extracts the tool set', () => {
    const result = parseProbeOutput(GOOD)
    expect(result.tools.has('rg')).toBe(true)
    expect(result.tools.has('grep')).toBe(true)
    expect(result.tools.has('nonexistent')).toBe(false)
  })

  it('extracts a mixed usr layout', () => {
    const { layout } = parseProbeOutput(GOOD)
    expect(layout.entries).toContainEqual({ path: '/usr', kind: 'directory' })
    expect(layout.entries).toContainEqual({ path: '/bin', kind: 'symlink', target: 'usr/bin' })
  })

  it('reports a working sandbox', () => {
    expect(parseProbeOutput(GOOD).sandboxAvailable).toBe(true)
  })

  it('reports an unavailable sandbox', () => {
    expect(parseProbeOutput(GOOD.replace('SANDBOX\tok', 'SANDBOX\tno')).sandboxAvailable).toBe(
      false,
    )
  })

  it('ignores unrecognised lines rather than failing on shell noise', () => {
    expect(parseProbeOutput(`warning: something\n${GOOD}\n`).root).toBe('/srv/app')
  })

  it('fails when the root line is missing', () => {
    expect(() => parseProbeOutput('SANDBOX\tok')).toThrow(
      expect.objectContaining({ code: 'PROBE_FAILED' }),
    )
  })

  it('fails when the root is not absolute', () => {
    expect(() => parseProbeOutput('ROOT\trelative\nSANDBOX\tok')).toThrow(
      expect.objectContaining({ code: 'PROBE_FAILED' }),
    )
  })
})

describe('probeHost', () => {
  const ok = (stdout: string) =>
    vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode: 0, stdoutTruncated: false })

  const WORKING = ['ROOT\t/srv/app', 'SANDBOX\tok', 'LAYOUT\t/usr\tdirectory', 'TOOL\tgrep'].join(
    '\n',
  )

  it('returns the parsed probe for a usable host', async () => {
    const result = await probeHost(ok(WORKING), '/srv/app')
    expect(result.root).toBe('/srv/app')
    expect(result.sandboxAvailable).toBe(true)
  })

  it('refuses a host whose sandbox does not work', async () => {
    // ADR-006 is fail-closed with no degraded mode. This is the whole point.
    const output = WORKING.replace('SANDBOX\tok', 'SANDBOX\tno')
    await expect(probeHost(ok(output), '/srv/app')).rejects.toThrow(
      expect.objectContaining({ code: 'SANDBOX_UNAVAILABLE' }),
    )
  })

  it('explains how to fix a missing sandbox', async () => {
    const output = WORKING.replace('SANDBOX\tok', 'SANDBOX\tno')
    await expect(probeHost(ok(output), '/srv/app')).rejects.toThrow(/bwrap|namespace/i)
  })

  it('reports a failed probe rather than proceeding blind', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: '', stderr: 'no such dir', exitCode: 1, stdoutTruncated: false })
    await expect(probeHost(exec, '/srv/app')).rejects.toThrow(
      expect.objectContaining({ code: 'PROBE_FAILED' }),
    )
  })

  it('runs exactly one command, since every round trip is latency', async () => {
    const exec = ok(WORKING)
    await probeHost(exec, '/srv/app')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('never places the root expression in an argv position of its own', async () => {
    // The expansion has to happen in the remote shell, so it lives inside the
    // script text rather than being passed as a separate argument.
    const exec = ok(WORKING)
    await probeHost(exec, '$PROJECTDIR')
    const argv = exec.mock.calls[0]?.[0] as string[]
    expect(argv).not.toContain('$PROJECTDIR')
    expect(argv.some((entry) => entry.includes('$PROJECTDIR'))).toBe(true)
  })
})
