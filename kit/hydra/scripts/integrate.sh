#!/usr/bin/env bash
# hydra/scripts/integrate.sh — serialized convergence in one integration worktree.
#
# task-result-review-contracts.md §5–6. Convergence is serialized (architecture
# §4.3): one integration worktree, candidates applied one at a time in the
# given dependency order. Each candidate: record HEAD -> cherry-pick the
# harness squash -> stop on textual conflict -> per-candidate smoke verify ->
# record new HEAD. Then a combined verification gate over the whole branch.
#
# The planted semantic-conflict test (wave0 §3 Step 4) is expected to pass
# every per-candidate verify yet FAIL combined verification — this script must
# surface that, never merge it silently.
#
# Usage:
#   integrate.sh <run_id> <task_id_in_order>...
#
# Exit 0  -> combined verification passed; prints integration branch head.
# Exit 6  -> textual conflict (stopped; conflict recorded).
# Exit 7  -> combined verification failed (candidates applied, gate failed).

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

run_id="${1:?usage: integrate.sh <run_id> <task_id_in_order>...}"; shift
[ "$#" -ge 1 ] || hydra_die "no tasks to integrate"
order=("$@")

repo_root="$(hydra_repo_root)"
run_dir="$(hydra_run_dir "$run_id")"
# The COMBINED gate runs the full policy (incl. cross-component tests, §6).
verify_policy="${HYDRA_VERIFY_POLICY:-$repo_root/hydra/policies/verification.yaml}"
# Per-candidate smoke is TASK-SPECIFIC (§5): a candidate's own tests only, no
# cross-component checks — those belong to the combined gate. Defaults to the
# full policy when no smoke policy is provided.
smoke_policy="${HYDRA_SMOKE_POLICY:-$verify_policy}"
base_commit="$(hydra_yaml_scalar "$run_dir/run.yaml" 'base_commit')"
[ -n "$base_commit" ] || hydra_die "run base_commit not recorded in run.yaml"

int_branch="hydra-integration/$run_id"
int_worktree="$(hydra_worktree_root)/run-$run_id-integration"
[ -e "$int_worktree" ] && hydra_die "integration worktree already exists: $int_worktree"
mkdir -p "$(dirname "$int_worktree")"

git -C "$repo_root" worktree add --quiet -b "$int_branch" "$int_worktree" "$base_commit" \
  || hydra_die "failed to create integration worktree"
hydra_ledger_append "$run_id" integration_started base_commit "$base_commit" branch "$int_branch"

for task_id in "${order[@]}"; do
  record="$run_dir/authoritative/results/$task_id.squash.json"
  [ -f "$record" ] || hydra_die "no squash record for $task_id (run squash.sh first)"
  integration_commit="$(jq -r '.integration_commit' "$record")"

  before="$(git -C "$int_worktree" rev-parse HEAD)"

  if ! git -C "$int_worktree" cherry-pick "$integration_commit" >/dev/null 2>&1; then
    git -C "$int_worktree" cherry-pick --abort >/dev/null 2>&1 || true
    hydra_ledger_append "$run_id" integration_conflict task_id "$task_id" \
      conflict textual at_head "$before"
    hydra_warn "TEXTUAL CONFLICT integrating $task_id onto $before — stopped"
    exit 6
  fi

  # Per-candidate smoke verification (sandboxed, task-specific — not the cross
  # component gate).
  if ! "$SELF_DIR/verify.sh" "$int_worktree" "$smoke_policy" >/dev/null 2>&1; then
    after_fail="$(git -C "$int_worktree" rev-parse HEAD)"
    hydra_ledger_append "$run_id" integration_candidate_verify_failed task_id "$task_id" head "$after_fail"
    hydra_warn "per-candidate verification failed for $task_id"
    exit 7
  fi

  after="$(git -C "$int_worktree" rev-parse HEAD)"
  hydra_ledger_append "$run_id" candidate_integrated task_id "$task_id" head "$after"
  hydra_log "integrated $task_id: $before -> $after"
done

# --- Combined verification gate (task-result-review-contracts.md §6) --------
combined_out="$run_dir/authoritative/verification/combined.json"
if ! "$SELF_DIR/verify.sh" "$int_worktree" "$verify_policy" "$combined_out" >/dev/null 2>&1; then
  hydra_ledger_append "$run_id" combined_verification status failed
  hydra_warn "COMBINED VERIFICATION FAILED — candidates individually clean, jointly broken"
  hydra_warn "this is the gate catching a semantic conflict; NOT proposing for merge"
  exit 7
fi

head="$(git -C "$int_worktree" rev-parse HEAD)"
hydra_ledger_append "$run_id" combined_verification status passed head "$head"
hydra_log "combined verification PASSED at $head (branch $int_branch)"
printf '%s\n' "$head"
