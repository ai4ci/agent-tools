# Roadmap

Phased delivery for `agent-tools`. Decisions behind these phases are in
[`adr.md`](adr.md).

Working rules for every phase (from `AGENTS.md`):

- a clean revert point exists before changes begin
- tests are written and **proven to fail** before the feature is developed
- tests are **proven to pass** before the feature is called complete
- no new lint or static-analysis findings
- design docs updated and patch version incremented before committing

---

## Phase 0 — Repository scaffolding

- [x] Replace the inherited Java `.gitignore` with a Node/TypeScript one
      *(done by the user — `.gitignore` is in `.agentreadonly`)*
- [x] ~~Enable `pnpm` via corepack~~ — npm workspace instead (ADR-001 amendment,
      ENV-001)
- [x] Root `package.json`: scripts, engines, shared devDependencies
- [x] TypeScript config — strict, composite project references
      (`tsconfig.base.json`, per-package projects, `tsconfig.test.json` so test
      files are typechecked too)
- [x] Linter + formatter (Biome), wired to `npm run lint`
- [x] Test runner (Vitest) with tier selection by filename suffix
- [x] `packages/core`, `packages/remote-explorer`, `packages/test-support`,
      `adapters/pi`, `adapters/mcp` build, typecheck, and cross-resolve
- [x] `packages/test-support` marked private; `scripts/check-boundaries.mjs`
      enforces that no shipped package depends on or imports it (ADR-011)
- [x] CI: install, typecheck, lint, test on push. Split into four jobs by
      prerequisite — `verify` (tiers 1-2), `sandbox` (tiers 3-4), `fail-closed`
      (ENV-005), `diagnose` (records runner capability). `.github/` is not
      agent-writable, so the workflow is authored in `design/ci.yml` and moved by
      hand
- [x] `design/active-issues.md` created

**Done when:** `npm install && npm run verify` is green on a clean clone.
**Status:** met. Green locally and in CI.

---

## Phase 1 — Host configuration, `RemoteOps`, SSH transport (`core`)

- [ ] `RemoteOps` interface at the `exec(argv, opts)` level, plus root
      resolution and capability reporting (ADR-011)
- [ ] `TestRemoteOps` in `packages/test-support` — executes argv locally against
      a temporary root using the real `grep`/`find`/`rg`; capability reporting
      overridable so tests can simulate a host without `rg`
- [ ] Implementation selection is compile-time wiring in tests; no config value
      may select a `RemoteOps` implementation
- [ ] Path containment implemented in `core` **above** the `RemoteOps` seam, so
      every test tier exercises it
- [ ] Config schema: alias, ssh target and options, root, sandbox policy,
      output limits — shaped so multiple roots per host stay possible (ADR-007)
- [ ] Config discovery and precedence (user-level vs project-level); validation
      errors that name the offending field
- [ ] SSH invocation layer: `BatchMode=yes`, connect timeout, per-command
      timeout, `ControlMaster`/`ControlPersist` on a session-scoped socket
- [ ] Control-socket lifecycle and teardown — must not leak in the long-lived
      in-process pi adapter (ADR-008)
- [ ] `argv` marshalling and remote-shell escaping, as its own unit
- [ ] Escaper round-trip harness (test tier 2): escape an argv, run it through
      `bash -c` against a helper printing its arguments NUL-separated, assert
      byte-identical recovery — spaces, quotes, `$`, backticks, newlines, globs,
      leading dashes, non-UTF-8
- [ ] Structured error taxonomy: unreachable, auth failed, timeout, refused host

**Tests to fail first:** escaper round-trip fixtures; unknown-alias rejection;
timeout behaviour; socket cleanup on abnormal exit; containment rejection via
`TestRemoteOps`.

**Done when:** a fixture host can be reached and a fixed command round-tripped,
with no code path that concatenates a caller-supplied string into a command line.

---

## Phase 2 — Probe and bwrap sandbox (`core`)

- [ ] Probe command, built purely from config, resolving the root to a canonical
      absolute path and confirming it is a directory
- [ ] Detect `bwrap` **and** verify it can create a namespace — presence on PATH
      is not sufficient evidence that userns is permitted
- [ ] Detect available search tools (`rg`, `grep`, `find`)
- [ ] Per-session probe result cache with explicit invalidation
- [ ] Sandbox construction: read-only root bind, read-only toolchain binds,
      `--unshare-net`, `--unshare-pid`, `--die-with-parent`, tmpfs `/tmp`,
      no writable bind
- [x] Empirically determine the bind set — done via
      `design/prototype/probe-bwrap.sh`; results recorded as ADR-012
- [x] Discover the host's usr layout in the probe and emit `--symlink` or
      `--ro-bind` accordingly (ADR-012 finding 2)
- [x] Establish the tmpfs before binding the root — order is significant and a
      root under `/tmp` is otherwise mounted over (ADR-012 finding 1)
- [x] **Remote canonicalisation of every path, rejecting results outside the
      root.** Closes ADR-012 finding 3. Prefers `realpath(1)`, falling back to an
      explicit symlink walk for hosts without it
- [x] **Fail closed:** a host whose sandbox cannot be created is refused with an
      error stating what is missing and how to fix it. Detection attempts a real
      namespace rather than checking PATH. **Verified in CI:** a default
      `ubuntu-latest` runner has bwrap installed and unprivileged user namespaces
      denied, which is exactly the hardened host that could not be reproduced
      locally, and the `fail-closed` job asserts it is refused with
      `SANDBOX_UNAVAILABLE` and no fallback
- [x] `LocalSandboxRemoteOps` (test tier 3) — real `bwrap`, no SSH — so sandbox
      correctness is testable without a remote host (ADR-011)
- [x] Root containment verified at the sandbox level too, independently of the
      `core`-level check added in Phase 1
- [x] `SshRemoteOps` — probe caching, sandbox wrapping, escaping, multiplexing,
      control-socket teardown, and SSH failure classification
- [x] Tier 4 test suite (`*.ssh.test.ts`) — **passing in CI.** The development
      sandbox has no sshd and cannot use SSH at all (SBX-001), so tier 4 is
      CI-only by design rather than by accident

**Tests to fail first:** host with a non-functional sandbox is refused; symlink
pointing outside the root is rejected; a write attempt inside the sandbox fails;
network from inside the sandbox fails. *(All written and proven to fail first.)*

**Done when:** no remote command can execute outside a verified sandbox, and the
containment tests pass against a real bwrap.
**Status:** met. Tier 3 passes locally (23 tests) and tiers 3-4 pass in CI, so
escaping through a real remote login shell, bwrap over SSH, multiplexing and
symlink containment are all verified end to end.

---

## Phase 3 — Remote explorer tools (`packages/remote-explorer`)

- [x] Shared tool-definition type: name, description, TypeBox schema, handler.
      `handler` takes the schema's inferred `Static` type, so a tool cannot
      declare one set of parameters and read another
- [x] Tool context resolving an alias to a session, with the `RemoteOps` factory
      injected so tier 1 drives the real handlers (ADR-011)
- [x] `remote_hosts` — list configured aliases and their roots
- [x] `remote_ls` — directory listing, structured result
- [x] `remote_stat` — metadata for a path
- [x] `remote_find` — name/type/depth filtered search
- [x] `remote_grep` — content search, preferring `rg`, falling back to `grep`
- [x] `remote_read` — file contents with offset/limit
- [ ] Path-filter seam applied to every path before it reaches output — the hook
      `.aiignore` fills in later (ADR-010). The tools already share one
      `resolveTarget`/`relativiseToRoot` pair, so this is a single insertion point
- [x] Output limits pushed to the remote where possible (`rg --max-count`,
      `grep -m`, `sed` ranges); truncation always explicit in the result (ADR-009)
- [x] Tool descriptions written for a model reader, valid under both bare and
      MCP-namespaced tool names
- [x] Every tool resolves its own paths through one shared helper, so containment
      is enforced per tool rather than only in core

**Tests to fail first:** per-tool behaviour against a fixture tree; truncation
marker present when limits are hit; paths outside the root rejected by every
tool, not just by `core`.

**Done when:** all six tools work end-to-end against a real sandboxed host.
**Status:** all six tools implemented, passing at tier 1 (54 tests) and at tier 3
inside a real bwrap sandbox (20 tests). Only the path-filter seam remains.

The tier 3 pass closed a real gap: tier 1 exercises the tools' invocations against
real binaries but *unsandboxed*, so nothing proved that `stat -c`, `sed -n`,
`rg --max-count` or `find -mindepth` work inside the restricted mount namespace,
where only the root and the discovered toolchain paths exist. It also confirms
containment end to end — each tool refuses a symlink to `/etc` from inside the
sandbox, which is the case bwrap cannot prevent (ADR-012 finding 3).

Not yet exercised at tier 4: the tools have never run over SSH. Lower risk than
the sandbox gap was, since tier 4 already covers the transport for `core`.

---

## Phase 4 — pi adapter

- [x] Extension entry point mapping definitions to `pi.registerTool()`
- [x] Config loading and probe caching scoped to the pi session
- [x] Teardown on `session_end` — control sockets closed
- [x] Errors surfaced usefully. Note the inversion: pi flags a tool result as an
      error only when `execute` *throws*, so the adapter converts our
      `ToolResult.isError` into a thrown error. Returning it would report every
      failure to the model as a success
- [x] `promptSnippet` supplied per tool from a new `summary` field — pi omits
      tools without one from the system prompt's "Available tools" section, so
      they would be registered but never advertised
- [x] String enums expressed as `{ type: 'string', enum: [...] }`, not
      `Type.Union`/`Type.Literal`, which emit `anyOf`/`const` and are rejected by
      Google's API. Asserted for every tool schema by an invariant test
- [x] `pi` manifest and `pi-package` keyword in `package.json`
- [ ] `pi install` from a local path, then from git — not yet attempted
- [~] Manual verification: the extension **loads** in pi (`pi -e … --print`
      reaches the provider and fails only on account balance, so `registerTool`
      accepted all six tools). Whether a model can see and call them is
      **unverified** — see EXP-003

**Done when:** `pi install <this repo>` yields working `remote_*` tools.
**Status:** the adapter is complete and unit-tested (20 tests), and the extension
loads cleanly in pi. Verification that a model can actually call the tools is
blocked on provider credit (EXP-003).

---

## Phase 5 — MCP adapter and Claude Code plugin

- [x] stdio MCP server exposing the same definitions
- [x] TypeBox → JSON Schema derivation, with schema-parity tests against the
      definitions the pi adapter reads (ADR-002). TypeBox schemas already *are*
      JSON Schema and its `~kind` marker is non-enumerable, so the conversion is a
      JSON round trip — done explicitly rather than relying on that
- [x] Error mapping, which is the exact inverse of pi's: MCP carries `isError` on
      the result, and throwing would become a *protocol* error the model cannot
      read. pi flags an error only when the handler throws. The same `ToolResult`
      therefore maps two opposite ways
- [x] Verified against the real built server over stdio via
      `design/prototype/probe-mcp-server.mjs` — initialise handshake, `tools/list`,
      `tools/call`, unknown alias, unknown tool, and that stdout carries nothing
      but JSON-RPC. 11 checks, all passing
- [x] Install documentation for both hosts (`docs/install.md`)
- [ ] Claude Code plugin manifest bundling the server — **not done.** The server is
      registered manually via `.mcp.json`, which is documented and sufficient;
      packaging it as a distributable plugin is outstanding
- [ ] Manual verification inside Claude Code itself — the protocol is verified
      end to end, but the server has not been loaded by Claude Code

**Done when:** the identical tool set is usable from Claude Code, with parity
tests proving the two adapters expose the same schemas.
**Status:** parity tests in place, and the protocol works against the real server.
Plugin packaging and in-host verification outstanding.

---

## Phase 6 — `.aiignore`

Semantics settled with the user and recorded as ADR-013. Enforcement is in the
**sandbox**, not the tool layer, so no tool can forget it.

- [x] Confirm the final semantics with the user before implementing
- [x] Establish the mechanism empirically —
      `design/prototype/probe-aiignore-hiding.sh`. The proposed symlink-to-nowhere
      approach does not work; `--tmpfs` over the parent plus `--ro-bind` of
      permitted siblings does (ADR-013)
- [ ] Read and parse `.aiignore` from the connection root, gitignore syntax
- [ ] Compute the overlay plan once per session, alongside the probe: which
      directories contain an ignored entry, and which siblings survive
- [ ] Extend `buildSandboxCommand` to apply the plan
- [ ] `.aiignore` is itself always ignored
- [ ] Tier 3 tests: an ignored file is absent from `remote_ls` and `remote_find`,
      `remote_read` reports not-found, and `remote_grep` cannot reach its contents
- [ ] Remove the "no content filtering within a root" caveat from
      `docs/install.md`

**Deliberately not done:** the `--tmp-overlay` whiteout route, which would be
O(ignored files) rather than O(directory entries). Recorded as a future option in
ADR-013; `--tmp-overlay` is absent from the bubblewrap build available here.

**Done when:** ignored paths are invisible through every tool, verified per tool
at tier 3.

---

## Phase 7 — Release

- [ ] Versioning and changelog policy across workspace packages
- [ ] Publish pi package and MCP/plugin artefacts
- [ ] README rewritten to match what was actually built
- [ ] Second tool collection scaffolded, proving the monorepo structure holds

---

## Test strategy

Four tiers (ADR-011). Tiers 1–3 run on every commit; tier 4 is opt-in locally
and scheduled in CI.

| Tier | Implementation | Covers | Phase introduced |
|------|----------------|--------|------------------|
| 1 | `TestRemoteOps` — argv exec'd in a temp dir | tool logic, parsing, limits, containment | 1 |
| 2 | Escaper round-trip through `bash -c` | quoting, `$`, backticks, newlines, globs | 1 |
| 3 | `LocalSandboxRemoteOps` — real bwrap, no SSH | bind set, fail-closed, escape attempts | 2 |
| 4 | `SSHRemoteOps` against localhost | full stack, multiplexing, timeouts | 2 |

---

## Open questions

- Config file location and format — settled in Phase 1
- Whether a host may declare several roots, and how a tool selects between them
- Whether tier 4 targets localhost-over-SSH or a container in CI; localhost is
  the assumption unless CI cannot provide an sshd
- Whether `remote_read` should be capped by file size, line count, or both
