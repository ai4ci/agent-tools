import { classifySshFailure } from '@agent-tools/core'
import { describe, expect, it } from 'vitest'

/**
 * SSH failure classification (ADR-008 error taxonomy).
 *
 * ssh reports almost every connection problem as exit 255 with a human-readable
 * line on stderr, so distinguishing "wrong key" from "host is down" means reading
 * that text. A model needs the distinction: one is worth retrying, the other is
 * worth reporting to the operator.
 *
 * Exit 255 is also a legitimate exit code for a *remote command*, so the
 * classification must not claim a connection failure when the connection plainly
 * worked.
 */

const alias = 'prod-web'

describe('classifySshFailure', () => {
  it('returns undefined when the command merely exited non-zero', () => {
    // grep exiting 1 is an answer, not a failure.
    expect(classifySshFailure({ alias, exitCode: 1, stderr: '' })).toBeUndefined()
  })

  it('returns undefined on success', () => {
    expect(classifySshFailure({ alias, exitCode: 0, stderr: '' })).toBeUndefined()
  })

  const cases: Array<[name: string, stderr: string, code: string]> = [
    ['permission denied', 'Permission denied (publickey).', 'AUTH_FAILED'],
    ['no supported auth', 'No supported authentication methods available', 'AUTH_FAILED'],
    ['host key mismatch', 'REMOTE HOST IDENTIFICATION HAS CHANGED!', 'AUTH_FAILED'],
    ['host key verification', 'Host key verification failed.', 'AUTH_FAILED'],
    [
      'connection refused',
      'ssh: connect to host x port 22: Connection refused',
      'HOST_UNREACHABLE',
    ],
    [
      'name resolution',
      'ssh: Could not resolve hostname nope: Name or service not known',
      'HOST_UNREACHABLE',
    ],
    ['no route', 'ssh: connect to host x port 22: No route to host', 'HOST_UNREACHABLE'],
    [
      'network unreachable',
      'connect to host x port 22: Network is unreachable',
      'HOST_UNREACHABLE',
    ],
    ['connection timed out', 'ssh: connect to host x port 22: Connection timed out', 'TIMEOUT'],
    ['operation timed out', 'ssh: connect to host x: Operation timed out', 'TIMEOUT'],
    ['connection closed', 'Connection closed by remote host', 'HOST_UNREACHABLE'],
  ]

  for (const [name, stderr, code] of cases) {
    it(`classifies ${name} as ${code}`, () => {
      const error = classifySshFailure({ alias, exitCode: 255, stderr })
      expect(error?.code).toBe(code)
    })
  }

  it('is case-insensitive, since wording varies between ssh builds', () => {
    const error = classifySshFailure({
      alias,
      exitCode: 255,
      stderr: 'permission denied (PUBLICKEY).',
    })
    expect(error?.code).toBe('AUTH_FAILED')
  })

  it('falls back to unreachable for an unrecognised 255', () => {
    const error = classifySshFailure({ alias, exitCode: 255, stderr: 'something unexpected' })
    expect(error?.code).toBe('HOST_UNREACHABLE')
  })

  it('names the host alias so the operator knows which one failed', () => {
    const error = classifySshFailure({
      alias,
      exitCode: 255,
      stderr: 'Permission denied (publickey).',
    })
    expect(error?.message).toContain(alias)
  })

  it('suggests a remedy for an auth failure', () => {
    const error = classifySshFailure({
      alias,
      exitCode: 255,
      stderr: 'Permission denied (publickey).',
    })
    expect(error?.remedy).toBeDefined()
    expect(error?.toToolMessage()).toMatch(/key/i)
  })

  it('does not leak the full stderr into the model-facing message', () => {
    // stderr can carry a login banner or an internal hostname; the taxonomy entry
    // is what the model needs, not the raw text.
    const error = classifySshFailure({
      alias,
      exitCode: 255,
      stderr: 'Permission denied (publickey).\nSECRET-BANNER-CONTENT',
    })
    expect(error?.toToolMessage()).not.toContain('SECRET-BANNER-CONTENT')
  })
})
