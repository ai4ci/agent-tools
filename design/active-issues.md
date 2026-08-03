# Active Issues

Pre-existing bugs, environment limitations, and deferred fixes. Per `AGENTS.md`,
issues discovered but not introduced by the current change are recorded here
rather than fixed in passing. Remove an entry once it is resolved.

---

## SBX-001 — No SSH credentials in the sandbox, so git push happens outside it

**Discovered:** Phase 3 · **Status:** Resolved in part; remainder is expected
behaviour, not a defect.

*Originally:* the sandbox ran as `uid=0(root)` while `$HOME` was `/home/scoder`.
OpenSSH takes the home directory from the passwd entry for the running uid rather
than from `$HOME`, so it read `/root/.ssh` and `git push` failed with
`Host key verification failed` no matter what was written to `~/.ssh`.

*Fixed by the sandbox owner.* The sandbox now runs as `uid=1001(scoder)` and ssh
resolves `/home/scoder/.ssh` correctly.

What remains is not a bug: `~/.ssh` is not bound into the sandbox, so there are no
identity files and no `known_hosts`. SSH authentication is therefore unavailable
here by design, and pushing is done outside the sandbox.

An inert `known_hosts` written during diagnosis may still exist at
`/home/scoder/.ssh/known_hosts` — it holds GitHub's published host keys, verified
against `api.github.com/meta`, and can be deleted.

Test tiers 1-3 are unaffected: they use `TestRemoteOps` and
`LocalSandboxRemoteOps`, neither of which involves SSH. Tier 4 runs in CI.

---

## SBX-002 — `gh` cannot download Actions logs from the sandbox

**Discovered:** Phase 2 · **Status:** Open, low priority. Workaround is adequate.

`gh auth status` reports the stored token as invalid, and re-authenticating did
not persist. gh therefore acts anonymously. Because the repository is public,
`gh run list` and `gh run view` still work, so gh appears authenticated until log
download, which returns a misleading
`HTTP 403: Must have admin rights to Repository`.

Workaround: `gh run view <run-id> --verbose` prints failure annotations, which for
a Vitest suite include the test file, line, assertion message, and
expected-vs-received values. That has been sufficient for every failure so far.

A durable fix would be a valid `GH_TOKEN` exported in the sandbox configuration.

---

## EXP-002 — Deliberate divergence: leading `@` in paths is not stripped

**Discovered:** Phase 4 · **Status:** Open by decision, needs confirming

pi's extension documentation advises that custom tools accepting a path should
strip a leading `@`, because some models copy pi's `@file` reference syntax into
tool arguments, and pi's own built-in tools strip it.

The remote tools deliberately do not. The trees these tools explore routinely
contain directories whose names genuinely begin with `@` — every scoped npm
package under `node_modules` does — so stripping would make
`node_modules/@types/node/index.d.ts` unreadable, which is exactly the kind of
path someone explores a remote machine to find.

The cost of not stripping is that a model which prefixes a path with `@` gets a
"path does not exist" error rather than the file. That is a recoverable, legible
failure; silently reading the wrong path is not.

Raise with the user: if this proves annoying in practice, the better fix is to
retry once without the prefix *only* when the prefixed path does not exist, rather
than stripping unconditionally.

---

## EXP-003 — pi end-to-end tool invocation is unverified

**Discovered:** Phase 4 · **Status:** Open, blocked on provider credit

The extension loads correctly in pi: `pi -e ./adapters/pi/dist/index.js --print`
reaches the provider and fails with `402 Insufficient Balance`, which means jiti
loaded the module and `registerTool` accepted all six tools without error.

What is *not* verified is that a model can see and call them — that the tools
appear in the system prompt's "Available tools" section, that parameter schemas
are accepted by a real provider, and that results render sensibly. That needs a
funded provider account.

Unit tests cover the parts under our control: the default export registers six
tools, subscribes to `session_end`, supplies `promptSnippet` for each, and every
schema avoids the `anyOf`/`const` constructs Google rejects.

---

## EXP-001 — `remote_ls` misreports filenames containing a newline

**Discovered:** Phase 3 · **Status:** Open, low priority

`remote_ls` parses `ls -1Ap`, which is line-oriented, so a filename containing a
newline is split across lines and reported as two entries. Neither is correct.
`remote_find` has the same weakness, since it uses `-print` rather than `-print0`.

`find -print0` would avoid it, but carrying the entry type in the same pass needs
GNU `-printf`, and the probe does not yet distinguish GNU from BusyBox
(see ENV-004). Two round trips, or a type-per-entry `stat`, would cost more than
the case is worth for now.

Suggested fix: extend the probe to record `find` variant, then use
`find -maxdepth 1 -printf '%y\t%P\0'` where GNU find is present and fall back to
the current parse otherwise.

---

## ENV-004 — `TestRemoteOps` inherits the developer's toolchain variants

**Discovered:** Phase 0 (raised during design) · **Status:** Open, low priority

Tier 1 executes the real `grep`/`find`/`rg` from the developer's machine, so
GNU-vs-BSD-vs-BusyBox flag differences will not surface locally and would only
appear against a real remote host.

Partly mitigated: `createTestRemoteOps({ tools: [...] })` lets a test declare a
thinner host, and `remote_grep`'s no-ripgrep fallback is covered that way. The
gap that remains is *variant* differences within a tool that is present.

Suggested fix: have the probe record tool variant (GNU, BusyBox, BSD) rather than
mere presence, and pin the expected variant in CI. Would also unblock EXP-001.
Not scheduled; raise with the user before implementing.
