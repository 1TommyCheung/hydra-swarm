#!/usr/bin/env bash
# hydra/scripts/audit-ownership.sh — authoritative ownership gate.
#
# Implements the full rule set of trust-and-permissions.md §5. This is layer 4
# (post-hoc Git diff audit) and is authoritative: tool hooks and sandboxes are
# defense in depth, but THIS is what decides whether a candidate stayed in its
# lane. Runs at promotion, before any result is accepted.
#
# Usage:
#   audit-ownership.sh <worktree> <base_commit> <head_commit> <writable_glob>...
#
# Exit 0  -> clean (no violations)
# Exit 3  -> violation(s); each printed to stdout as "VIOLATION: <reason>"
# Exit 2  -> usage / internal error
#
# Standalone: depends only on git + lib.sh. No run/ledger coupling, so it is
# trivially unit-testable and reusable by promote.sh and integrate.sh.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" audit-ownership "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" audit-ownership "$@"
fi

[ "$#" -ge 4 ] || hydra_die "usage: audit-ownership.sh <worktree> <base> <head> <writable_glob>..."
worktree="$1"; base="$2"; head="$3"; shift 3
writable=("$@")

[ -d "$worktree" ] || hydra_die "worktree not found: $worktree"
git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1 || hydra_die "not a git worktree: $worktree"

violations=0
flag() { printf 'VIOLATION: %s\n' "$*"; violations=$((violations + 1)); }

# Assert a single repo-relative path is in-bounds: hygiene + writable globs.
check_path() {
  local path="$1" origin="$2"
  # Path hygiene (absolute / traversal). normalize dies on hard violations, so
  # guard it and convert a death into a reported violation instead.
  case "$path" in
    /*) flag "absolute path ($origin): $path"; return ;;
  esac
  case "/$path/" in
    */../*) flag "path traversal ($origin): $path"; return ;;
  esac
  if ! hydra_path_in_globs "$path" "${writable[@]}"; then
    flag "$origin outside writable_paths: $path"
  fi
}

# --- 1. Tracked changes: modified / added / deleted / renamed --------------
# Rename detection on; a rename is a write at BOTH old and new path.
while IFS= read -r -d '' status; do
  case "$status" in
    R*|C*)
      IFS= read -r -d '' oldp
      IFS= read -r -d '' newp
      check_path "$oldp" "renamed-from"
      check_path "$newp" "renamed-to"
      ;;
    *)
      IFS= read -r -d '' p
      check_path "$p" "changed"
      # Submodule pointer change: gitlink mode 160000 at head.
      if git -C "$worktree" ls-tree "$head" -- "$p" 2>/dev/null | grep -q '^160000 '; then
        if ! hydra_path_in_globs "$p" "${writable[@]}"; then
          flag "submodule pointer change outside writable_paths: $p"
        fi
      fi
      ;;
  esac
done < <(git -C "$worktree" diff --name-status -z -M -C "$base...$head")

# --- 2. Untracked files (generated files, package side-effects) ------------
while IFS= read -r -d '' u; do
  [ -n "$u" ] || continue
  check_path "$u" "untracked"
done < <(git -C "$worktree" ls-files --others --exclude-standard -z)

# --- 3. Symlink-escape guard ------------------------------------------------
# Any new or modified symlink whose target resolves outside writable_paths.
# We inspect all symlinks that appear in the changed+untracked set.
resolve_symlinks() {
  # Emit repo-relative paths of symlinks among changed + untracked files.
  {
    git -C "$worktree" diff --name-only -z "$base...$head"
    git -C "$worktree" ls-files --others --exclude-standard -z
  } | while IFS= read -r -d '' f; do
    [ -L "$worktree/$f" ] && printf '%s\0' "$f"
  done
}
while IFS= read -r -d '' link; do
  target="$(readlink "$worktree/$link" || true)"
  # Resolve relative to the symlink's directory.
  linkdir="$(dirname "$link")"
  if [ "${target#/}" != "$target" ]; then
    resolved_abs="$target"                       # absolute target
  else
    resolved_abs="$(cd "$worktree/$linkdir" 2>/dev/null && realpath -m "$target" 2>/dev/null || printf '')"
  fi
  wt_abs="$(realpath -m "$worktree")"
  # Escapes the worktree entirely?
  case "$resolved_abs" in
    "$wt_abs"/*) rel="${resolved_abs#"$wt_abs"/}"
                 hydra_path_in_globs "$rel" "${writable[@]}" \
                   || flag "symlink target outside writable_paths: $link -> $target" ;;
    *)           flag "symlink escapes worktree: $link -> $target" ;;
  esac
done < <(resolve_symlinks)

if [ "$violations" -gt 0 ]; then
  exit 3
fi
exit 0
