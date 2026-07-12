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

# Every task_started MUST be closed by an exit event. If the dispatch is killed
# (SIGINT/SIGTERM/SIGHUP) the worker dies without recording one, leaving a
# dangling "running" task in the ledger — a real hole caught by reconciling the
# ledger against herdr's live view (herdr-push.sh). This trap guarantees closure.
exit_recorded=0
record_exit() {
  local event="$1" rc="${2:-}"
  [ "$exit_recorded" -eq 1 ] && return 0
  exit_recorded=1
  if [ -n "$rc" ]; then
    hydra_ledger_append "$run_id" "$event" task_id "$task_id" vendor "$vendor" exit_code "$rc"
  else
    hydra_ledger_append "$run_id" "$event" task_id "$task_id" vendor "$vendor"
  fi
  release_slot
}
worker_pid=""
herdr_pane_id=""    # set when the worker is hosted in a herdr pane
on_signal() {
  # Kill the worker AND its descendants (the recorded pid is a subshell), close
  # its terminal, then close the ledger entry before exiting.
  [ -n "$worker_pid" ] && hydra_kill_tree "$worker_pid"
  if [ -n "$herdr_pane_id" ] && [ "${HYDRA_HERDR_KEEP_PANE:-0}" != 1 ]; then
    herdr pane close "$herdr_pane_id" >/dev/null 2>&1 || true
  fi
  record_exit agent_cancelled
  hydra_warn "dispatch cancelled — agent_cancelled recorded (no dangling running task)"
  exit 130
}
trap on_signal INT TERM HUP

# --- Optional: host the worker in a herdr pane (HYDRA_HERDR_PANES=1) ---------
# herdr is the TERMINAL HOST only (like tmux): the harness still decides what to
# launch, owns the timeout, cancels, and writes the ledger; adapters still write
# their own session/result files, so structured capture + budget accounting are
# unaffected. Pane TEXT is never read as truth (observability.yaml). This does
# NOT make herdr own dispatch/worktrees/task lifecycle (roadmap non-goal).
herdr_live() { command -v herdr >/dev/null 2>&1 && herdr status >/dev/null 2>&1; }

run_worker_in_herdr_pane() {
  local sentinel="$sessions_dir/$agent_run_id.exit"
  local pidfile="$sessions_dir/$agent_run_id.pid"
  rm -f "$sentinel" "$pidfile"
  # Attribute the worker to THIS lead: same herdr workspace as the focused
  # (lead) pane, split beneath it, labelled with run/task/vendor.
  local ws label
  ws="$(herdr pane list 2>/dev/null | jq -r '.result.panes[]|select(.focused)|.workspace_id' | head -1)"
  label="hydra:${run_id}:${task_id}:${vendor}"
  local inner
  inner="echo \$\$ > '$pidfile'; '$adapter' '$verb' '$task_spec' '$worktree' '$inbox' '$sessions_dir' '$agent_run_id' '$prior_session'; printf '%s' \$? > '$sentinel'"

  local started pane_id
  started="$(herdr agent start "$label" --cwd "$worktree" ${ws:+--workspace "$ws"} \
    --split down --no-focus -- bash -lc "$inner" 2>/dev/null)" || return 1
  pane_id="$(jq -r '.result.agent.pane_id // empty' <<<"$started" 2>/dev/null)"
  herdr_pane_id="$pane_id"   # visible to the cancel trap
  # The pidfile lets us kill the pane-hosted worker tree on timeout/cancel.
  hydra_ledger_append "$run_id" herdr_pane_started task_id "$task_id" vendor "$vendor" \
    label "$label" pane "${pane_id:-?}"
  hydra_log "worker hosted in herdr pane ${pane_id:-?}: $label (lead workspace ${ws:-?})"
  # Push live state FROM the ledger transition (task_started -> working). The
  # vendor's own hooks never fire in one-shot exec/print mode.
  hydra_herdr_state "$pane_id" "$vendor" working

  # Close the worker's terminal when it finishes — the harness cleans up its own
  # panes. Forensics are unaffected: the adapter's cli/stderr/session logs live in
  # sessions/, and the ledger + Git remain authoritative.
  # Set HYDRA_HERDR_KEEP_PANE=1 to leave the pane open for inspection.
  close_pane() {
    [ -n "$pane_id" ] || return 0
    hydra_herdr_state "$pane_id" "$vendor" idle          # ledger says the worker exited
    [ "${HYDRA_HERDR_KEEP_PANE:-0}" = 1 ] && { hydra_log "keeping herdr pane $pane_id (state=idle)"; return 0; }
    herdr pane close "$pane_id" >/dev/null 2>&1 \
      && hydra_log "closed herdr pane $pane_id ($label)"
  }

  # HARNESS-owned timeout: poll for the adapter's exit sentinel.
  local waited=0 limit=$(( timeout_min * 60 ))
  while [ ! -f "$sentinel" ] && [ "$waited" -lt "$limit" ]; do sleep 2; waited=$(( waited + 2 )); done
  if [ ! -f "$sentinel" ]; then
    [ -f "$pidfile" ] && hydra_kill_tree "$(cat "$pidfile")"
    record_exit agent_timed_out
    close_pane
    return 0
  fi
  record_exit agent_exited "$(cat "$sentinel")"
  close_pane
  return 0
}

run_worker() {
  local rc=0
  if [ "${HYDRA_HERDR_PANES:-0}" = 1 ] && herdr_live; then
    run_worker_in_herdr_pane && {
      "$SELF_DIR/record-usage.sh" "$run_id" "$task_id" "$vendor" "$agent_run_id" 2>/dev/null || true
      return 0
    }
    hydra_warn "herdr pane launch failed — falling back to a plain subprocess"
  fi
  # The worker MUST run in the background and be `wait`ed on: bash defers traps
  # while blocked on a foreground child, so a foreground worker would swallow
  # SIGTERM until it finished — exactly how the dangling task_started arose.
  # `wait` is interruptible, so the trap can fire immediately.
  hydra_timeout $(( timeout_min * 60 )) \
    "$adapter" "$verb" "$task_spec" "$worktree" "$inbox" "$sessions_dir" "$agent_run_id" "$prior_session" &
  worker_pid=$!
  wait "$worker_pid" || rc=$?
  if [ "$rc" -eq 124 ]; then
    record_exit agent_timed_out
  else
    record_exit agent_exited "$rc"
  fi
  # Budget/usage accounting (Wave 1) — parse the adapter session capture.
  "$SELF_DIR/record-usage.sh" "$run_id" "$task_id" "$vendor" "$agent_run_id" 2>/dev/null || true
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
