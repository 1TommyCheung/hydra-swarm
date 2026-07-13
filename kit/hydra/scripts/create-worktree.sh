#!/usr/bin/env bash
# hydra/scripts/create-worktree.sh — worktree bootstrap (Domain 3).
#
# state-and-worktrees.md §4 lifecycle, harness-executed BEFORE the worker
# exists:
#   create worktree -> install deps (bootstrap network policy) -> record
#   bootstrap -> [Wave 1: index] -> network OFF -> worker starts.
#
# Also injects a unique PORT (parallel worktrees must never contend) and copies
# the instantiated task spec read-only into the worktree, excluded from Git so
# it can never trip the ownership audit.
#
# Usage:
#   create-worktree.sh <run_id> <task_id> [base_commit]
#
# Prints the worktree path. Updates the instantiated task spec with operational
# fields (worktree, branch, base_commit).

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/create-worktree.ts" "$@"
fi

run_id="${1:?usage: create-worktree.sh <run_id> <task_id> [base_commit]}"
task_id="${2:?usage: create-worktree.sh <run_id> <task_id> [base_commit]}"
repo_root="$(hydra_repo_root)"
run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "instantiated task spec not found: $task_spec"

base_commit="${3:-$(hydra_yaml_scalar "$task_spec" 'base_commit')}"
[ -n "$base_commit" ] || base_commit="$(git -C "$repo_root" rev-parse HEAD)"

# Deterministic, reserved-prefix branch + path (no random; state-and-worktrees §1).
branch="hydra/$run_id/$task_id"
worktree="$(hydra_worktree_root)/run-$run_id-$task_id"

[ -e "$worktree" ] && hydra_die "worktree path already exists: $worktree"
mkdir -p "$(dirname "$worktree")"

git -C "$repo_root" worktree add --quiet -b "$branch" "$worktree" "$base_commit" \
  || hydra_die "git worktree add failed"

# Exclude harness-injected files from Git so they never appear as untracked in
# the ownership audit. Per-worktree exclude file.
exclude_file="$(git -C "$worktree" rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$exclude_file")"
{ echo '.hydra-task.yaml'; echo '.env.worktree'; echo '.hydra-result.json'; echo '.gitnexus/'; } >>"$exclude_file"

# Read-only copy of the task spec for the worker (workers never see the state store).
cp "$task_spec" "$worktree/.hydra-task.yaml"
chmod 0444 "$worktree/.hydra-task.yaml"

# Unique PORT derived deterministically from run+task (no RNG allowed).
port=$(( 20000 + ( $(printf '%s' "$run_id/$task_id" | cksum | cut -d' ' -f1) % 20000 ) ))
printf 'PORT=%s\n' "$port" >"$worktree/.env.worktree"

# --- Bootstrap phase: policy-driven, under the bootstrap network policy -------
# (Different policy from worker network, which is off.) Runs `common` steps
# every wave; `wave_1` steps only when HYDRA_WAVE>=1 or the hydra/WAVE marker
# says so (state-and-worktrees §4; bootstrap.yaml). code-intelligence §2.1: any
# index built here is for the worker's OWN navigation; review indexes are rebuilt
# post-freeze by index-candidate.sh.
bootstrap_status=ok
bootstrap_policy="$repo_root/hydra/policies/bootstrap.yaml"
wave_level="${HYDRA_WAVE:-$( [ -f "$repo_root/hydra/WAVE" ] && cat "$repo_root/hydra/WAVE" || echo 0 )}"
run_bootstrap_steps() {
  local key="$1"
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    ( cd "$worktree" && HYDRA_TASK_ID="$task_id" HYDRA_RUN_ID="$run_id" \
        hydra_timeout 600 bash -c "$step" ) || return 1
  done < <(hydra_yaml_list "$bootstrap_policy" "  $key")
}
if [ -f "$bootstrap_policy" ]; then
  run_bootstrap_steps common || bootstrap_status=failed
  if [ "$bootstrap_status" = ok ] && [ "${wave_level:-0}" -ge 1 ] 2>/dev/null; then
    run_bootstrap_steps wave_1 || bootstrap_status=failed
    hydra_log "wave_1 bootstrap steps executed (wave level $wave_level)"
  fi
fi

# --- Persist operational fields back into the instantiated task spec --------
tmp="$(mktemp)"
awk -v wt="$worktree" -v br="$branch" -v bc="$base_commit" '
  /^worktree:/    { print "worktree: " wt; next }
  /^branch:/      { print "branch: " br; next }
  /^base_commit:/ { print "base_commit: " bc; next }
  { print }
' "$task_spec" >"$tmp"
# Append any missing keys.
grep -q '^worktree:'    "$tmp" || printf 'worktree: %s\n' "$worktree" >>"$tmp"
grep -q '^branch:'      "$tmp" || printf 'branch: %s\n' "$branch" >>"$tmp"
mv "$tmp" "$task_spec"

hydra_ledger_append "$run_id" worktree_bootstrapped task_id "$task_id" \
  status "$bootstrap_status" worktree "$worktree" port "$port"
[ "$bootstrap_status" = ok ] || hydra_die "bootstrap failed for $task_id"

hydra_log "worktree ready: $worktree (branch $branch, PORT $port)"
printf '%s\n' "$worktree"
