# shellcheck shell=bash
# hydra/scripts/lib.sh — shared harness helpers (sourced by every script).
#
# Design contract (architecture.md §4.8, Wave 0 trust decision):
#   - The lead calls scripts; scripts are the ONLY writers of authoritative state.
#   - Workers never source this file (they never see the state store).
#   - Every state mutation goes through a logged function here.
#
# This file defines functions only. It performs no work when sourced.

# ---------------------------------------------------------------------------
# Strict-mode helper: callers `set -euo pipefail`; we provide the plumbing.
# ---------------------------------------------------------------------------

hydra_die() { printf 'hydra: error: %s\n' "$*" >&2; exit 1; }
hydra_warn() { printf 'hydra: warn: %s\n' "$*" >&2; }
hydra_log() { printf 'hydra: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Repository + state locations.
# ---------------------------------------------------------------------------

# Absolute path to the main repository checkout.
hydra_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null \
    || hydra_die "not inside a git repository"
}

# Stable identifier for this repository. Overridable so a clone on another
# machine can pin the same id. Defaults to the checkout's basename.
hydra_repo_id() {
  if [ -n "${HYDRA_REPO_ID:-}" ]; then
    printf '%s' "$HYDRA_REPO_ID"
  else
    basename "$(hydra_repo_root)"
  fi
}

# External runtime-state root (Domain 2). Never inside any worktree; never
# tracked. Overridable via HYDRA_STATE_ROOT (the boundary tests use this to
# redirect state into a throwaway directory).
hydra_state_root() {
  if [ -n "${HYDRA_STATE_ROOT:-}" ]; then
    printf '%s' "$HYDRA_STATE_ROOT"
  else
    local base="${XDG_STATE_HOME:-$HOME/.local/state}"
    printf '%s/%s-hydra' "$base" "$(hydra_repo_id)"
  fi
}

# Worktree parent (Domain 3). Overridable via HYDRA_WORKTREE_ROOT.
hydra_worktree_root() {
  if [ -n "${HYDRA_WORKTREE_ROOT:-}" ]; then
    printf '%s' "$HYDRA_WORKTREE_ROOT"
  else
    printf '%s/worktrees/%s' "$HOME" "$(hydra_repo_id)"
  fi
}

hydra_run_dir()   { printf '%s/runs/run-%s' "$(hydra_state_root)" "$1"; }
hydra_auth_dir()  { printf '%s/authoritative' "$(hydra_run_dir "$1")"; }
hydra_inbox_dir() { printf '%s/inbox' "$(hydra_run_dir "$1")"; }
hydra_ledger()    { printf '%s/ledger/events.jsonl' "$(hydra_auth_dir "$1")"; }

# ---------------------------------------------------------------------------
# Time. Deterministic ISO-8601 UTC.
# ---------------------------------------------------------------------------

hydra_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# Ledger. Append-only, harness-written (task-result-review-contracts.md §7).
# Usage: hydra_ledger_append <run_id> <event> [k v]...
# Builds a JSON object with time+event and any extra key/value string pairs.
# ---------------------------------------------------------------------------

hydra_ledger_append() {
  local run_id="$1" event="$2"; shift 2
  local ledger; ledger="$(hydra_ledger "$run_id")"
  mkdir -p "$(dirname "$ledger")"
  local args=(--arg time "$(hydra_now)" --arg event "$event")
  local filter='{time:$time, event:$event, run_id:$rid}'
  args+=(--arg rid "$run_id")
  while [ "$#" -ge 2 ]; do
    args+=(--arg "k_$1" "$2")
    filter="$filter + {\"$1\":\$k_$1}"
    shift 2
  done
  jq -cn "${args[@]}" "$filter" >>"$ledger" \
    || hydra_die "failed to append ledger event: $event"
}

# ---------------------------------------------------------------------------
# Portable timeout. macOS ships no coreutils `timeout`. Prefer real binaries,
# fall back to perl's alarm (present on macOS).
# Usage: hydra_timeout <seconds> <cmd> [args...]
# Exit 124 on timeout, matching GNU timeout convention.
# ---------------------------------------------------------------------------

hydra_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e '
      my $s = shift;
      my $pid = fork();
      if ($pid == 0) { exec @ARGV or exit 127; }
      local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; exit 124; };
      alarm $s;
      waitpid($pid, 0);
      exit($? >> 8);
    ' "$secs" "$@"
  else
    hydra_warn "no timeout mechanism available; running without a time limit"
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Path normalization + hygiene (trust-and-permissions.md §5, "Path hygiene").
# Rejects absolute paths and `..` traversal. Returns a clean repo-relative
# path or fails. Does not touch the filesystem (works on strings).
# ---------------------------------------------------------------------------

hydra_normalize_relpath() {
  local p="$1"
  case "$p" in
    /*) hydra_die "absolute path not allowed: $p" ;;
  esac
  # Reject any `..` component.
  case "/$p/" in
    */../*) hydra_die "path traversal not allowed: $p" ;;
  esac
  # Strip leading ./ and collapse duplicate slashes.
  p="${p#./}"
  while [ "$p" != "${p//\/\//\/}" ]; do p="${p//\/\//\/}"; done
  printf '%s' "$p"
}

# Glob match: does repo-relative PATH fall under any of the given `**` globs?
# Globs use `**` for "any depth". Returns 0 (match) / 1 (no match).
# Usage: hydra_path_in_globs <path> <glob1> <glob2> ...
hydra_path_in_globs() {
  local path="$1"; shift
  local g re
  for g in "$@"; do
    [ -n "$g" ] || continue
    # Translate a hydra glob to an ERE anchored at both ends.
    #   **  -> .*        (any depth, including zero segments)
    #   *   -> [^/]*     (single segment)
    #   .   -> \.
    # Sentinel must be a byte bash can hold in a variable — NUL cannot, so use
    # \x1f (unit separator), which never appears in a repo-relative path.
    local sentinel=$'\x1f'
    re="$g"
    re="${re//./\\.}"
    re="${re//\*\*/$sentinel}"  # placeholder for **
    re="${re//\*/[^/]*}"        # single-segment *
    re="${re//$sentinel/.*}"    # restore ** as .*
    if printf '%s' "$path" | grep -Eq "^${re}$"; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# YAML-ish accessor for the simple key/list shapes in policy + task files.
# We keep policies deliberately flat so we can parse without a YAML dep.
# Usage: hydra_yaml_list <file> <top_key>   -> prints one list item per line
# Matches:
#   top_key:
#     - item one
#     - item two
# ---------------------------------------------------------------------------

hydra_yaml_list() {
  local file="$1" key="$2"
  awk -v key="$key" '
    $0 ~ "^"key":[[:space:]]*$" { grab=1; next }
    grab && /^[[:space:]]*-[[:space:]]*/ {
      line=$0; sub(/^[[:space:]]*-[[:space:]]*/, "", line);
      # strip surrounding quotes
      gsub(/^"|"$/, "", line);
      print line; next
    }
    grab && /^[^[:space:]-]/ { grab=0 }
  ' "$file"
}

# Scalar accessor: `key: value` at top level. Strips quotes.
hydra_yaml_scalar() {
  local file="$1" key="$2"
  awk -v key="$key" '
    $0 ~ "^"key":[[:space:]]*" {
      line=$0; sub("^"key":[[:space:]]*", "", line);
      gsub(/^"|"$/, "", line);
      gsub(/[[:space:]]*$/, "", line);
      print line; exit
    }
  ' "$file"
}
