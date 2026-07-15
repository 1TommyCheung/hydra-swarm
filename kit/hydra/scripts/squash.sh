#!/usr/bin/env bash
# hydra/scripts/squash.sh — harness-created integration squash.
#
# task-result-review-contracts.md §4. Workers do NOT rewrite their own history
# (self-squash could hide reverted/intermediate changes from review). Review
# operated on the complete candidate branch; NOW the harness creates a single
# integration-ready commit and records provenance. The original branch is
# preserved for forensics.
#
# Built with `git commit-tree`: parent = base, tree = candidate head's tree.
# The result applies the whole base->head diff as one commit and touches no
# existing branch or worktree.
#
# Usage:
#   squash.sh <run_id> <task_id>
#
# Prints the squash commit SHA. Writes a squash record next to the promoted
# result.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" squash "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" squash "$@"
fi

run_id="${1:?usage: squash.sh <run_id> <task_id>}"
task_id="${2:?usage: squash.sh <run_id> <task_id>}"

run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
promoted="$run_dir/authoritative/results/$task_id.json"
[ -f "$task_spec" ] || hydra_die "task spec not found: $task_spec"
[ -f "$promoted" ]  || hydra_die "cannot squash a non-promoted candidate: $promoted"

worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
base_commit="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
candidate_head="$(jq -r '.claims.head_commit' "$promoted")"

git -C "$worktree" cat-file -e "${candidate_head}^{commit}" 2>/dev/null \
  || hydra_die "candidate head missing: $candidate_head"

tree="$(git -C "$worktree" rev-parse "${candidate_head}^{tree}")"
base_full="$(git -C "$worktree" rev-parse "$base_commit")"
msg="hydra(integration): squash $task_id (run $run_id)"

integration_commit="$(git -C "$worktree" commit-tree "$tree" -p "$base_full" -m "$msg")"

mapfile -t source_commits < <(git -C "$worktree" rev-list --reverse "$base_full..$candidate_head")
source_json="$(printf '%s\n' "${source_commits[@]}" | jq -R . | jq -sc .)"

record="$run_dir/authoritative/results/$task_id.squash.json"
jq -n \
  --arg candidate_head "$(git -C "$worktree" rev-parse "$candidate_head")" \
  --arg integration_commit "$integration_commit" \
  --argjson source_commits "$source_json" \
  '{candidate_head:$candidate_head, integration_commit:$integration_commit, source_commits:$source_commits}' \
  >"$record"

hydra_ledger_append "$run_id" squash_created task_id "$task_id" \
  integration_commit "$integration_commit"
hydra_log "squash for $task_id -> $integration_commit (${#source_commits[@]} source commits)"
printf '%s\n' "$integration_commit"
