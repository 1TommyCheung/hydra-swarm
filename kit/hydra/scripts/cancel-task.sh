#!/usr/bin/env bash
# hydra/scripts/cancel-task.sh — request clean task cancellation via dispatch.
#
# Usage: cancel-task.sh <run_id> <task_id> [--wait-seconds N]

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" cancel-task "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" cancel-task "$@"
fi

usage='usage: cancel-task.sh <run_id> <task_id> [--wait-seconds N]'
[ "$#" -ge 2 ] || hydra_die "$usage"
run_id="$1"
task_id="$2"
shift 2

wait_seconds=15
while [ "$#" -gt 0 ]; do
  case "$1" in
    --wait-seconds)
      [ -n "${2:-}" ] && [[ "$2" =~ ^[0-9]+$ ]] || hydra_die "$usage"
      wait_seconds="$2"
      shift 2
      ;;
    *)
      hydra_die "$usage"
      ;;
  esac
done

run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "instantiated task spec not found: $task_spec"
ledger="$(hydra_ledger "$run_id")"
[ -f "$ledger" ] || hydra_die "no ledger for run $run_id"

spec_version="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
agent_run_id="${run_id}-${task_id}-v${spec_version:-1}"

read_attempt_events() {
  local all matching_line
  all="$(jq -Rrc --arg task_id "$task_id" 'fromjson? | select(.task_id == $task_id)' "$ledger")"
  matching_line="$(printf '%s\n' "$all" \
    | jq -r --arg agent_run_id "$agent_run_id" \
      'select(.event == "task_started" and .agent_run_id == $agent_run_id) | input_line_number' \
    | tail -n1)"
  if [ -n "$matching_line" ]; then
    printf '%s\n' "$all" | jq -c --argjson start "$matching_line" \
      'select(input_line_number >= $start)'
  fi
}

terminal_event() {
  local events
  events="$(read_attempt_events)"
  [ -n "$events" ] || return 0
  printf '%s\n' "$events" \
    | jq -c 'select(.event == "agent_exited" or .event == "agent_cancelled" or .event == "agent_timed_out")' \
    | tail -n1
}

print_terminal() {
  local terminal="$1" event
  event="$(printf '%s\n' "$terminal" | jq -r '.event // "terminal"')"
  printf '%s: %s\n' "$event" "$terminal"
}

task_events="$(read_attempt_events)"
terminal="$(terminal_event)"
if [ -n "$terminal" ]; then
  print_terminal "$terminal"
  exit 0
fi
if [ -z "$task_events" ]; then
  hydra_die "no such task/attempt: $run_id/$task_id ($agent_run_id)"
fi

last_event="$(printf '%s\n' "$task_events" | jq -rs '.[-1].event // ""')"
pidfile="$run_dir/sessions/supervisor/$agent_run_id.dispatch.pid"
dispatch_pid=''
command_matches_dispatch() {
  local command="$1" token clean has_dispatch=0 has_run=0 has_task=0
  read -r -a words <<<"$command"
  for token in "${words[@]}"; do
    clean="${token#\'}"; clean="${clean%\'}"
    clean="${clean#\"}"; clean="${clean%\"}"
    case "${clean##*/}" in
      dispatch.ts|dispatch.sh) has_dispatch=1 ;;
    esac
    [ "$clean" = "$run_id" ] && has_run=1
    [ "$clean" = "$task_id" ] && has_task=1
  done
  [ "$has_dispatch" -eq 1 ] && [ "$has_run" -eq 1 ] && [ "$has_task" -eq 1 ]
}

command_for_pid() {
  local wanted_pid="$1" listed_pid command
  while read -r listed_pid command; do
    if [ "$listed_pid" = "$wanted_pid" ]; then
      printf '%s\n' "$command"
      return 0
    fi
  done < <(ps -axo pid=,command= 2>/dev/null || true)
  return 1
}

pid_matches_dispatch() {
  local command
  command="$(command_for_pid "$1")" || return 1
  command_matches_dispatch "$command"
}

should_discover=0
[ "$last_event" = 'concurrency_wait' ] && should_discover=1
if [ -f "$pidfile" ]; then
  candidate="$(tr -d '[:space:]' <"$pidfile")"
  if [[ "$candidate" =~ ^[0-9]+$ ]] && kill -0 "$candidate" 2>/dev/null; then
    if pid_matches_dispatch "$candidate"; then
      dispatch_pid="$candidate"
    else
      # SIGKILL can leave a stale pidfile whose live PID has been reused.
      should_discover=1
    fi
  fi
fi

if [ -z "$dispatch_pid" ] && [ "$should_discover" -eq 1 ]; then
  matches=()
  while read -r candidate command; do
    [[ "$candidate" =~ ^[0-9]+$ ]] || continue
    kill -0 "$candidate" 2>/dev/null || continue
    # These shell pattern checks use quoted expansions, so run/task IDs are
    # literal strings rather than regular expressions.
    [[ "$command" == *"$run_id"* ]] || continue
    [[ "$command" == *"$task_id"* ]] || continue
    command_matches_dispatch "$command" && matches+=("$candidate")
  done < <(ps -axo pid=,command= 2>/dev/null || true)

  if [ "${#matches[@]}" -gt 1 ]; then
    hydra_die "multiple validated dispatch processes found for $run_id/$task_id; refusing to guess"
  elif [ "${#matches[@]}" -eq 1 ]; then
    dispatch_pid="${matches[0]}"
  fi
fi

[ -n "$dispatch_pid" ] || hydra_die "dispatch process not found for $run_id/$task_id"

# Close the race with a concurrent cancellation or normal terminal event.
terminal="$(terminal_event)"
if [ -n "$terminal" ]; then
  print_terminal "$terminal"
  exit 0
fi
kill -0 "$dispatch_pid" 2>/dev/null \
  || hydra_die "dispatch process not found for $run_id/$task_id"
if ! kill -TERM "$dispatch_pid" 2>/dev/null; then
  terminal="$(terminal_event)"
  if [ -n "$terminal" ]; then
    print_terminal "$terminal"
    exit 0
  fi
  hydra_die "dispatch process not found for $run_id/$task_id"
fi

ticks=$(( wait_seconds * 2 ))
while [ "$ticks" -gt 0 ]; do
  terminal="$(terminal_event)"
  if [ -n "$terminal" ]; then
    print_terminal "$terminal"
    exit 0
  fi
  sleep 0.5
  ticks=$(( ticks - 1 ))
done

terminal="$(terminal_event)"
if [ -n "$terminal" ]; then
  print_terminal "$terminal"
  exit 0
fi

# Escalate only while the same dispatch PID is still alive, and only after one
# final authoritative ledger read. Never signal a worker PID or pane directly.
if kill -0 "$dispatch_pid" 2>/dev/null; then
  terminal="$(terminal_event)"
  if [ -n "$terminal" ]; then
    print_terminal "$terminal"
    exit 0
  fi
  if kill -0 "$dispatch_pid" 2>/dev/null \
    && pid_matches_dispatch "$dispatch_pid"; then
    kill -KILL "$dispatch_pid" 2>/dev/null || true
  fi
fi

sleep 2
terminal="$(terminal_event)"
if [ -n "$terminal" ]; then
  print_terminal "$terminal"
  exit 0
fi

hydra_die "ORPHAN: dispatch process $dispatch_pid stopped without a terminal ledger event; manual investigation required (no ledger event was fabricated)"
