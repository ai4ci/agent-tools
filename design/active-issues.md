# Active Issues

Pre-existing bugs, environment limitations, and deferred fixes. Per `AGENTS.md`,
issues discovered but not introduced by the current change are recorded here
rather than fixed in passing. Remove an entry once it is resolved.

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

- `git push` and `git fetch` over SSH fail with `Host key verification failed`,
  and writing `~/.ssh/known_hosts` does not help because ssh never reads that
  path. A `known_hosts` file was left at `/home/scoder/.ssh/known_hosts`
  containing GitHub's published host keys (verified against
  `api.github.com/meta`); it is inert and can be deleted.
- No identity files exist under `/root/.ssh`, so SSH authentication is not
  available in the sandbox at all.
- Pushing must therefore happen outside the sandbox.

The user has confirmed the root uid is a sandbox bug and not to be worked around.
Test tiers 1-3 are unaffected — they use `TestRemoteOps` and
`LocalSandboxRemoteOps`, neither of which involves SSH — and tier 4 runs in CI.

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
