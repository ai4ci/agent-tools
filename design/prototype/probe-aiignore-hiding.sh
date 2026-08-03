#!/usr/bin/env bash
#
# PROTOTYPE — exploratory only. Per AGENTS.md, design/ scripts are instructional
# and must be rewritten for production.
#
# Question: can `.aiignore` be enforced by bwrap rather than by filtering in the
# tool layer? The proposed mechanism is to symlink each hidden path to a
# non-existent target and let the sandbox produce "not found" naturally.
#
# That would be much better than tool-layer filtering: uniform across every tool,
# impossible for a new tool to forget, and no per-tool exclusion flags. But it
# rests on two assumptions this script tests:
#
#   A. bwrap can create a symlink at a path inside a read-only bind.
#   B. a dangling symlink is *invisible*, not merely unreadable.
#
# Assumption B is the one to watch: a symlink is still a directory entry, so `ls`
# may well list the name even though the target does not resolve. "Invisible" and
# "unreadable" are different guarantees, and the requirement is invisibility.
#
# Also tests a fallback: overlay the parent directory with a tmpfs and re-bind only
# the permitted entries, which should give true invisibility at the cost of one
# bind per surviving entry.
#
# Usage: bash design/prototype/probe-aiignore-hiding.sh

set -uo pipefail

PASS=0
FAIL=0
say() { printf '\n=== %s ===\n' "$1"; }
ok() { printf '  [ok]   %s\n' "$1"; PASS=$((PASS + 1)); }
no() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
info() { printf '  ...    %s\n' "$1"; }

command -v bwrap >/dev/null 2>&1 || { echo "bwrap unavailable"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ROOT="$WORK/root"
mkdir -p "$ROOT/sub"
echo 'PUBLIC CONTENT' > "$ROOT/public.txt"
echo 'SECRET=hunter2' > "$ROOT/.env"
echo 'BEGIN PRIVATE KEY' > "$ROOT/id_rsa"
echo 'nested public' > "$ROOT/sub/ok.txt"
echo 'nested secret' > "$ROOT/sub/secret.txt"
printf '.env\nid_rsa\nsub/secret.txt\n' > "$ROOT/.aiignore"

# Minimal toolchain binds, as the production sandbox discovers them.
build_binds() {
  local args=(--ro-bind /usr /usr)
  local p
  for p in /bin /lib /lib64 /sbin; do
    if [ -L "$p" ]; then args+=(--symlink "$(readlink "$p")" "$p")
    elif [ -d "$p" ]; then args+=(--ro-bind "$p" "$p"); fi
  done
  [ -d /etc ] && args+=(--ro-bind /etc /etc)
  printf '%s\n' "${args[@]}"
}
mapfile -t BINDS < <(build_binds)

say "A. can bwrap create a symlink inside a read-only bind?"

# Note --tmpfs /tmp first: the root lives under /tmp (ADR-012 finding 1).
if out=$(bwrap --tmpfs /tmp "${BINDS[@]}" \
      --ro-bind "$ROOT" "$ROOT" \
      --symlink /does/not/exist "$ROOT/.env" \
      --proc /proc --dev /dev --unshare-net --unshare-pid --die-with-parent \
      --chdir "$ROOT" -- cat ./public.txt 2>&1); then
  ok "bwrap accepted --symlink over a path inside a --ro-bind (read: $out)"
  SYMLINK_WORKS=1
else
  no "bwrap rejected --symlink inside a --ro-bind: $out"
  info "if this is EROFS, the mechanism needs the symlink applied before the bind"
  SYMLINK_WORKS=0
fi

sandbox_hidden() {
  bwrap --tmpfs /tmp "${BINDS[@]}" \
    --ro-bind "$ROOT" "$ROOT" \
    --symlink /does/not/exist "$ROOT/.env" \
    --symlink /does/not/exist "$ROOT/id_rsa" \
    --symlink /does/not/exist "$ROOT/sub/secret.txt" \
    --symlink /does/not/exist "$ROOT/.aiignore" \
    --proc /proc --dev /dev --unshare-net --unshare-pid --die-with-parent \
    --chdir "$ROOT" -- "$@"
}

if [ "$SYMLINK_WORKS" = "1" ]; then
  say "B. is the hidden path unreadable?"

  if sandbox_hidden cat ./.env >/dev/null 2>&1; then
    no "reading .env SUCCEEDED — content is not protected"
  else
    ok "reading .env fails"
  fi

  if out=$(sandbox_hidden cat ./.env 2>&1); then :; else
    if echo "$out" | grep -qi "no such file"; then
      ok "the error is 'No such file or directory', as required"
    else
      info "error text was: $out"
    fi
  fi

  if sandbox_hidden cat ./public.txt >/dev/null 2>&1; then
    ok "a permitted file is still readable"
  else
    no "a permitted file became unreadable"
  fi

  say "B2. is the hidden path INVISIBLE? (the actual requirement)"

  listing=$(sandbox_hidden ls -1A . 2>/dev/null)
  info "ls -1A returned: $(echo "$listing" | tr '\n' ' ')"

  if echo "$listing" | grep -qx '.env'; then
    no "ls still lists .env — the NAME leaks, only the content is hidden"
  else
    ok "ls does not list .env"
  fi

  if echo "$listing" | grep -qx '.aiignore'; then
    no "ls still lists .aiignore — the ignore file itself is not invisible"
  else
    ok "ls does not list .aiignore"
  fi

  found=$(sandbox_hidden find . 2>/dev/null)
  if echo "$found" | grep -q 'secret.txt'; then
    no "find still reports sub/secret.txt"
  else
    ok "find does not report sub/secret.txt"
  fi

  if echo "$found" | grep -q 'id_rsa'; then
    no "find still reports id_rsa"
  else
    ok "find does not report id_rsa"
  fi

  say "B3. does a content search leak anything?"

  if sandbox_hidden grep -r hunter2 . >/dev/null 2>&1; then
    no "grep found the secret value"
  else
    ok "grep cannot read the secret value"
  fi

  # A dangling symlink makes grep emit an error naming the file, which is itself a
  # disclosure of the name.
  errs=$(sandbox_hidden grep -r hunter2 . 2>&1 >/dev/null)
  if echo "$errs" | grep -q '.env'; then
    no "grep's stderr names .env: $(echo "$errs" | head -1)"
  else
    ok "grep's stderr does not name the hidden file"
  fi
fi

say "C. fallback: tmpfs over the parent, re-binding only permitted entries"

# Should give true invisibility: the directory the sandbox sees is a fresh tmpfs
# containing only what we chose to bind into it.
if out=$(bwrap --tmpfs /tmp "${BINDS[@]}" \
      --tmpfs "$ROOT" \
      --ro-bind "$ROOT/public.txt" "$ROOT/public.txt" \
      --ro-bind "$ROOT/sub" "$ROOT/sub" \
      --proc /proc --dev /dev --unshare-net --unshare-pid --die-with-parent \
      --chdir "$ROOT" -- ls -1A . 2>&1); then
  info "ls returned: $(echo "$out" | tr '\n' ' ')"
  if echo "$out" | grep -qx '.env'; then
    no "tmpfs overlay still exposes .env"
  else
    ok "tmpfs overlay hides .env completely — the name is absent"
  fi
  if echo "$out" | grep -qx 'public.txt'; then
    ok "permitted file survives the overlay"
  else
    no "permitted file was lost"
  fi
else
  no "tmpfs overlay approach failed: $out"
fi

# The overlay is per-directory, so a nested exclusion needs its own overlay.
if out=$(bwrap --tmpfs /tmp "${BINDS[@]}" \
      --tmpfs "$ROOT" \
      --ro-bind "$ROOT/public.txt" "$ROOT/public.txt" \
      --tmpfs "$ROOT/sub" \
      --ro-bind "$ROOT/sub/ok.txt" "$ROOT/sub/ok.txt" \
      --proc /proc --dev /dev --unshare-net --unshare-pid --die-with-parent \
      --chdir "$ROOT" -- find . 2>&1); then
  info "find returned: $(echo "$out" | tr '\n' ' ')"
  if echo "$out" | grep -q 'secret.txt'; then
    no "nested overlay still exposes sub/secret.txt"
  else
    ok "nested overlay hides sub/secret.txt completely"
  fi
else
  no "nested overlay failed: $out"
fi

say "summary"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
exit 0
