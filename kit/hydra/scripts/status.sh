#!/usr/bin/env bash
# hydra/scripts/status.sh — read-only, one-shot status command for a task.
#
# Reports state, agent_run_id, vendor, elapsed time, timeout/hard-cap budgets,
# dispatch-pid liveness (advisory), a short progress tail, and the last 5 ledger
# events for the task. The ledger is authoritative; live state is advisory.
#
# Usage: status.sh <run_id> <task_id> [--lines N] [--json]

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" status "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" status "$@"
fi

run_id="${1:?usage: status.sh <run_id> <task_id> [--lines N] [--json]}"
task_id="${2:?usage: status.sh <run_id> <task_id> [--lines N] [--json]}"
shift 2

run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "instantiated task spec not found: $task_spec"

ledger="$(hydra_ledger "$run_id")"
[ -f "$ledger" ] || hydra_die "no ledger for run $run_id"

vendor="$(hydra_yaml_scalar "$task_spec" 'assigned_vendor')"
timeout_min="$(hydra_yaml_scalar "$task_spec" 'timeout_minutes')"
[ -n "$timeout_min" ] || timeout_min=45
spec_version="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
agent_run_id="${run_id}-${task_id}-v${spec_version:-1}"
sessions_dir="$run_dir/sessions"

lines=20
json=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lines)
      [ -n "${2:-}" ] || hydra_die "usage: status.sh <run_id> <task_id> [--lines N] [--json]"
      lines="$2"
      shift 2
      ;;
    --json)
      json=1
      shift
      ;;
    *)
      hydra_die "usage: status.sh <run_id> <task_id> [--lines N] [--json]"
      ;;
  esac
done

# Derive state from the ledger (authoritative). A task_id may be retried with a
# new spec_version, so isolate the event window that belongs to the current
# agent_run_id. Terminal events from earlier attempts must not shadow the
# current attempt.
task_events_all="$(jq -rc "select(.task_id == \"$task_id\")" "$ledger")"
matching_line="$(echo "$task_events_all" | jq -r --arg agent_run_id "$agent_run_id" 'select(.event == "task_started" and .agent_run_id == $agent_run_id) | input_line_number' | tail -n1)"
task_events=''
if [ -n "$matching_line" ]; then
  task_events="$(echo "$task_events_all" | jq -c --argjson start "$matching_line" 'select(input_line_number >= $start)')"
fi

state='unknown'
if [ -n "$task_events" ]; then
  if echo "$task_events" | jq -se 'any(.event == "agent_exited" and .reason == "worker_disappeared")' >/dev/null; then
    state='failed'
  elif echo "$task_events" | jq -se 'map(.event) | any(. == "agent_exited")' >/dev/null; then
    state='completed'
  elif echo "$task_events" | jq -se 'map(.event) | any(. == "agent_cancelled")' >/dev/null; then
    state='cancelled'
  elif echo "$task_events" | jq -se 'map(.event) | any(. == "agent_timed_out")' >/dev/null; then
    state='timed_out'
  elif echo "$task_events" | jq -se 'map(.event) | any(. == "task_started")' >/dev/null; then
    state='running'
  fi
fi

# Most recent event in the current attempt window, used to detect whether the
# task is still queued waiting for a concurrency slot.
last_event=''
if [ -n "$task_events" ]; then
  last_event="$(echo "$task_events" | jq -rs '.[-1].event // ""')"
fi

# Elapsed time since the current attempt's task_started.
started_time=''
started_epoch=''
started_line="$(echo "$task_events" | jq -r 'select(.event == "task_started") | .time' | head -n1)"
if [ -n "$started_line" ]; then
  started_time="$started_line"
  # Try BSD/macOS date first, then fall back to GNU coreutils date. The
  # original `date -j -f` form is macOS-only and silently returned null on
  # Linux because `|| true` swallowed the GNU-date error.
  started_epoch="$(
    date -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_time" '+%s' 2>/dev/null \
    || date -u -d "$started_time" '+%s' 2>/dev/null \
    || true
  )"
fi
elapsed_seconds=''
if [ -n "$started_epoch" ]; then
  now_epoch="$(date -u '+%s')"
  elapsed_seconds=$(( now_epoch - started_epoch ))
fi

hard_cap_min="${HYDRA_HARD_CAP_MIN:-$(( timeout_min * 6 ))}"

# Dispatch-pid liveness (advisory).
pidfile="$sessions_dir/supervisor/$agent_run_id.dispatch.pid"
dispatch_pid=''
dispatch_alive='false'
if [ -f "$pidfile" ]; then
  dispatch_pid="$(cat "$pidfile" | tr -d '[:space:]')"
  if [ -n "$dispatch_pid" ] && kill -0 "$dispatch_pid" 2>/dev/null; then
    dispatch_alive='true'
  fi
fi

# Detect ledger-vs-pidfile disagreement. Suppress the missing-pidfile case
# when either (a) the task just started and the brief mkdir/writeAtomic
# overhead has not elapsed yet, or (b) the task is still queued waiting for a
# concurrency slot, evidenced by concurrency_wait being the last event in the
# current attempt window. In the queued case we verify the dispatch process is
# genuinely alive via process discovery — if it was SIGKILLed while parked in
# acquireSlot() (OOM-killer, kill -9, host reboot), no further ledger event is
# ever appended and blind suppression would hide the death forever. Discovery
# has three outcomes, mirroring the TypeScript path: a validated live
# dispatcher, a genuine "ran and found nothing" (which IS the death signal), or
# discovery itself being unavailable (ps denied/missing — which is NOT a death
# signal and must not produce a false-positive disagreement).

# Strip a single pair of matching outer quotes, mirroring TypeScript's
# stripOuterQuotes exactly (only strips when first AND last chars are the same
# quote type).
_hydra_strip_outer_quotes() {
  local s="$1" len=${#1} first last
  if [ "$len" -ge 2 ]; then
    first="${s:0:1}"
    last="${s:len-1:1}"
    if { [ "$first" = "'" ] && [ "$last" = "'" ]; } \
      || { [ "$first" = '"' ] && [ "$last" = '"' ]; }; then
      REPLY="${s:1:len-2}"
      return
    fi
  fi
  REPLY="$s"
}

# Mirror of TypeScript's isDispatchCommand(): locate the FIRST dispatch token
# (dispatch.ts/dispatch.sh basename), then require the exact run_id AND task_id
# tokens to appear among the arguments AFTER that dispatcher token — not merely
# anywhere in the command string. This rejects e.g.
#   python worker.py <run> <task> /tmp/dispatch.sh <other-run> <other-task>
# which a loose "tokens anywhere" check would wrongly accept.
command_matches_dispatch() {
  local command="$1" token i dispatch_index=-1 has_run=0 has_task=0
  local -a words cleaned=()
  read -r -a words <<<"$command"
  for token in "${words[@]}"; do
    _hydra_strip_outer_quotes "$token"
    cleaned+=("$REPLY")
  done
  for ((i = 0; i < ${#cleaned[@]}; i++)); do
    case "${cleaned[i]##*/}" in
      dispatch.ts|dispatch.sh) dispatch_index=$i; break ;;
    esac
  done
  [ "$dispatch_index" -ge 0 ] || return 1
  for ((i = dispatch_index + 1; i < ${#cleaned[@]}; i++)); do
    [ "${cleaned[i]}" = "$run_id" ] && has_run=1
    [ "${cleaned[i]}" = "$task_id" ] && has_task=1
  done
  [ "$has_run" -eq 1 ] && [ "$has_task" -eq 1 ]
}

# Queued-dispatcher discovery. Returns:
#   0  a live, validated dispatcher was found (healthy)
#   1  discovery ran but found no validated live dispatcher (may be dead)
#   2  discovery itself was unavailable (ps failed) — NOT a death signal
queued_dispatch_check() {
  local ps_output candidate command
  if ! ps_output="$(ps -axo pid=,command= 2>/dev/null)"; then
    return 2
  fi
  while read -r candidate command; do
    [[ "$candidate" =~ ^[0-9]+$ ]] || continue
    kill -0 "$candidate" 2>/dev/null || continue
    command_matches_dispatch "$command" && return 0
  done <<<"$ps_output"
  return 1
}

grace_seconds=3
disagreement=''
if [ "$state" = 'running' ]; then
  if [ ! -f "$pidfile" ]; then
    if [ -n "$elapsed_seconds" ] && [ "$elapsed_seconds" -ge "$grace_seconds" ]; then
      if [ "$last_event" = 'concurrency_wait' ]; then
        queued_rc=0
        queued_dispatch_check || queued_rc=$?
        if [ "$queued_rc" -eq 1 ]; then
          disagreement='ledger reports queued (concurrency_wait) but no live dispatch process was found; the dispatcher may have been killed while queued'
        fi
        # queued_rc 0 (alive) or 2 (discovery unavailable): suppress, no disagreement.
      else
        disagreement='ledger reports running but no dispatch pidfile exists'
      fi
    fi
  elif [ "$dispatch_alive" = 'false' ]; then
    disagreement='ledger reports running but the dispatch process is not alive'
  fi
elif [ "$state" != 'unknown' ] && [ -f "$pidfile" ] && [ "$dispatch_alive" = 'true' ]; then
  disagreement="ledger reports $state but the dispatch process is still alive"
fi

# Progress tail (preference order: cli.jsonl, events.jsonl, stderr).
progress_source=''
progress_tail=''
cli_jsonl="$sessions_dir/$agent_run_id.cli.jsonl"
events_jsonl="$sessions_dir/$agent_run_id.events.jsonl"
stderr="$sessions_dir/$agent_run_id.stderr"
if [ -f "$cli_jsonl" ]; then
  progress_source='cli.jsonl'
  progress_tail="$(tail -n "$lines" "$cli_jsonl")"
elif [ -f "$events_jsonl" ]; then
  progress_source='events.jsonl'
  progress_tail="$(tail -n "$lines" "$events_jsonl")"
elif [ -f "$stderr" ]; then
  progress_source='stderr'
  progress_tail="$(tail -n "$lines" "$stderr")"
fi

# Last 5 ledger events for this task (scoped to the current attempt).
last_events="$(echo "$task_events" | tail -n 5)"

if [ "$json" -eq 1 ]; then
  jq -n \
    --arg state "$state" \
    --arg agent_run_id "$agent_run_id" \
    --arg vendor "$vendor" \
    --argjson elapsed_seconds "${elapsed_seconds:-null}" \
    --argjson timeout_minutes "$timeout_min" \
    --argjson hard_cap_minutes "$hard_cap_min" \
    --arg dispatch_pid "${dispatch_pid:-}" \
    --argjson dispatch_alive "$dispatch_alive" \
    --arg disagreement "${disagreement:-}" \
    --arg progress_source "$progress_source" \
    --arg progress_tail "$progress_tail" \
    --argjson ledger_events "$(echo "$last_events" | jq -s .)" \
    '{
      state: $state,
      agent_run_id: $agent_run_id,
      vendor: $vendor,
      elapsed_seconds: $elapsed_seconds,
      timeout_minutes: $timeout_minutes,
      hard_cap_minutes: $hard_cap_minutes,
      dispatch_liveness: (if $dispatch_pid == "" then null else {
        pid: ($dispatch_pid | tonumber),
        alive: $dispatch_alive,
        advisory: true
      } end),
      disagreement: (if $disagreement == "" then null else $disagreement end),
      progress_tail: ($progress_tail | split("\n")),
      progress_source: (if $progress_source == "" then null else $progress_source end),
      ledger_events: $ledger_events
    }'
else
  echo "state: $state"
  echo "agent_run_id: $agent_run_id"
  echo "vendor: $vendor"
  if [ -n "$elapsed_seconds" ]; then
    echo "elapsed: ${elapsed_seconds}s"
  else
    echo "elapsed: n/a"
  fi
  echo "timeout_minutes: $timeout_min"
  echo "hard_cap_minutes: $hard_cap_min"
  if [ -n "$dispatch_pid" ]; then
    echo "dispatch_pid: $dispatch_pid ($dispatch_alive, advisory)"
  else
    echo "dispatch_pid: none (advisory)"
  fi
  if [ -n "$disagreement" ]; then
    echo "disagreement: $disagreement"
  fi
  echo "progress_tail (${progress_source:-none}):"
  if [ -n "$progress_tail" ]; then
    printf '%s\n' "$progress_tail" | sed 's/^/  /'
  else
    echo "  (no progress capture files found)"
  fi
  echo "ledger_events:"
  if [ -n "$last_events" ]; then
    echo "$last_events" | sed 's/^/  /'
  else
    echo "  (no ledger events for this task)"
  fi
fi
