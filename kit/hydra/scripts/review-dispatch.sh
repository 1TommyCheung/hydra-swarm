#!/usr/bin/env bash
# hydra/scripts/review-dispatch.sh — host a READ-ONLY reviewer/explorer in a herdr pane.
#
# Closes the gap where only writer dispatch (dispatch.sh) was pane-hosted, so
# reviewer/explorer runs were invisible in the Layer-1 live monitor. Same rules:
# herdr is the terminal HOST only (roadmap non-goal intact), pane text is never
# read as truth, live state is advisory. Reviewers are READ-ONLY — no worktree,
# no promotion, no trust-boundary machinery; the verdict is recorded separately
# via record-review.sh.
#
# Usage:
#   review-dispatch.sh <run_id> <review_id> <vendor> <prompt_file> [--image PATH]
#     vendor: codex | kimi | claude | opencode
#
# Writes:
#   <run>/sessions/<review_id>.<vendor>.md      final assistant message
#   <run>/sessions/<review_id>.<vendor>.raw     raw stream
# Prints the .md path.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" review-dispatch "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" review-dispatch "$@"
fi

run_id="${1:?usage: review-dispatch.sh <run_id> <review_id> <vendor> <prompt_file> [--image PATH]}"
review_id="${2:?review_id required}"
vendor="${3:?vendor required}"
prompt_file="${4:?prompt_file required}"
image=""; [ "${5:-}" = "--image" ] && image="${6:-}"
[ -f "$prompt_file" ] || hydra_die "prompt file not found: $prompt_file"

repo_root="$(hydra_repo_root)"
run_dir="$(hydra_run_dir "$run_id")"
sessions="$run_dir/sessions"; mkdir -p "$sessions"
out_md="$sessions/$review_id.$vendor.md"
raw="$sessions/$review_id.$vendor.raw"
sentinel="$sessions/$review_id.$vendor.exit"
pidfile="$sessions/$review_id.$vendor.pid"
rm -f "$sentinel" "$pidfile"

# Build the vendor's READ-ONLY review command. The prompt comes from a file so
# quoting is safe.
case "$vendor" in
  codex)
    # Live progress: codex --json emits NDJSON to stdout, so tail the raw file
    # through a jq filter in the pane while the review runs. Matches dispatch.sh.
    codex_filter='
      if .type=="item.completed" and .item.type=="agent_message" and ((.item.text//"")!="") then .item.text
      elif .type=="item.started" and .item.type=="command_execution" and ((.item.command//"")!="")
        then ("\n[cmd] " + ((.item.command|gsub("\n";" ")) | .[0:140]))
      elif .type=="item.started" and .item.type=="file_change"
        then ("\n[edit] " + ([.item.changes[].path] | map(split("/")|last) | join(", ")))
      elif .type=="item.started" and .item.type=="mcp_tool_call"
        then ("\n[tool] " + (.item.server//"") + "." + (.item.tool//""))
      else empty end'
    inner_cmd="codex exec --json -s read-only -C '$repo_root' \"\$(cat '$prompt_file')\" > '$raw' 2>&1"
    plain_wrapped="echo \$\$ > '$pidfile'; $inner_cmd; printf '%s' \$? > '$sentinel'"
    # `tail | jq &` would make $! capture jq's PID (the pipeline's LAST
    # command), not tail's -- killing that leaves `tail -f` orphaned forever.
    # `tail ... > >(jq ...)` backgrounds tail alone (jq runs as bash's own
    # process-substitution job, reading from a FIFO tail writes to), so $!
    # is genuinely tail's PID; killing it closes the FIFO and jq exits on
    # its own EOF, no separate tracking needed for it.
    wrapped="echo \$\$ > '$pidfile'; touch '$raw' 2>/dev/null; tail -n +1 -f '$raw' 2>/dev/null > >(jq --unbuffered -r '$codex_filter' 2>/dev/null) & TPID=\$!; $inner_cmd; RC=\$?; kill \$TPID 2>/dev/null; printf '%s' \$RC > '$sentinel'"
    ;;
  kimi)
    # Live progress: kimi --output-format stream-json emits NDJSON to stdout.
    kimi_filter='if .role == "assistant" and ((.content // "") != "") then .content else empty end'
    inner_cmd="kimi -p \"\$(cat '$prompt_file')\" --output-format stream-json --add-dir '$repo_root' ${image:+--add-dir '$(dirname "$image")'} > '$raw' 2>&1"
    plain_wrapped="echo \$\$ > '$pidfile'; $inner_cmd; printf '%s' \$? > '$sentinel'"
    wrapped="echo \$\$ > '$pidfile'; touch '$raw' 2>/dev/null; tail -n +1 -f '$raw' 2>/dev/null > >(jq --unbuffered -r '$kimi_filter' 2>/dev/null) & TPID=\$!; $inner_cmd; RC=\$?; kill \$TPID 2>/dev/null; printf '%s' \$RC > '$sentinel'"
    ;;
  claude)
    inner_cmd="claude -p \"\$(cat '$prompt_file')\" --output-format json --add-dir '$repo_root' > '$raw' 2>&1"
    plain_wrapped="echo \$\$ > '$pidfile'; $inner_cmd; printf '%s' \$? > '$sentinel'"
    wrapped="$plain_wrapped"
    ;;
  opencode)
    inner_cmd="opencode run --model \"\${HYDRA_OPENCODE_MODEL:-zai-coding-plan/glm-5.2}\" --agent hydra-reviewer --format json --auto --dir '$repo_root' \"\$(cat '$prompt_file')\" > '$raw' 2>&1"
    plain_wrapped="echo \$\$ > '$pidfile'; $inner_cmd; printf '%s' \$? > '$sentinel'"
    wrapped="$plain_wrapped"
    ;;
  *) hydra_die "unknown vendor: $vendor" ;;
esac

hydra_ledger_append "$run_id" review_started review_id "$review_id" vendor "$vendor"

launch_in_pane() {
  command -v herdr >/dev/null 2>&1 && herdr status >/dev/null 2>&1 || return 1
  local ws label started pane
  ws="$(herdr pane list 2>/dev/null | jq -r '.result.panes[]|select(.agent!=null and .cwd=="'"$repo_root"'")|.workspace_id' | head -1)"
  label="hydra:$run_id:$review_id:$vendor"
  started="$(herdr agent start "$label" --cwd "$repo_root" ${ws:+--workspace "$ws"} \
    --split down --no-focus -- bash -lc "$wrapped" 2>/dev/null)" || return 1
  pane="$(jq -r '.result.agent.pane_id // empty' <<<"$started" 2>/dev/null)"
  HERDR_PANE="$pane"
  hydra_ledger_append "$run_id" herdr_pane_started review_id "$review_id" vendor "$vendor" \
    label "$label" pane "${pane:-?}"
  hydra_log "reviewer hosted in herdr pane ${pane:-?}: $label"
  hydra_herdr_state "$pane" "$vendor" working
  return 0
}

HERDR_PANE=""
if [ "${HYDRA_HERDR_PANES:-1}" = 1 ] && launch_in_pane; then
  # Harness-owned timeout while the pane runs the reviewer.
  waited=0 limit=$(( ${HYDRA_REVIEW_TIMEOUT_MIN:-15} * 60 ))
  while [ ! -f "$sentinel" ] && [ "$waited" -lt "$limit" ]; do sleep 3; waited=$(( waited + 3 )); done
  [ -f "$sentinel" ] || { [ -f "$pidfile" ] && hydra_kill_tree "$(cat "$pidfile")"; }
  [ -n "$HERDR_PANE" ] && hydra_herdr_state "$HERDR_PANE" "$vendor" idle
  if [ -n "$HERDR_PANE" ] && [ "${HYDRA_HERDR_KEEP_PANE:-0}" != 1 ]; then
    herdr pane close "$HERDR_PANE" >/dev/null 2>&1 && hydra_log "closed reviewer pane $HERDR_PANE"
  fi
else
  # Fallback: run inline (no herdr). Always the PLAIN wrapper -- no pane
  # means no progress-file observer.
  ( cd "$repo_root" && bash -lc "$plain_wrapped" ) || true
fi

# Extract the final assistant message per vendor stream format.
case "$vendor" in
  codex)    jq -rs 'map(select(.msg.type=="agent_message" or .type=="item.completed")|(.msg.message // .item.text // empty))|last // empty' "$raw" >"$out_md" 2>/dev/null || true ;;
  kimi)     jq -rs 'map(select(.role=="assistant")|.content)|last // empty' "$raw" >"$out_md" 2>/dev/null || true ;;
  claude)   jq -r '.result // empty' "$raw" >"$out_md" 2>/dev/null || true ;;
  opencode) jq -rs 'map(select(.type=="text" or (.part.type=="text"))|(.text // .part.text // empty))|last // empty' "$raw" >"$out_md" 2>/dev/null || true ;;
esac
[ -s "$out_md" ] || cp "$raw" "$out_md" 2>/dev/null || true

hydra_ledger_append "$run_id" review_completed review_id "$review_id" vendor "$vendor" \
  exit_code "$(cat "$sentinel" 2>/dev/null || echo '?')"
hydra_log "review $review_id ($vendor) -> $out_md"
printf '%s\n' "$out_md"
