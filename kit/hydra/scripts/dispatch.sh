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
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/dispatch.ts" "$@"
fi

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

# Shared starting-banner builder for worker panes. Writes the banner — vendor/
# model label, run/task ids, worktree, and the ACTUAL worker prompt that
# build-worker-prompt.sh renders (reused, not reimplemented) — to a file and
# echoes the path. The pane script cats this BEFORE the adapter runs, so a pane
# answers "what is this worker even doing" before the first token streams. Pure
# display; pane text is never read as truth (observability.yaml).
# Usage: _write_pane_banner <vendor_label>   -> echoes banner file path
_write_pane_banner() {
  local label="$1"
  local banner_file="$sessions_dir/$agent_run_id.pane-banner.txt"
  {
    printf '%s starting — run %s task %s\n' "$label" "$run_id" "$task_id"
    printf 'worktree: %s\n' "$worktree"
    printf -- '--- prompt ---\n'
    "$repo_root/hydra/adapters/build-worker-prompt.sh" "$task_spec" 2>/dev/null || printf '(prompt unavailable)\n'
    printf -- '--------------\n\n'
  } >"$banner_file" 2>/dev/null || true
  printf '%s' "$banner_file"
}

run_worker_in_herdr_pane() {
  local sentinel="$sessions_dir/$agent_run_id.exit"
  local pidfile="$sessions_dir/$agent_run_id.pid"
  rm -f "$sentinel" "$pidfile"
  # Attribute the worker to THIS lead: same herdr workspace as the focused
  # (lead) pane, split beneath it, labelled with run/task/vendor.
  local ws label
  ws="$(herdr pane list 2>/dev/null | jq -r '.result.panes[]|select(.focused)|.workspace_id' | head -1)"
  label="hydra:${run_id}:${task_id}:${vendor}"

  # Starting banner + (codex only) live progress tail — purely ADDITIVE display
  # in the SAME pane as the wrapped adapter invocation. The pidfile/sentinel/
  # keep-alive/timeout mechanism below is NOT touched; this only changes what
  # the pane PRINTS. claude/kimi get the banner only:
  #   - kimi already tees its human-readable stderr live inside kimi.sh, so its
  #     existing live channel is preserved unchanged ahead of the banner.
  #   - claude -p --output-format json emits ONE JSON blob at the very end (not a
  #     stream), and its stderr is empty in real worker runs (0-byte .stderr
  #     files across run-0001/run-0002); there is no live stream to tail, so we
  #     do NOT tee a silent stream for cosmetics (documented in result notes).
  # codex --json streams real JSONL events to its cli.jsonl (same as opencode),
  # so we live-tail them exactly like open_opencode_monitor_pane, using codex's
  # OWN event field names (verified against real capture samples).
  local vlabel
  case "$vendor" in
    codex)  vlabel="Codex" ;;
    claude) vlabel="Claude" ;;
    kimi)   vlabel="Kimi" ;;
    *)      vlabel="$vendor" ;;
  esac
  local banner_file; banner_file="$(_write_pane_banner "$vlabel")"

  local inner
  if [ "$vendor" = codex ]; then
    # codex --json event schema (from ~/.local/state/webtrail-hydra/runs/*/sessions
    # /*.cli.jsonl samples): item.completed+agent_message -> .item.text;
    # item.started+command_execution -> .item.command; item.started+file_change
    # -> .item.changes[].path; item.started+mcp_tool_call -> .item.server/.tool.
    local events_file="$sessions_dir/$agent_run_id.cli.jsonl"
    local codex_filter='
      if .type=="item.completed" and .item.type=="agent_message" and ((.item.text//"")!="") then .item.text
      elif .type=="item.started" and .item.type=="command_execution" and ((.item.command//"")!="")
        then ("\n[cmd] " + ((.item.command|gsub("\n";" ")) | .[0:140]))
      elif .type=="item.started" and .item.type=="file_change"
        then ("\n[edit] " + ([.item.changes[].path] | map(split("/")|last) | join(", ")))
      elif .type=="item.started" and .item.type=="mcp_tool_call"
        then ("\n[tool] " + (.item.server//"") + "." + (.item.tool//""))
      else empty end'
    # set +e so a nonzero adapter exit still reaches the sentinel write (matches
    # the adapters' own `|| true`). RC captures the adapter's exit, then the
    # progress tailer (TPID) is stopped before writing the sentinel.
    inner="echo \$\$ > '$pidfile'; set +e; cat '$banner_file' 2>/dev/null; touch '$events_file' 2>/dev/null; tail -n +1 -f '$events_file' 2>/dev/null | jq --unbuffered -r '$codex_filter' 2>/dev/null & TPID=\$!; '$adapter' '$verb' '$task_spec' '$worktree' '$inbox' '$sessions_dir' '$agent_run_id' '$prior_session'; RC=\$?; kill \$TPID 2>/dev/null; printf '%s' \$RC > '$sentinel'"
  else
    # claude / kimi: banner only (kimi's own stderr tee carries live progress;
    # claude has no live stream).
    inner="echo \$\$ > '$pidfile'; cat '$banner_file' 2>/dev/null; '$adapter' '$verb' '$task_spec' '$worktree' '$inbox' '$sessions_dir' '$agent_run_id' '$prior_session'; printf '%s' \$? > '$sentinel'"
  fi

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
    if herdr pane close "$pane_id" >/dev/null 2>&1; then
      hydra_log "closed herdr pane $pane_id ($label)"
    fi
    return 0
  }

  # HARNESS-owned KEEP-ALIVE timeout: poll for the adapter's exit sentinel.
  # timeout_min is an INACTIVITY window, not a wall-clock cap: while the worker's
  # session capture files (cli.jsonl / stderr) keep growing, the timer renews —
  # slow reasoning is not a failure. A worker is killed only after timeout_min
  # of NO output, or at the absolute hard cap (HYDRA_HARD_CAP_MIN, default 6x)
  # that backstops a pathological still-writing-forever loop.
  local waited=0 limit=$(( timeout_min * 60 ))
  local elapsed=0 hard_cap=$(( ${HYDRA_HARD_CAP_MIN:-$(( timeout_min * 6 ))} * 60 ))
  local act prev_act=""
  while [ ! -f "$sentinel" ] && [ "$waited" -lt "$limit" ] && [ "$elapsed" -lt "$hard_cap" ]; do
    sleep 2; waited=$(( waited + 2 )); elapsed=$(( elapsed + 2 ))
    act="$(wc -c "$sessions_dir/$agent_run_id.cli.jsonl" "$sessions_dir/$agent_run_id.stderr" 2>/dev/null | tail -1)"
    [ "$act" != "$prev_act" ] && { prev_act="$act"; waited=0; }
  done
  if [ ! -f "$sentinel" ]; then
    [ -f "$pidfile" ] && hydra_kill_tree "$(cat "$pidfile")"
    if [ "$elapsed" -ge "$hard_cap" ]; then
      hydra_ledger_append "$run_id" agent_timed_out task_id "$task_id" vendor "$vendor" reason hard_cap elapsed_sec "$elapsed" && exit_recorded=1
      release_slot
    else
      hydra_ledger_append "$run_id" agent_timed_out task_id "$task_id" vendor "$vendor" reason stalled idle_sec "$waited" && exit_recorded=1
      release_slot
    fi
    close_pane
    return 0
  fi
  record_exit agent_exited "$(cat "$sentinel")"
  close_pane
  return 0
}

# --- opencode/GLM: DECOUPLED pane monitor ------------------------------------
# Hosting the opencode CLI itself inside a herdr-spawned process reliably broke
# it (immediate "Unexpected server error" from the Z.AI endpoint, 6/6 repro;
# the identical invocation as a plain subprocess succeeded every time — see
# hydra-ts/migration/FINDINGS.md). Root cause not isolated (PTY/fd/signal
# interaction suspected), so the fix decouples PROCESS EXECUTION from PANE
# VISIBILITY: the adapter always runs as a plain background subprocess (the
# proven-reliable path); a SEPARATE herdr pane, which never touches the vendor
# process, just tails its capture file live for observability and self-closes
# once the worker pid disappears. Pane text is still never read as truth.
open_opencode_monitor_pane() {
  local watch_pid="$1"
  herdr_live || return 1
  local ws label
  ws="$(herdr pane list 2>/dev/null | jq -r '.result.panes[]|select(.focused)|.workspace_id' | head -1)"
  label="hydra:${run_id}:${task_id}:${vendor}"
  local events_file="$sessions_dir/$agent_run_id.events.jsonl"
  local model="${HYDRA_OPENCODE_MODEL:-zhipu/glm-5.2}"

  # Starting banner + the actual prompt so the pane answers "what is this worker
  # even doing" before the first token streams. Reuses the shared banner builder
  # that run_worker_in_herdr_pane also uses (no duplicated prompt construction).
  local banner_file; banner_file="$(_write_pane_banner "OpenCode ($model)")"

  # Progress filter: assistant text as it streams, plus short "-> tool" lines
  # for tool calls, so the pane reads like activity, not silence-then-result.
  local jq_filter='
    if .part.type == "text" and ((.part.text // "") != "") then .part.text
    elif .part.type == "tool" then
      ("\n[tool] " + (.part.tool // "tool") +
       (if (.part.state.title // "") != "" then ": " + .part.state.title else "" end))
    else empty end'

  local monitor
  monitor="cat '$banner_file' 2>/dev/null; touch '$events_file' 2>/dev/null; tail -n +1 -f '$events_file' 2>/dev/null | jq --unbuffered -r '$jq_filter' & TPID=\$!; while kill -0 $watch_pid 2>/dev/null; do sleep 1; done; kill \$TPID 2>/dev/null"
  local started pane_id
  started="$(herdr agent start "$label" --cwd "$worktree" ${ws:+--workspace "$ws"} \
    --split down --no-focus -- bash -lc "$monitor" 2>/dev/null)" || return 1
  pane_id="$(jq -r '.result.agent.pane_id // empty' <<<"$started" 2>/dev/null)"
  [ -n "$pane_id" ] || return 1
  herdr_pane_id="$pane_id"
  hydra_ledger_append "$run_id" herdr_pane_started task_id "$task_id" vendor "$vendor" \
    label "$label" pane "$pane_id" mode monitor_only
  hydra_log "opencode monitor pane $pane_id: $label (worker pid $watch_pid, lead workspace ${ws:-?})"
  hydra_herdr_state "$pane_id" "$vendor" working
  printf '%s\n' "$pane_id"
}

close_opencode_monitor_pane() {
  local pane_id="$1"
  [ -n "$pane_id" ] || return 0
  hydra_herdr_state "$pane_id" "$vendor" idle
  if [ "${HYDRA_HERDR_KEEP_PANE:-0}" = 1 ]; then
    hydra_log "keeping opencode monitor pane $pane_id (state=idle)"
    return 0
  fi
  if herdr pane close "$pane_id" >/dev/null 2>&1; then
    hydra_log "closed opencode monitor pane $pane_id"
  fi
  return 0
}

run_worker() {
  local rc=0
  if [ "$vendor" = opencode ] && [ "${HYDRA_HERDR_PANES:-0}" = 1 ] && herdr_live; then
    "$adapter" "$verb" "$task_spec" "$worktree" "$inbox" "$sessions_dir" "$agent_run_id" "$prior_session" &
    worker_pid=$!
    local monitor_pane_id
    monitor_pane_id="$(open_opencode_monitor_pane "$worker_pid")" || true
    # Same keep-alive watchdog as the plain path below: inactivity-window
    # timeout, renewed while capture files grow; hard cap backstops runaways.
    local waited=0 limit=$(( timeout_min * 60 ))
    local elapsed=0 hard_cap=$(( ${HYDRA_HARD_CAP_MIN:-$(( timeout_min * 6 ))} * 60 ))
    local act prev_act="" timed_out=""
    while kill -0 "$worker_pid" 2>/dev/null; do
      if [ "$waited" -ge "$limit" ]; then timed_out=stalled; break; fi
      if [ "$elapsed" -ge "$hard_cap" ]; then timed_out=hard_cap; break; fi
      sleep 2; waited=$(( waited + 2 )); elapsed=$(( elapsed + 2 ))
      act="$(wc -c "$sessions_dir/$agent_run_id".* 2>/dev/null | tail -1)"
      [ "$act" != "$prev_act" ] && { prev_act="$act"; waited=0; }
    done
    # Ledger truth is written FIRST, pane cleanup SECOND (and never allowed to
    # take the script down): `herdr pane close` can return nonzero for benign
    # reasons (pane already gone, etc.) and under `set -e` an unguarded
    # nonzero here would abort the script before agent_exited is recorded —
    # exactly the ordering bug that made this branch silently skip the ledger
    # write during development. Matches run_worker_in_herdr_pane's ordering.
    if [ -n "$timed_out" ]; then
      hydra_kill_tree "$worker_pid"
      hydra_ledger_append "$run_id" agent_timed_out task_id "$task_id" vendor "$vendor" reason "$timed_out" && exit_recorded=1
      release_slot
    else
      wait "$worker_pid" || rc=$?
      record_exit agent_exited "$rc"
    fi
    [ -n "${monitor_pane_id:-}" ] && { close_opencode_monitor_pane "$monitor_pane_id" || true; }
    "$SELF_DIR/record-usage.sh" "$run_id" "$task_id" "$vendor" "$agent_run_id" 2>/dev/null || true
    return 0
  fi
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
  # KEEP-ALIVE timeout (same semantics as the pane path): timeout_min is an
  # inactivity window renewed while session capture files grow; the hard cap
  # (HYDRA_HARD_CAP_MIN, default 6x) backstops runaways.
  "$adapter" "$verb" "$task_spec" "$worktree" "$inbox" "$sessions_dir" "$agent_run_id" "$prior_session" &
  worker_pid=$!
  local waited=0 limit=$(( timeout_min * 60 ))
  local elapsed=0 hard_cap=$(( ${HYDRA_HARD_CAP_MIN:-$(( timeout_min * 6 ))} * 60 ))
  local act prev_act="" timed_out=""
  while kill -0 "$worker_pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then timed_out=stalled; break; fi
    if [ "$elapsed" -ge "$hard_cap" ]; then timed_out=hard_cap; break; fi
    sleep 2; waited=$(( waited + 2 )); elapsed=$(( elapsed + 2 ))
    act="$(wc -c "$sessions_dir/$agent_run_id".* 2>/dev/null | tail -1)"
    [ "$act" != "$prev_act" ] && { prev_act="$act"; waited=0; }
  done
  if [ -n "$timed_out" ]; then
    hydra_kill_tree "$worker_pid"
    hydra_ledger_append "$run_id" agent_timed_out task_id "$task_id" vendor "$vendor" reason "$timed_out" && exit_recorded=1
    release_slot
  else
    wait "$worker_pid" || rc=$?
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
