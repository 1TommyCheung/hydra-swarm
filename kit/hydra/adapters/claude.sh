#!/usr/bin/env bash
# hydra/adapters/claude.sh — Claude Code worker adapter (Wave 0).
#
# vendor-adapters.md §1, §4. Write-capable Claude workers run as a HEADLESS
# SUBPROCESS in the assigned worktree (`claude -p`), NOT as a native subagent:
# the native-subagent isolation contract is unverified, and uniform isolation
# outranks dispatch latency. Native subagents are used for read-only roles only.
#
# Implements the adapter `start` verb:
#   start <task_spec> <worktree> <inbox_dir> <sessions_dir> <agent_run_id>
#
# The worker's result is UNTRUSTED. The adapter only: builds the prompt from the
# task spec (the sole valid instruction surface), runs the CLI, captures the
# session id, and guarantees an inbox drop exists. promote.sh is the boundary.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib.sh
source "$SELF_DIR/../scripts/lib.sh"

verb="${1:?usage: claude.sh start <task_spec> <worktree> <inbox> <sessions> <agent_run_id>}"
[ "$verb" = start ] || hydra_die "claude.sh: only 'start' is implemented in Wave 0 (got '$verb')"
shift
task_spec="${1:?task_spec required}"; worktree="${2:?worktree required}"
inbox="${3:?inbox required}"; sessions="${4:?sessions required}"; agent_run_id="${5:?agent_run_id required}"

repo_root="$(hydra_repo_root)"
result_path="$inbox/result.json"
mkdir -p "$inbox" "$sessions"

prompt="$("$SELF_DIR/build-worker-prompt.sh" "$task_spec" "$result_path")"

# Hermetic-ish worker invocation. The ownership PreToolUse hook is active as
# defense in depth (configured via .claude/settings within the worktree/repo).
# --add-dir binds the worktree; cwd is the worktree.
raw="$(cd "$worktree" && claude -p "$prompt" \
        --output-format json \
        --add-dir "$worktree" 2>"$sessions/$agent_run_id.stderr")" || true

printf '%s' "$raw" >"$sessions/$agent_run_id.cli.json"
session_id="$(printf '%s' "$raw" | jq -r '.session_id // empty' 2>/dev/null || true)"
jq -n --arg sid "$session_id" --arg aid "$agent_run_id" --arg vendor claude \
  '{agent_run_id:$aid, vendor:$vendor, session_id:$sid}' >"$sessions/$agent_run_id.json"

# Guarantee an inbox drop. If the worker wrote one, stamp the captured session
# id into it; otherwise synthesize a failed drop so promotion can reject cleanly.
if [ -f "$result_path" ]; then
  tmp="$(mktemp)"
  jq --arg sid "$session_id" '.session_id = (.session_id // $sid)' "$result_path" >"$tmp" 2>/dev/null \
    && mv "$tmp" "$result_path" || rm -f "$tmp"
else
  task_id="$(hydra_yaml_scalar "$task_spec" 'task_id')"
  run_id="$(hydra_yaml_scalar "$task_spec" 'run_id')"
  spec_version="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
  branch="$(hydra_yaml_scalar "$task_spec" 'branch')"
  base_commit="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
  jq -n --arg t "$task_id" --arg r "$run_id" --argjson sv "${spec_version:-1}" \
        --arg b "$branch" --arg bc "$base_commit" --arg sid "$session_id" '{
      task_id:$t, run_id:$r, spec_version:$sv, vendor:"claude", session_id:$sid,
      status:"failed", branch:$b, base_commit:$bc, head_commit:$bc,
      summary:"worker produced no result drop", files_changed:[],
      verification_claims:[], risks:["adapter synthesized a failed drop"],
      unresolved_questions:[], suggested_additional_checks:[]
    }' >"$result_path"
fi

printf '%s\n' "$agent_run_id"
