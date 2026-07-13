#!/usr/bin/env bash
# TEST FIXTURE ONLY: offline deterministic stub vendor adapter.
#
# Implements the same dispatch-compatible `start` verb as claude.sh / codex.sh /
# opencode.sh so dispatch.ts drives it uniformly:
#   stub.sh start <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]
#
# Makes ZERO network or real-vendor-CLI calls. Every Git claim in its result
# drop is observed from the assigned worktree. STUB_MODE selects deterministic
# fixture behavior for promote-gate coverage:
#   success   -> commit, status "completed"
#   fail      -> commit, status "failed"                (not_completed)
#   no_commit -> no commit, status "completed"          (no_commit)

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib.sh
source "$SELF_DIR/../scripts/lib.sh"

verb="${1:?usage: stub.sh start <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]}"
case "$verb" in start|resume) ;; *) hydra_die "stub.sh: unknown verb '$verb'";; esac
shift
task_spec="${1:?task_spec required}"; worktree="${2:?worktree required}"
inbox="${3:?inbox required}"; sessions="${4:?sessions required}"; agent_run_id="${5:?agent_run_id required}"
mkdir -p "$inbox" "$sessions"

task_id="$(hydra_yaml_scalar "$task_spec" 'task_id')"
run_id="$(hydra_yaml_scalar "$task_spec" 'run_id')"
spec_version="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
[ -n "$spec_version" ] || spec_version=1

# Resolve all Git fields from the repository rather than copying claimed state
# from the task YAML. promote() independently checks these observations against
# that task specification.
declared_base="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
base_commit="$(git -C "$worktree" rev-parse "$declared_base")"
branch="$(git -C "$worktree" symbolic-ref --quiet --short HEAD)"

write_session() {
  jq -n --arg aid "$agent_run_id" \
    '{agent_run_id:$aid, vendor:"stub", session_id:""}' \
    >"$sessions/$agent_run_id.json"
}

commit_fixture_change() {
  printf 'stub worker marker for %s\n' "$agent_run_id" >"$worktree/stub-output.txt"
  git -C "$worktree" add -- stub-output.txt
  GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
    GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
    git -C "$worktree" commit -qm "stub: deterministic commit for $agent_run_id"
}

mode="${STUB_MODE:-success}"
case "$mode" in
  success|fail) commit_fixture_change ;;
  no_commit) ;;
  *) hydra_die "stub.sh: unknown STUB_MODE '$mode'" ;;
esac

head_commit="$(git -C "$worktree" rev-parse HEAD)"
files_changed="$(git -C "$worktree" diff --name-only "$base_commit...$head_commit" | jq -R . | jq -sc .)"

status=completed
summary="stub deterministic commit"
risk=""
if [ "$mode" = fail ]; then
  status=failed
  summary="stub committed but simulated a failed worker report"
  risk="stub fail mode after commit"
elif [ "$mode" = no_commit ]; then
  summary="stub simulated completed report without a commit"
  risk="stub produced no commit"
fi

jq -n --arg t "$task_id" --arg r "$run_id" --argjson sv "$spec_version" \
      --arg b "$branch" --arg bc "$base_commit" --arg h "$head_commit" \
      --arg status "$status" --arg summary "$summary" --arg risk "$risk" \
      --argjson files "${files_changed:-[]}" '{
  task_id:$t, run_id:$r, spec_version:$sv, vendor:"stub", session_id:"",
  status:$status, branch:$b, base_commit:$bc, head_commit:$h,
  summary:$summary, files_changed:$files,
  verification_claims:[], risks:(if $risk == "" then [] else [$risk] end),
  unresolved_questions:[], suggested_additional_checks:[]
}' >"$inbox/result.json"
write_session
printf '%s\n' "$agent_run_id"
