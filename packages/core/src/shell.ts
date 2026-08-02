import { invalidArgument } from './errors.js'

/**
 * POSIX shell escaping.
 *
 * SSH does not transport an argv. It concatenates whatever it is given and hands
 * one string to the remote login shell, which re-splits it. Escaping is therefore
 * ours to get right, and getting it wrong turns a model-supplied filename into
 * remote command execution (ADR-005).
 *
 * The approach is deliberately the boring one: wrap every argument in single
 * quotes and handle the single case single quotes cannot express — a single quote
 * itself. Inside single quotes POSIX shells expand nothing at all: no parameters,
 * no command substitution, no globbing, no history, no backslash escapes. That
 * makes the rule uniform, so there is no per-character classification to get
 * subtly wrong, and no "safe characters" fast path to drift out of sync with the
 * shells we actually meet.
 */

/** Characters that cannot survive transport to a remote shell in any encoding. */
const NUL = '\0'

/**
 * Quote a single argument for a POSIX shell.
 *
 * A single-quoted string ends at the next single quote, so an embedded `'` is
 * emitted as `'\''` — close the quote, produce an escaped quote outside it,
 * reopen. `a'b` becomes `'a'\''b'`.
 */
export function shellQuote(arg: string): string {
  if (arg.includes(NUL)) {
    throw invalidArgument(
      'Argument contains a NUL byte, which cannot be passed to a remote command.',
      'Remove the NUL byte from the argument.',
    )
  }

  return `'${arg.replaceAll("'", "'\\''")}'`
}

/**
 * Flatten an argv into a single command string for a remote shell.
 *
 * Every element is quoted, including the command name — an unquoted command name
 * would still be subject to expansion, and the command name can come from
 * configuration.
 */
export function shellJoin(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw invalidArgument(
      'Cannot build a command from an empty argument list.',
      'Provide at least a command name.',
    )
  }

  return argv.map(shellQuote).join(' ')
}
