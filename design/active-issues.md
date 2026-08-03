# Active Issues

Pre-existing bugs, environment limitations, and deferred fixes. Per `AGENTS.md`,
issues discovered but not introduced by the current change are recorded here
rather than fixed in passing. Remove an entry once it is resolved.

---

## ENV-001 — `pnpm` cannot be installed in the development sandbox

**Discovered:** Phase 0 · **Status:** Resolved by design change, recorded for context

`corepack enable pnpm` fails with `EROFS: read-only file system` against both
`/usr/local/bin` and `~/.local/bin`. Global npm installs fail for the same
reason. Project-local `npm install` works normally.

Resolution: the workspace uses npm rather than pnpm (ADR-001 amendment). No
action outstanding.

---

## ENV-002 — Agent cannot write `.github/`, so CI is not installed

**Discovered:** Phase 0 · **Status:** Open, needs user action

`.github/` is listed in `.agentreadonly`. The Phase 0 CI workflow has been
written to `design/ci.yml` instead and must be moved to
`.github/workflows/ci.yml` by hand.

Until then there is no automated enforcement of typecheck, lint, the ADR-011
dependency-boundary check, or the higher test tiers. `npm run verify` runs the
same gates locally.

---

## ENV-003 — Test tier 4 prerequisites unverified in this sandbox

**Discovered:** Phase 0 · **Status:** Open, blocks completion of Phase 2

Tier 4 (`SSHRemoteOps` against localhost) needs a running `sshd` on localhost and
a passwordless keypair. Neither has been confirmed available in the development
sandbox. `bwrap`, `rg`, `grep` and `ssh` (client) are all present, so tiers 1-3
are unaffected.

If localhost SSH turns out to be unavailable, tier 4 becomes CI-only and Phase 2
is validated against tier 3 locally. The `design/ci.yml` workflow already sets
up the keypair for CI.

---

## SBX-001 — Sandbox runs as root, so `ssh` resolves the wrong home directory

**Discovered:** Phase 3 · **Status:** Open, for the sandbox owner. Do not work
around.

The development sandbox runs as `uid=0(root)` while `$HOME` is `/home/scoder`.
Most tools honour `$HOME`, but OpenSSH takes the home directory from the passwd
entry for the running uid, so it reads `/root/.ssh` instead:

```
$ ssh -v -T git@github.com
debug1: identity file /root/.ssh/id_rsa type -1
...
Host key verification failed.
```

Consequences observed:

- `git push` over SSH fails with `Host key verification failed`, and writing
  `~/.ssh/known_hosts` does not help because ssh never reads that path. A
  `known_hosts` file was left at `/home/scoder/.ssh/known_hosts` containing
  GitHub's published host keys (verified against `api.github.com/meta`); it is
  inert and can be deleted.
- No identity files exist under `/root/.ssh`, so SSH authentication is not
  available in the sandbox at all.
- Pushing, and any real SSH work, must therefore happen outside the sandbox.

The user has confirmed the root uid is a sandbox bug and not to be worked around.
Test tiers 1-3 are unaffected: they use `TestRemoteOps` and
`LocalSandboxRemoteOps`, neither of which involves SSH. Tier 4 stays CI-only
(ENV-003).

---

## EXP-001 — `remote_ls` misreports filenames containing a newline

**Discovered:** Phase 3 · **Status:** Open, low priority

`remote_ls` parses `ls -1Ap`, which is line-oriented, so a filename containing a
newline is split across lines and reported as two entries. Neither is correct.

`find -print0` would avoid it, but carrying the entry type in the same pass needs
GNU `-printf`, and the probe does not yet distinguish GNU from BusyBox
(see ENV-004). Two round trips, or a type-per-entry `stat`, would cost more than
the case is worth for now.

Suggested fix: extend the probe to record `find` variant, then use
`find -maxdepth 1 -printf '%y\\t%P\\0'` where GNU find is present and fall back to
the current parse otherwise.

---

## ENV-005 — The fail-closed sandbox path cannot be reproduced locally

**Discovered:** Phase 2 · **Status:** Open, needs CI coverage

ADR-006 is fail-closed: a host whose `bwrap` cannot create a namespace must be
refused. The case that makes this non-trivial is *binary present, user namespaces
denied* — common on hardened and managed hosts.

This development sandbox has a working `bwrap`, so only the positive path is
exercised. A naive `command -v bwrap` check would pass every local test while
being wrong in production.

Detection therefore attempts a real namespace rather than checking for the
binary. That logic is unverified against a host where the attempt fails.

Suggested fix: a CI job that denies unprivileged user namespaces
(`sysctl kernel.unprivileged_userns_clone=0`, or a container without the
capability) and asserts the host is refused. Not yet scheduled.

---

## ENV-004 — `TestRemoteOps` inherits the developer's toolchain variants

**Discovered:** Phase 0 (raised during design) · **Status:** Open, low priority

Tier 1 executes the real `grep`/`find`/`rg` from the developer's machine, so
GNU-vs-BSD flag differences will not surface locally and would only appear
against a real remote host.

Suggested fix: have the Phase 2 probe record tool *variant* (GNU, BusyBox, BSD)
rather than mere presence, and pin the expected variant in CI. Not scheduled;
raise with the user before implementing.
