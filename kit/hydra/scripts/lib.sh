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

# Resolve a Node.js runtime new enough to execute TypeScript via
# --experimental-strip-types. The result is cached only in this shell process;
# every entry-point invocation performs a fresh resolution.
_hydra_node_version() {
  "$1" -p 'process.versions.node' 2>/dev/null
}

_hydra_node_meets_requirement() {
  local version major minor patch
  version="$(_hydra_node_version "$1")" || return 1
  version="${version#v}"
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( 10#$major > 22 || (10#$major == 22 && 10#$minor >= 6) ))
}

_hydra_node_version_is_greater() {
  local candidate="${1#v}" current="${2#v}"
  local candidate_major candidate_minor candidate_patch
  local current_major current_minor current_patch

  [ -z "$current" ] && return 0
  candidate="${candidate%%-*}"
  current="${current%%-*}"
  IFS=. read -r candidate_major candidate_minor candidate_patch <<<"$candidate"
  IFS=. read -r current_major current_minor current_patch <<<"$current"
  [[ "$candidate_major" =~ ^[0-9]+$ && "$candidate_minor" =~ ^[0-9]+$ && "$candidate_patch" =~ ^[0-9]+$ ]] || return 1
  [[ "$current_major" =~ ^[0-9]+$ && "$current_minor" =~ ^[0-9]+$ && "$current_patch" =~ ^[0-9]+$ ]] || return 0

  (( 10#$candidate_major > 10#$current_major )) && return 0
  (( 10#$candidate_major < 10#$current_major )) && return 1
  (( 10#$candidate_minor > 10#$current_minor )) && return 0
  (( 10#$candidate_minor < 10#$current_minor )) && return 1
  (( 10#$candidate_patch > 10#$current_patch ))
}

_hydra_absolute_node_path() {
  local candidate="$1" directory basename
  case "$candidate" in
    /*) ;;
    *) candidate="$PWD/$candidate" ;;
  esac
  directory="${candidate%/*}"
  basename="${candidate##*/}"
  directory="$(cd "$directory" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s' "$directory" "$basename"
}

hydra_resolve_node() {
  local candidate version resolved
  local best_node='' best_version=''

  if [ -n "${_HYDRA_RESOLVED_NODE:-}" ] \
    && _hydra_node_meets_requirement "$_HYDRA_RESOLVED_NODE"; then
    printf '%s\n' "$_HYDRA_RESOLVED_NODE"
    return 0
  fi

  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate" ] && _hydra_node_meets_requirement "$candidate"; then
    resolved="$(_hydra_absolute_node_path "$candidate")" || resolved=''
    if [ -n "$resolved" ]; then
      _HYDRA_RESOLVED_NODE="$resolved"
      printf '%s\n' "$resolved"
      return 0
    fi
  fi

  if [ -n "${HOME:-}" ]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
      [ -x "$candidate" ] || continue
      if _hydra_node_meets_requirement "$candidate"; then
        version="$(_hydra_node_version "$candidate")"
        if _hydra_node_version_is_greater "$version" "$best_version"; then
          best_node="$candidate"
          best_version="$version"
        fi
      fi
    done
  fi

  if [ -n "$best_node" ]; then
    _HYDRA_RESOLVED_NODE="$best_node"
    printf '%s\n' "$best_node"
    return 0
  fi

  for candidate in \
    /opt/homebrew/bin/node \
    /opt/homebrew/opt/node/bin/node \
    /usr/local/opt/node/bin/node; do
    if _hydra_node_meets_requirement "$candidate"; then
      _HYDRA_RESOLVED_NODE="$candidate"
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  hydra_die "Node.js >=22.6 is required for the TypeScript harness; install Node.js >=22.6 or set HYDRA_HARNESS=bash as a temporary workaround"
}

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

# Derived code-intelligence indexes (Wave 1+). External state, never tracked,
# keyed by repo-id then commit (code-intelligence.md §2.1).
hydra_indexes_root() { printf '%s/indexes' "$(hydra_state_root)"; }
hydra_gitnexus_dir() { printf '%s/gitnexus/%s/%s' "$(hydra_indexes_root)" "$(hydra_repo_id)" "$1"; }
# Graphify graphs are run-scoped by default (code-intelligence §3): keyed by run.
hydra_graphify_dir() { printf '%s/graphify/%s/run-%s' "$(hydra_indexes_root)" "$(hydra_repo_id)" "$1"; }

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
# Derive a result drop from GIT EVIDENCE when a worker committed but did not
# write .hydra-result.json (some vendors implement + commit yet skip the
# self-report). head_commit + files_changed are git-observable FACTS, not worker
# claims; verification_claims stays empty and promote.sh re-verifies everything,
# so this is safe and honest — it turns a silent-but-real candidate into a
# promotable one instead of a false "failed". Returns 0 if a drop was written
# (worker advanced HEAD past base), 1 otherwise (nothing committed).
# Usage: hydra_derive_drop_from_git <task_spec> <worktree> <vendor> <session_id> <out_json>
# ---------------------------------------------------------------------------

hydra_derive_drop_from_git() {
  local task_spec="$1" worktree="$2" vendor="$3" session_id="$4" out="$5"
  local base head; base="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
  head="$(git -C "$worktree" rev-parse HEAD 2>/dev/null)" || return 1
  # Nothing committed (HEAD still at base) => not a real candidate.
  [ -n "$head" ] && [ "$(git -C "$worktree" rev-parse "$base" 2>/dev/null)" != "$head" ] || return 1
  local files
  files="$(git -C "$worktree" diff --name-only "$base...HEAD" 2>/dev/null | jq -R . | jq -sc .)"
  jq -n \
    --arg t "$(hydra_yaml_scalar "$task_spec" 'task_id')" \
    --arg r "$(hydra_yaml_scalar "$task_spec" 'run_id')" \
    --argjson sv "$(hydra_yaml_scalar "$task_spec" 'spec_version')" \
    --arg v "$vendor" --arg sid "$session_id" \
    --arg b "$(hydra_yaml_scalar "$task_spec" 'branch')" \
    --arg bc "$base" --arg h "$head" --argjson files "${files:-[]}" '{
      task_id:$t, run_id:$r, spec_version:$sv, vendor:$v, session_id:$sid,
      status:"completed", branch:$b, base_commit:$bc, head_commit:$h,
      summary:"harness-derived from git (worker committed without a self-report)",
      files_changed:$files, verification_claims:[],
      risks:["no worker self-report; drop derived from git evidence"],
      unresolved_questions:[], suggested_additional_checks:[]
    }' >"$out"
  return 0
}

# ---------------------------------------------------------------------------
# Portable timeout. macOS ships no coreutils `timeout`. Prefer real binaries,
# fall back to perl's alarm (present on macOS).
# Usage: hydra_timeout <seconds> <cmd> [args...]
# Exit 124 on timeout, matching GNU timeout convention.
# ---------------------------------------------------------------------------

# Push a worker pane's agent state INTO herdr (Layer-1 live monitor).
#
# The herdr vendor integrations hook SESSION lifecycle events (SessionStart /
# UserPromptSubmit / Stop). Our workers run one-shot non-interactive (`codex
# exec`, `kimi -p`), so those events never fire and the pane sits at
# agent=null/unknown. That is precisely why the roadmap says the HARNESS pushes
# pane state from LEDGER events rather than herdr inferring it — so we drive the
# same installed hook ourselves, with the worker's pane id.
# Live state stays ADVISORY; Git + the ledger remain authoritative.
# We speak herdr's socket protocol directly rather than shelling out to a
# vendor's installed hook: each vendor hook hardcodes its own agent id (the kimi
# hook would label a Codex pane "kimi"), and the claude/codex hooks only accept
# the `session` action. Reporting ourselves lets us name the REAL vendor and
# identify the harness as the source.
#   method: pane.report_agent
#   params: {pane_id, source, agent, state, seq}   (newline-delimited JSON, AF_UNIX)
# Usage: hydra_herdr_state <pane_id> <vendor> <working|idle|blocked>
hydra_herdr_state() {
  local pane="${1:-}" vendor="${2:-}" state="${3:-}"
  [ -n "$pane" ] && [ -n "$vendor" ] && [ -n "$state" ] || return 0
  local sock="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
  [ -S "$sock" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  HYDRA_PANE="$pane" HYDRA_VENDOR="$vendor" HYDRA_STATE="$state" HYDRA_SOCK="$sock" \
  python3 - <<'PY' >/dev/null 2>&1 || true
import json, os, socket, time, random
req = {
    "id": f"herdr:hydra:{int(time.time()*1000)}:{random.randrange(1_000_000):06d}",
    "method": "pane.report_agent",
    "params": {
        "pane_id": os.environ["HYDRA_PANE"],
        "source": "herdr:hydra",          # the HARNESS is the reporter
        "agent": os.environ["HYDRA_VENDOR"],
        "state": os.environ["HYDRA_STATE"],
        "seq": time.time_ns(),
    },
}
try:
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.settimeout(0.5)
    c.connect(os.environ["HYDRA_SOCK"])
    c.sendall((json.dumps(req) + "\n").encode())
    try: c.recv(4096)
    except Exception: pass
    c.close()
except Exception:
    pass
PY
}

# Kill a process and every descendant. Backgrounding a shell FUNCTION creates a
# subshell, so the recorded pid is the subshell — signalling it alone orphans the
# real worker (and leaves an agent burning tokens). Walk the tree instead.
hydra_kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    hydra_kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
  ( sleep 2; kill -KILL "$pid" 2>/dev/null || true ) >/dev/null 2>&1 &
}

hydra_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    # The wrapper MUST forward termination to its child, or killing the wrapper
    # leaves an orphaned worker running (and a stray agent burning tokens).
    perl -e '
      my $s = shift;
      my $pid = fork();
      if ($pid == 0) { exec @ARGV or exit 127; }
      my $reap = sub {
        my ($code) = @_;
        kill "TERM", $pid; sleep 1; kill "KILL", $pid;
        exit $code;
      };
      local $SIG{ALRM} = sub { $reap->(124) };   # timeout
      local $SIG{TERM} = sub { $reap->(143) };   # cancelled
      local $SIG{INT}  = sub { $reap->(130) };
      local $SIG{HUP}  = sub { $reap->(129) };
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

# Block-scalar accessor: reads a YAML folded/literal block (`key: >` or `key: |`)
# — the indented lines that follow the key. Falls back to an inline value if the
# key has one on its own line. This existed as a latent gap: hydra_yaml_scalar
# only reads the same line, so `objective: >` blocks came back EMPTY, silently
# dropping the objective from every worker prompt.
# Usage: hydra_yaml_block <file> <top_key>   -> prints the block text (dedented)
hydra_yaml_block() {
  local file="$1" key="$2"
  awk -v key="$key" '
    $0 ~ "^"key":[[:space:]]*[|>]?[[:space:]]*$" && !grab {
      # Block-scalar header (key: , key: > , key: |). Start collecting.
      inline=$0; sub("^"key":[[:space:]]*", "", inline); gsub(/[|>[:space:]]/, "", inline);
      if (inline != "") { print inline; exit }   # actually an inline value
      grab=1; next
    }
    grab {
      if ($0 ~ /^[^[:space:]]/) exit             # dedent to col 0 => block ended
      line=$0; sub(/^[[:space:]]+/, "", line); print line
    }
  ' "$file" | sed -e 's/[[:space:]]*$//' | awk 'NF||p{print;p=1}'
}

# Scalar accessor: `key: value` at top level. Strips quotes.
hydra_yaml_scalar() {
  local file="$1" key="$2"
  awk -v key="$key" '
    $0 ~ "^"key":[[:space:]]*" {
      line=$0; sub("^"key":[[:space:]]*", "", line);
      # Strip an inline comment introduced by whitespace + # (not a leading #).
      sub(/[[:space:]]+#.*$/, "", line);
      gsub(/^"|"$/, "", line);
      gsub(/[[:space:]]*$/, "", line);
      print line; exit
    }
  ' "$file"
}
