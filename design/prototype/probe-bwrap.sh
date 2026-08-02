#!/usr/bin/env bash
#
# PROTOTYPE — exploratory only.
#
# Per AGENTS.md, scripts in design/ are instructional examples and must be
# completely rewritten for production. This one exists to answer a Phase 2
# question empirically rather than by assumption (roadmap: "empirically determine
# the minimum bind set per tool — verified, not assumed"):
#
#   1. Which bind set does bwrap need for grep/find/rg to run at all?
#   2. Does --ro-bind of the exploration root actually prevent writes?
#   3. Does --unshare-net actually prevent network access?
#   4. Can a symlink inside the root escape to a path outside it?
#   5. Does bwrap detection need more than `command -v bwrap`?
#
# Usage:  bash design/prototype/probe-bwrap.sh
# Exit:   0 if every check produced a verdict; non-zero if bwrap is unusable.

set -uo pipefail

PASS=0
FAIL=0

say() { printf '\n=== %s ===\n' "$1"; }
ok() { printf '  [ok]   %s\n' "$1"; PASS=$((PASS + 1)); }
no() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
info() { printf '  ...    %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ROOT="$WORK/root"
OUTSIDE="$WORK/outside"
mkdir -p "$ROOT/sub" "$OUTSIDE"
echo 'needle in the haystack' > "$ROOT/sub/file.txt"
echo 'SECRET' > "$OUTSIDE/secret.txt"
ln -s "$OUTSIDE/secret.txt" "$ROOT/escape-link"

say "0. bwrap presence and namespace capability"

if ! command -v bwrap >/dev/null 2>&1; then
  no "bwrap is not on PATH"
  echo
  echo "bwrap unavailable; nothing further to probe."
  exit 1
fi
ok "bwrap is on PATH ($(command -v bwrap))"

# ADR-006 is fail-closed, so detection must prove a namespace can actually be
# created. Presence on PATH is not evidence: a hardened host ships the binary and
# refuses the unshare.
if bwrap --ro-bind / / --unshare-net true 2>/dev/null; then
  ok "bwrap can create a namespace (presence check would have agreed here)"
else
  no "bwrap present but cannot create a namespace — this is the case fail-closed must catch"
  echo
  echo "Detection MUST attempt a namespace, not just look for the binary."
  exit 1
fi

say "1. filesystem layout of this host"

for p in /bin /lib /lib64 /sbin /usr/bin; do
  if [ -L "$p" ]; then
    info "$p is a symlink -> $(readlink "$p")   (merged-usr layout)"
  elif [ -d "$p" ]; then
    info "$p is a real directory                (split-usr layout)"
  else
    info "$p is absent"
  fi
done

# The bind set cannot be hardcoded: merged-usr hosts need /bin to be a symlink
# into /usr, split-usr hosts need a real bind. The production probe has to
# discover this per host.

build_binds() {
  # Emit the toolchain bind arguments appropriate to this host's layout.
  local args=(--ro-bind /usr /usr)
  local p
  for p in /bin /lib /lib64 /sbin; do
    if [ -L "$p" ]; then
      args+=(--symlink "$(readlink "$p")" "$p")
    elif [ -d "$p" ]; then
      args+=(--ro-bind "$p" "$p")
    fi
  done
  [ -d /etc ] && args+=(--ro-bind /etc /etc)
  printf '%s\n' "${args[@]}"
}

mapfile -t TOOLCHAIN_BINDS < <(build_binds)
info "toolchain binds: ${TOOLCHAIN_BINDS[*]}"

# NOTE the ordering below. bwrap applies operations in argument order, so
# --tmpfs /tmp AFTER binding a root that lives under /tmp will mount straight over
# it and the root vanishes. This bit us on the first attempt. Either mount the
# tmpfs first, or do not place the root under /tmp. Production must not assume the
# root is outside /tmp, because on a real host it might be anywhere.
sandbox() {
  local root="$1"
  shift
  bwrap \
    --tmpfs /tmp \
    "${TOOLCHAIN_BINDS[@]}" \
    --ro-bind "$root" "$root" \
    --proc /proc \
    --dev /dev \
    --unshare-net \
    --unshare-pid \
    --die-with-parent \
    --new-session \
    --chdir "$root" \
    -- "$@"
}

say "2. can the search tools run inside the sandbox?"

for tool in grep find ls cat stat; do
  if sandbox "$ROOT" "$tool" --version >/dev/null 2>&1 || sandbox "$ROOT" "$tool" . >/dev/null 2>&1; then
    ok "$tool runs inside the sandbox"
  else
    no "$tool does NOT run inside the sandbox"
  fi
done

if command -v rg >/dev/null 2>&1; then
  if sandbox "$ROOT" rg --version >/dev/null 2>&1; then
    ok "rg runs inside the sandbox"
  else
    no "rg is installed but does NOT run inside the sandbox"
  fi
else
  info "rg not installed on this host; skipping"
fi

say "3. does grep actually return results from the root?"

if out="$(sandbox "$ROOT" grep -r needle . 2>&1)" && [ -n "$out" ]; then
  ok "grep found content under the root: ${out}"
else
  no "grep returned nothing (out=${out:-<empty>})"
fi

say "4. is the root genuinely read-only?"

if sandbox "$ROOT" sh -c 'echo mutated > ./sub/file.txt' 2>/dev/null; then
  no "write to the root SUCCEEDED — ro-bind is not holding"
else
  ok "write to the root was refused"
fi

if [ "$(cat "$ROOT/sub/file.txt")" = 'needle in the haystack' ]; then
  ok "file contents unchanged on the host"
else
  no "file contents were modified on the host"
fi

if sandbox "$ROOT" sh -c 'touch ./newfile' 2>/dev/null; then
  no "creating a new file in the root SUCCEEDED"
else
  ok "creating a new file in the root was refused"
fi

say "5. is /tmp writable but private?"

# A tmpfs /tmp is deliberate: some tools want scratch space, and giving them a
# private one is safer than either denying it or exposing the host's.
if sandbox "$ROOT" sh -c 'echo x > /tmp/scratch && cat /tmp/scratch' >/dev/null 2>&1; then
  ok "/tmp is writable inside the sandbox"
  if [ -e /tmp/scratch ]; then
    no "/tmp/scratch leaked to the host"
  else
    ok "/tmp writes did not leak to the host"
  fi
else
  info "/tmp is not writable inside the sandbox"
fi

say "6. is the network unreachable?"

# --unshare-net should leave only loopback. Tested without DNS so a slow resolver
# cannot be mistaken for isolation.
if sandbox "$ROOT" sh -c 'cat < /dev/tcp/1.1.1.1/53' 2>/dev/null; then
  no "outbound TCP SUCCEEDED — --unshare-net is not holding"
else
  ok "outbound TCP was refused"
fi

say "7. can a symlink inside the root escape it?"

# This is the question ADR-007 defers to Phase 2. Lexical containment in core
# cannot see this, so the answer determines whether bwrap alone is sufficient.
if out="$(sandbox "$ROOT" cat ./escape-link 2>/dev/null)"; then
  no "symlink escape SUCCEEDED, read: ${out} — bwrap alone does NOT contain symlinks"
else
  ok "symlink to a path outside every bind could not be followed"
fi

# The harder case. The check above only proves that a symlink to a path that is
# not in the mount namespace dangles — which is unsurprising. But /etc and /usr
# ARE bound, because the toolchain needs them. A symlink from inside the root to
# a bound path resolves perfectly well, and bwrap has no reason to stop it.
ln -s /etc/hostname "$ROOT/link-to-bound-path"
if out="$(sandbox "$ROOT" cat ./link-to-bound-path 2>/dev/null)"; then
  no "symlink into a BOUND path resolved, read: ${out}"
  info "bwrap does not contain this; the tool layer must canonicalise on the remote"
else
  ok "symlink into a bound path could not be followed"
fi

# And the same question for a directory traversal that a tool might follow on its
# own, rather than one we hand it explicitly.
if out="$(sandbox "$ROOT" find . -follow -name hostname 2>/dev/null)" && [ -n "$out" ]; then
  no "find -follow traversed the symlink into a bound path: ${out}"
else
  ok "find did not traverse into a bound path"
fi

say "8. what is visible outside the root?"

if sandbox "$ROOT" sh -c "ls $OUTSIDE" >/dev/null 2>&1; then
  no "the sibling directory outside the root is visible"
else
  ok "the sibling directory outside the root is not visible"
fi

if sandbox "$ROOT" sh -c 'ls /home' >/dev/null 2>&1; then
  no "/home is visible inside the sandbox"
else
  ok "/home is not visible inside the sandbox"
fi

# /etc is bound read-only because ld.so and nsswitch need it. That means files
# under /etc ARE readable inside the sandbox. Worth knowing explicitly: bwrap is
# not providing confidentiality here, which is consistent with ADR-006 — the
# allowlist and (later) .aiignore do that job.
if sandbox "$ROOT" sh -c 'cat /etc/hostname' >/dev/null 2>&1; then
  info "/etc IS readable inside the sandbox (expected: needed for ld.so/nsswitch)"
fi

say "summary"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "Some properties did not hold. These are findings for design/adr.md, not"
  echo "necessarily bugs — record them before writing the production sandbox."
fi

exit 0
