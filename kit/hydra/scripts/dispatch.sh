#!/usr/bin/env bash
# hydra/scripts/dispatch.sh — adapter selection + timeout + session capture.
#
# wave0-implementation.md §2.3. Selects the vendor adapter from the task spec,
# wraps the worker in a timeout, records exit code / timeout as ledger events
# BEFORE parsing anything, and captures the session id into sessions/.
#
# The worker writes its (untrusted) result to the run inbox. Nothing here
# trusts that output — promotion (promote.sh) is the boundary.
#
# Usage:
#   dispatch.sh <run_id> <task_id> [--background]
#
# Prints the agent_run_id.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

run_id="${1:?usage: dispatch.sh <run_id> <task_id> [--background]}"
task_id="${2:?usage: dispatch.sh <run_id> <task_id> [--background]}"
background="${3:-}"

repo_root="$(hydra_repo_root)"
run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "instantiated task spec not found: $task_spec"

vendor="$(hydra_yaml_scalar "$task_spec" 'assigned_vendor')"
worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
timeout_min="$(hydra_yaml_scalar "$task_spec" 'timeout_minutes')"
[ -n "$timeout_min" ] || timeout_min=45
adapter="$repo_root/hydra/adapters/$vendor.sh"

[ -f "$adapter" ] || hydra_die "no adapter for vendor '$vendor': $adapter"
[ -d "$worktree" ] || hydra_die "worktree not created yet (run create-worktree.sh): $worktree"

# agent_run_id is deterministic per (run,task,spec_version) so a resume/retry
# is traceable. Suffix disambiguation is the adapter's concern.
spec_version="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
agent_run_id="${run_id}-${task_id}-v${spec_version:-1}"
inbox="$run_dir/inbox/$agent_run_id"
mkdir -p "$inbox"
sessions_dir="$run_dir/sessions"
mkdir -p "$sessions_dir"

# Delivery mode (Wave 1 resume protocol). For resume, locate the most recent
# non-empty session id captured for this task and hand it to the adapter's
# resume verb; fall back to start if none or the vendor lacks a resume verb.
delivery="${HYDRA_DELIVERY:-start}"
verb=start
prior_session=""
if [ "$delivery" = resume ]; then
  prior_session="$(ls -t "$sessions_dir"/${run_id}-${task_id}-v*.json 2>/dev/null \
    | while read -r f; do sid="$(jq -r '.session_id // empty' "$f" 2>/dev/null)"; [ -n "$sid" ] && { echo "$sid"; break; }; done)"
  if [ -n "$prior_session" ] && grep -qF 'start|resume' "$adapter" 2>/dev/null; then
    verb=resume
  else
    hydra_warn "resume requested but unavailable (no session / adapter lacks resume) — cold restart"
  fi
fi

hydra_ledger_append "$run_id" task_started task_id "$task_id" vendor "$vendor" \
  agent_run_id "$agent_run_id" delivery "$delivery"

# Concurrency cap (Wave 1). Per vendor-adapters, the cap is min(16, cores-2).
# Backgrounded dispatches acquire a slot marker and wait when the pool is full.
cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
cap="${HYDRA_MAX_CONCURRENCY:-$(( cores > 2 ? (cores - 2 < 16 ? cores - 2 : 16) : 1 ))}"
slots_dir="$run_dir/.slots"; mkdir -p "$slots_dir"

acquire_slot() {
  local waited=0
  while : ; do
    local n; n="$(find "$slots_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
    [ "$n" -lt "$cap" ] && break
    [ "$waited" -eq 0 ] && hydra_ledger_append "$run_id" concurrency_wait task_id "$task_id" cap "$cap" active "$n"
    waited=1; sleep 1
  done
  : >"$slots_dir/$agent_run_id"
}
release_slot() { rm -f "$slots_dir/$agent_run_id"; }

run_worker() {
  local rc=0
  hydra_timeout $(( timeout_min * 60 )) \
    "$adapter" "$verb" "$task_spec" "$worktree" "$inbox" "$sessions_dir" "$agent_run_id" "$prior_session" \
    || rc=$?
  if [ "$rc" -eq 124 ]; then
    hydra_ledger_append "$run_id" agent_timed_out task_id "$task_id" vendor "$vendor"
  else
    hydra_ledger_append "$run_id" agent_exited task_id "$task_id" vendor "$vendor" exit_code "$rc"
  fi
  # Budget/usage accounting (Wave 1) — parse the adapter session capture.
  "$SELF_DIR/record-usage.sh" "$run_id" "$task_id" "$vendor" "$agent_run_id" 2>/dev/null || true
  release_slot
  return 0
}

if [ "$background" = "--background" ]; then
  acquire_slot
  run_worker &
  hydra_log "dispatched $agent_run_id ($vendor, $verb) in background (pid $!, cap $cap)"
else
  acquire_slot
  run_worker
fi

printf '%s\n' "$agent_run_id"
