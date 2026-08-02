# Architecture Decision Records

Status legend: **Accepted** (agreed with user) · **Proposed** (awaiting review) · **Deferred**

---

## ADR-001 — TypeScript monorepo on an npm workspace

**Status:** Accepted (amended — originally specified pnpm)

**Context.** `agent-tools` is a monorepo holding several independent collections of
tools, each loadable into more than one agent host. The two initial hosts are
Claude Code and pi. pi loads extensions written in TypeScript and resolves them
through `jiti` without a compile step; the reference MCP SDK is TypeScript; both
distribute naturally over npm.

The repository's `.gitignore` is a Java template inherited from repository
creation and does not reflect intent.

**Decision.** TypeScript throughout, organised as an **npm workspace**. Test
runner `vitest`; lint and format via `@biomejs/biome`. Replace the Java
`.gitignore` with a Node one.

**Amendment (Phase 0).** pnpm was the original choice. It proved uninstallable in
the development sandbox: `corepack enable` fails with `EROFS` against both
`/usr/local/bin` and `~/.local/bin`. npm 11 is already present and its workspace
support is sufficient at this repository's size, so the dependency was dropped
rather than worked around.

**Consequences.** A Node runtime is required on the *operator's* machine. No
runtime is required on explored remote hosts — we only send POSIX commands over
SSH.

npm's flat, hoisted `node_modules` does not enforce dependency boundaries the way
pnpm's isolated layout does. The ADR-011 requirement that no shipped package
depends on `test-support` therefore cannot rely on resolution failure to catch a
mistake, and needs an explicit CI check instead.

---

## ADR-002 — Three-layer package structure

**Status:** Accepted

**Context.** The same tool logic must be exposed through two dissimilar host
APIs. Duplicating tool behaviour per host would let the two drift.

**Decision.**

```
packages/core              transport-agnostic engine: host config, SSH session,
                           root resolution, sandbox construction, argument
                           marshalling, output shaping
packages/remote-explorer   tool definitions — name, description, parameter
                           schema, handler — built on core. Host-agnostic.
adapters/pi                pi extension: maps definitions to pi.registerTool()
adapters/mcp               stdio MCP server: maps definitions to MCP tools
```

A tool definition is declared once. Adapters are thin and contain no behaviour.

**Consequences.** Parameter schemas need one representation usable by both
adapters. pi uses TypeBox; MCP consumes JSON Schema. TypeBox *emits* JSON
Schema, so authoring in TypeBox and deriving JSON Schema for MCP is the path of
least resistance and keeps a single source of truth.

---

## ADR-003 — Two delivery targets: pi extension and Claude Code MCP plugin

**Status:** Accepted

**Context.** The requirement is that tools appear to the agent as first-class
callable tools, alongside Read/Write/Bash.

pi supports this natively: an extension calls `pi.registerTool()` and is
distributed as a pi package (`npm:` or `git:` source).

Claude Code has no native tool-registration API. A Claude Code plugin may ship
skills, slash commands, hooks, subagents, and MCP servers — and of those, only
an MCP server produces callable tools. There is no alternative mechanism.

**Decision.** Ship a pi extension for pi, and a Claude Code plugin bundling a
stdio MCP server for Claude Code. Identical tool names, descriptions, and
schemas across both.

**Consequences.** Tool names appear namespaced in Claude Code
(`mcp__remote-explorer__remote_ls`) but bare in pi. Descriptions must not assume
either form. The MCP adapter runs as a separate process; the pi adapter runs
in-process, so `core` must not assume a long-lived singleton nor process-global
state.

---

## ADR-004 — Named hosts from a config file; the agent never supplies an SSH target

**Status:** Accepted

**Context.** If the model can pass an arbitrary `user@host`, the model chooses
the blast radius, and a misremembered or injected hostname reaches a machine
nobody intended to touch.

**Decision.** A local config file declares hosts. Each entry carries at minimum:

- `alias` — the only host identifier the model ever sees or supplies
- `ssh` target and options
- `root` — the exploration root (see ADR-007)
- sandbox policy

Tool parameters accept an alias. An unknown alias is an error listing the valid
aliases; it never falls through to a direct SSH attempt.

**Consequences.** Adding a host is a deliberate human act. The config file is
trusted input and is never written by a tool. Config location, precedence
(user vs project), and schema are Phase 1 work.

---

## ADR-005 — Discrete typed tools; no shell string is ever built from model output

**Status:** Accepted

**Context.** The README's original sketch was a limited `bash` surface behind a
command whitelist. Whitelisting command lines is difficult to get right:
correctness depends on parsing flags, quoting, substitution, redirection, and
pipelines the same way the remote shell will. Divergence between our parse and
the shell's parse is the bug class.

**Decision.** Expose discrete tools with typed parameters —
`remote_ls`, `remote_find`, `remote_grep`, `remote_read`, `remote_stat`, and a
host-listing tool. Each handler constructs an `argv` array from validated
parameters. Model-supplied values are only ever *arguments*, never fragments of
a command line, and are escaped by us at the point of transmission.

No `remote_exec` escape hatch in the initial scope.

**Consequences.** Capability is bounded by the tools we write; an agent cannot
compose novel commands. This is the intended trade. Coverage gaps get addressed
by adding a typed tool, not by loosening the boundary. SSH itself concatenates
its arguments into a string for the remote shell, so escaping is our
responsibility and is a `core` concern with direct test coverage.

---

## ADR-006 — bwrap sandbox on the remote host, failing closed

**Status:** Accepted

**Context.** Sandboxing must constrain what actually executes, which means it
runs on the remote host, not locally. A local sandbox would protect nothing
about the remote.

The stated threat model is agent mistakes, not a motivated attacker. It was put
to the user that fail-closed will refuse hosts lacking `bwrap` or with
unprivileged user namespaces disabled — common on hardened and managed servers.
The user chose fail-closed regardless.

**Decision.** Every remote command executes under `bwrap`. If `bwrap` is absent
or non-functional, the host is refused with an actionable error; there is no
degraded mode.

Sandbox shape:

- `--ro-bind <root> <root>` — the exploration root, read-only
- read-only binds of the toolchain paths required for the command to run at all
  (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc` as needed) — a root-only bind yields
  a sandbox containing no `grep`
- `--unshare-net` — no network from inside the sandbox
- `--unshare-pid`, `--die-with-parent`
- tmpfs for `/tmp`; no writable bind anywhere
- `--proc /proc`, `--dev /dev` only where required

**Consequences.** Two guarantees, distinct and both needed: the *allowlist*
(ADR-005) bounds which programs run and with what arguments; *bwrap* bounds what
those programs can reach if we get the first part wrong. bwrap does not prevent
reading anything under `root` — confidentiality within the root is `.aiignore`'s
job (ADR-010), not the sandbox's.

The exact bind set is a Phase 2 deliverable and must be verified empirically per
tool, not assumed.

---

## ADR-007 — Connection root, resolved on the remote by a fixed probe

**Status:** Accepted

**Context.** The exploration root is per-host and not always `$HOME` — it may be
`$PROJECTDIR` or another site-specific location. Only the remote host can expand
such a variable, since it depends on the remote login environment.

**Decision.** Each host entry declares a root as a literal path or as a shell
variable reference to be expanded remotely. On first use, a **probe** runs over
SSH to:

1. resolve the root to a canonical absolute path,
2. confirm it exists and is a directory,
3. detect `bwrap` and confirm it can actually create a namespace,
4. record which search tools are present (`rg`, `grep`, `find`).

The probe command is a fixed string built entirely from config. No model-supplied
value participates in it. The probe necessarily runs *outside* the sandbox —
bwrap cannot be configured until the root is known — which is acceptable
precisely because its content is not model-derived.

Probe results are cached per session. All subsequent paths are resolved relative
to the root and must canonicalise to a location inside it; symlink traversal out
of the root is rejected.

**Consequences.** A host may declare more than one root in future; the initial
implementation assumes one root per host entry and the config schema should not
foreclose several. Probe failure is a host-level refusal.

---

## ADR-008 — SSH transport: passwordless, BatchMode, connection multiplexing

**Status:** Proposed

**Context.** Every tool call is a round trip. A fresh TCP and SSH handshake per
call makes interactive exploration slow enough to change how the agent behaves.

**Decision.** Require passwordless key-based auth. Invoke `ssh` with
`BatchMode=yes` so a missing key fails immediately rather than blocking on a
prompt, and use `ControlMaster`/`ControlPersist` multiplexing over a
session-scoped control socket. Apply a connect timeout and a per-command
timeout, both configurable.

Shell out to the system `ssh` rather than using an in-process SSH library, so
that `~/.ssh/config`, agent forwarding, jump hosts, and site policy all behave
exactly as the operator already expects.

**Consequences.** Control sockets are process-scoped state needing cleanup on
exit — relevant to the in-process pi adapter, where a leak persists for the whole
pi session. Requires `ssh` on PATH locally.

---

## ADR-009 — Bounded, shaped tool output

**Status:** Proposed

**Context.** `grep -r` against a large tree can return more text than a context
window holds. Unbounded output is both a cost problem and a failure mode where
the useful result is buried.

**Decision.** Every tool enforces a result cap (line count and byte count) with
a documented default and a per-call override bounded by a hard ceiling.
Truncation is always explicit in the output — never silent — and states what was
dropped and how to narrow the query. Structured results where the shape is
genuinely tabular (`ls`, `stat`), plain text where it is not (`grep` matches).

**Consequences.** Handlers must apply limits at the remote end where possible
(`head`, `rg --max-count`) rather than transferring everything and truncating
locally.

---

## ADR-012 — Sandbox shape, determined empirically

**Status:** Accepted

**Context.** ADR-006 fixed the policy (bwrap on the remote, fail-closed) but left
the bind set to be "verified, not assumed". `design/prototype/probe-bwrap.sh`
tests the properties we are relying on against a real `bwrap`. Results below.

**Confirmed.** With the sandbox shape in the prototype: the root is genuinely
read-only (writes and file creation both refused); `--unshare-net` blocks
outbound TCP; `/tmp` is a private tmpfs whose writes do not reach the host;
`/home` and sibling directories outside the root are invisible; and
`grep`, `find`, `ls`, `cat`, `stat`, `rg` all run and return correct results.

**Finding 1 — argument order is significant.** bwrap applies operations in
argument order. `--tmpfs /tmp` placed *after* the root bind mounts straight over
a root that lives under `/tmp`, and the root disappears. The tmpfs must be
established first. Production cannot assume the root is outside `/tmp`, because
on a real host it may be anywhere.

**Finding 2 — the bind set must be discovered per host.** This host is split-usr,
with `/bin`, `/lib`, `/lib64`, `/sbin` as real directories. A merged-usr host has
them as symlinks into `/usr` and needs `--symlink`, not `--ro-bind`. A hardcoded
bind set is wrong on one layout or the other, so the probe must inspect the
layout.

**Finding 3 — a symlink into a bound path defeats the sandbox.** This is the
significant one. `/etc` and `/usr` must be bound read-only or the toolchain
cannot run: `ld.so` needs `/etc/ld.so.cache`, name resolution needs
`/etc/nsswitch.conf`. A symlink placed inside the root pointing at `/etc/hostname`
therefore resolves perfectly well, and the prototype read its contents from
inside the sandbox.

bwrap has no reason to prevent this and does not. Lexical containment in `core`
cannot see it either, because the path handed to the tool is entirely legitimate.

**Decision.** Path containment requires **three** layers, not two:

1. lexical containment in `core` (Phase 1, done) — rejects `../` before a command
   is built;
2. the bwrap mount namespace — removes everything outside the root and the
   toolchain from the filesystem view;
3. **remote canonicalisation** — every path a tool touches is resolved on the
   remote with `realpath` and rejected if the result falls outside the root.

Layer 3 is not optional and is what closes Finding 3. It costs a round trip, so
it belongs with the probe's cached state rather than being issued per path where
that can be avoided.

**Finding 4 — bwrap provides no confidentiality within reach.** `/etc` is
readable from inside the sandbox by design. This is consistent with ADR-006:
containment is the sandbox's job, confidentiality is the allowlist's and
`.aiignore`'s (ADR-010). It is recorded here so it is not later mistaken for a
regression.

**Finding 5 — the fail-closed path is unverified.** On this host, `bwrap` is
present *and* namespaces work, so a naive `command -v bwrap` check would have
agreed with the real one. The case that matters — binary present, userns denied —
could not be reproduced locally and is unverified (ENV-005). Detection attempts a
real namespace regardless, since that is the only check that distinguishes them.

---

## ADR-010 — `.aiignore` deferred to a later phase

**Status:** Deferred (user decision)

**Context.** The README specifies `.aiignore` consultation. The user has deferred
it to a future phase, with the likely shape being a gitignore-syntax file
**on the remote host**, relative to the connection root.

**Decision.** Not in initial scope. Design the path-filtering layer as an
explicit seam in `core` from the outset — a predicate applied to every path
before it appears in output — so that adding `.aiignore` later is filling in a
policy, not retrofitting one.

**Consequences.** Until it exists, there is no confidentiality filtering within
the root, and this must be stated plainly in the README rather than implied
otherwise. A remote-sourced ignore file is remote-controlled input; when
implemented, it should be able to *add* restrictions and never remove any local
baseline.

---

## ADR-011 — `RemoteOps` seam at `exec(argv)`, with a four-tier test ladder

**Status:** Accepted

**Context.** Testing needs a substitute for a real remote host. The user proposed
a `RemoteOps` interface with an `SSHRemoteOps` implementation and a
`TestRemoteOps` that resolves all activity into a temporary directory.

The level the interface sits at determines what the tests are worth. A
*high-level* `RemoteOps` (`ls()`, `grep()`, `find()`) forces `TestRemoteOps` to
reimplement those operations in Node; the suite would then be validating the
reimplementation, and any divergence in output format or edge-case handling
between the fake and the real tools passes unnoticed.

**Decision.** `RemoteOps` is **low-level**: a command sink, roughly
`exec(argv: string[], opts): Promise<{stdout, stderr, code}>`, plus root
resolution and capability reporting.

- `SSHRemoteOps` — flattens argv into a shell-safe string, wraps in `bwrap`,
  transports over SSH.
- `TestRemoteOps` — executes the same argv locally with a temporary directory as
  the root, using the real `grep`/`find`/`rg` binaries.

Because both receive an identical argv, argv construction, output parsing,
truncation, and error mapping are all exercised against genuine tool behaviour.

Two areas are structurally outside what `TestRemoteOps` can reach, and they are
the two highest-risk components: **escaping** (local exec passes argv directly
and never involves a shell) and **bwrap**. These get dedicated tiers:

| Tier | Implementation | Covers |
|------|----------------|--------|
| 1 | `TestRemoteOps` — argv exec'd in a temp dir | tool logic, parsing, limits, containment |
| 2 | Escaper round-trip through `bash -c` | quoting, `$`, backticks, newlines, globs |
| 3 | `LocalSandboxRemoteOps` — real bwrap, no SSH | bind set, fail-closed, escape attempts |
| 4 | `SSHRemoteOps` against localhost | full stack, multiplexing, timeouts |

Tier 2 makes the escaper testable without any remote host: escape an argv, run it
through `bash -c` against a helper that prints its received arguments
NUL-separated, and assert the argv returns byte-identical. Tier 3 is possible
because `bwrap` runs locally; it isolates sandbox correctness from SSH.

**Consequences.**

*Path containment must live in `core` above `RemoteOps`*, not inside
`SSHRemoteOps`. Placed in the SSH implementation it would be invisible to tier 1
and only exercised by the slowest tier. Above the seam, every tier tests it.

*`TestRemoteOps` must not be reachable from production configuration.* A
`RemoteOps` that executes argv locally against a directory is — if selectable at
runtime — an unsandboxed local command executor that bypasses every guarantee in
ADR-006. It lives in `packages/test-support`, is a devDependency only, and no
host-config value may select an implementation. Implementation choice is a
compile-time wiring decision in tests, never configuration data.

*Capability differences are explicit.* `TestRemoteOps` reports the local
machine's toolchain; tests that depend on `rg` being absent must be able to say
so rather than inheriting whatever the developer happens to have installed.
