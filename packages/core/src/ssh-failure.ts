import { AgentToolsError, type AgentToolsErrorCode } from './errors.js'

/**
 * SSH failure classification (ADR-008).
 *
 * ssh signals nearly every connection problem with exit 255 and a line of English
 * on stderr, so telling "wrong key" from "host is down" means reading that text.
 * The distinction matters to the caller: one is worth reporting to the operator,
 * the other might be transient.
 *
 * Matching on message text is inherently brittle across ssh builds, so the
 * fallback is deliberate rather than incidental: an unrecognised 255 is reported
 * as unreachable, which is the safer of the two to be wrong about.
 */

/** Exit code ssh uses for its own failures, as opposed to the remote command's. */
const SSH_FAILURE_EXIT = 255

interface Pattern {
  readonly match: RegExp
  readonly code: AgentToolsErrorCode
  readonly message: string
  readonly remedy: string
}

const PATTERNS: readonly Pattern[] = [
  {
    match:
      /permission denied|no supported authentication|host key verification failed|remote host identification has changed/i,
    code: 'AUTH_FAILED',
    message: 'SSH authentication failed',
    remedy:
      'Check that passwordless key authentication works for this host, and that the host key is trusted.',
  },
  {
    match: /connection timed out|operation timed out|timed out/i,
    code: 'TIMEOUT',
    message: 'SSH connection timed out',
    remedy: 'Check the host is reachable, or raise the connect timeout.',
  },
  {
    match:
      /connection refused|could not resolve|name or service not known|no route to host|network is unreachable|connection closed/i,
    code: 'HOST_UNREACHABLE',
    message: 'SSH could not reach the host',
    remedy: 'Check the hostname, port, and that the host is up.',
  },
]

export interface SshFailureInput {
  readonly alias: string
  readonly exitCode: number
  readonly stderr: string
}

/**
 * Classify an ssh invocation result.
 *
 * @returns An error when ssh itself failed, or `undefined` when the connection
 *   worked and the exit code belongs to the remote command. A non-zero exit is
 *   ordinarily a result rather than a failure — `grep` exits 1 for "no matches".
 */
export function classifySshFailure(input: SshFailureInput): AgentToolsError | undefined {
  const { alias, exitCode, stderr } = input

  if (exitCode !== SSH_FAILURE_EXIT) return undefined

  for (const pattern of PATTERNS) {
    if (pattern.match.test(stderr)) {
      return new AgentToolsError(pattern.code, `${pattern.message} for host "${alias}".`, {
        remedy: pattern.remedy,
      })
    }
  }

  // 255 with nothing we recognise. stderr is deliberately not interpolated: it
  // can carry a login banner or internal hostnames, and this text reaches a model
  // transcript.
  return new AgentToolsError(
    'HOST_UNREACHABLE',
    `SSH failed for host "${alias}" without a recognised cause.`,
    { remedy: 'Run the ssh command manually to see the full error.' },
  )
}
