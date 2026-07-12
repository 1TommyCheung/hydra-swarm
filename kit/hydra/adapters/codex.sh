#!/usr/bin/env bash
# hydra/adapters/codex.sh — Codex CLI worker adapter (Wave 0).
#
# vendor-adapters.md §1, §4. `codex exec` runs in the assigned worktree. Sandbox
# read-only is used for the reviewer role; hooks are wired via the adapter. Same
# contract as claude.sh — the drop is untrusted; promote.sh is the boundary.
#
#   start <task_spec> <worktree> <inbox_dir> <sessions_dir> <agent_run_id>

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib.sh
source "$SELF_DIR/../scripts/lib.sh"

verb="${1:?usage: codex.sh start <task_spec> <worktree> <inbox> <sessions> <agent_run_id>}"
[ "$verb" = start ] || hydra_die "codex.sh: only 'start' is implemented in Wave 0 (got '$verb')"
shift
task_spec="${1:?task_spec required}"; worktree="${2:?worktree required}"
inbox="${3:?inbox required}"; sessions="${4:?sessions required}"; agent_run_id="${5:?agent_run_id required}"

result_path="$inbox/result.json"
mkdir -p "$inbox" "$sessions"

prompt="$("$SELF_DIR/build-worker-prompt.sh" "$task_spec" "$result_path")"

# codex exec: non-interactive, in the worktree. --json emits structured events
# (last message carries the result); we persist the stream for session capture.
( cd "$worktree" && codex exec --json --cd "$worktree" "$prompt" ) \
  >"$sessions/$agent_run_id.cli.jsonl" 2>"$sessions/$agent_run_id.stderr" || true

session_id="$(jq -rs 'map(.session_id // empty) | last // empty' \
  "$sessions/$agent_run_id.cli.jsonl" 2>/dev/null || true)"
jq -n --arg sid "$session_id" --arg aid "$agent_run_id" --arg vendor codex \
  '{agent_run_id:$aid, vendor:$vendor, session_id:$sid}' >"$sessions/$agent_run_id.json"

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
      task_id:$t, run_id:$r, spec_version:$sv, vendor:"codex", session_id:$sid,
      status:"failed", branch:$b, base_commit:$bc, head_commit:$bc,
      summary:"worker produced no result drop", files_changed:[],
      verification_claims:[], risks:["adapter synthesized a failed drop"],
      unresolved_questions:[], suggested_additional_checks:[]
    }' >"$result_path"
fi

printf '%s\n' "$agent_run_id"
