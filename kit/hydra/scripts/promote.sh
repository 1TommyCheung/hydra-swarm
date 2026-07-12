#!/usr/bin/env bash
# hydra/scripts/promote.sh — THE TRUST BOUNDARY.
#
# task-result-review-contracts.md §2.2. Takes an UNTRUSTED worker inbox drop
# and, only if every gate passes, writes a promoted result into the
# authoritative tree. Ordered pipeline; rejection at any step emits
# `result_rejected` with a reason and PRESERVES the worktree (never cleans up
# on failure — forensics + recovery depend on it).
#
#   1. Schema validation          (result.schema.json)
#   2. Spec-version freshness      (stale drops rejected)
#   3. Git evidence               (branch/commits exist; descends from base; clean tree)
#   4. Ownership audit            (audit-ownership.sh — authoritative §5 rule set)
#   5. Sandboxed verification     (verify.sh — commands from TRACKED policy only)
#   6. Promotion                  (claims + harness-observed + divergence flags)
#
# Usage:
#   promote.sh <run_id> <task_id> <inbox_result.json>
#
# Exit 0  -> promoted. Path to promoted result printed to stdout.
# Exit 5  -> rejected (reason on stderr + result_rejected ledger event).
# Exit 2  -> usage / internal error.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

run_id="${1:?usage: promote.sh <run_id> <task_id> <inbox_result.json>}"
task_id="${2:?usage: promote.sh <run_id> <task_id> <inbox_result.json>}"
drop="${3:?usage: promote.sh <run_id> <task_id> <inbox_result.json>}"

repo_root="$(hydra_repo_root)"
run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
schema="$repo_root/hydra/schemas/result.schema.json"
verify_policy="${HYDRA_VERIFY_POLICY:-$repo_root/hydra/policies/verification.yaml}"

[ -f "$drop" ]      || hydra_die "inbox drop not found: $drop"
[ -f "$task_spec" ] || hydra_die "instantiated task spec not found: $task_spec"
[ -f "$schema" ]    || hydra_die "result schema not found: $schema"

reject() {
  local reason="$1" detail="${2:-}"
  hydra_ledger_append "$run_id" result_rejected task_id "$task_id" reason "$reason" detail "$detail"
  hydra_warn "REJECTED [$task_id]: $reason${detail:+ — $detail}"
  hydra_warn "worktree preserved for forensics/recovery"
  exit 5
}

hydra_ledger_append "$run_id" result_dropped task_id "$task_id" inbox "$drop"

# --- 1. Schema validation ---------------------------------------------------
if ! err="$(node "$SELF_DIR/jsonschema.mjs" "$schema" "$drop" 2>&1)"; then
  reject schema_invalid "$(printf '%s' "$err" | head -3 | tr '\n' ';')"
fi

# --- 2. Spec-version freshness ---------------------------------------------
spec_version_latest="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
claimed_version="$(jq -r '.spec_version' "$drop")"
if [ "$claimed_version" != "$spec_version_latest" ]; then
  reject stale_spec "claimed v$claimed_version, latest v$spec_version_latest"
fi

# --- 2b. Worker-declared status --------------------------------------------
# A drop that does not claim completion must never promote. (A `failed`/`blocked`
# drop reaching the gates and passing them on the strength of uncommitted files
# in the worktree is exactly the hole this closes.)
claimed_status="$(jq -r '.status' "$drop")"
if [ "$claimed_status" != "completed" ]; then
  reject not_completed "worker reported status '$claimed_status'"
fi

# --- Load spec fields -------------------------------------------------------
worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
branch="$(hydra_yaml_scalar "$task_spec" 'branch')"
base_commit="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
mapfile -t writable < <(hydra_yaml_list "$task_spec" 'writable_paths')

claimed_head="$(jq -r '.head_commit' "$drop")"
[ -d "$worktree" ] || reject git_evidence "worktree missing: $worktree"

# --- 3. Git evidence --------------------------------------------------------
git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1 \
  || reject git_evidence "not a git worktree: $worktree"

# Claimed head must exist as a real object.
git -C "$worktree" cat-file -e "${claimed_head}^{commit}" 2>/dev/null \
  || reject git_evidence "head_commit does not exist: $claimed_head"

# Base must exist and be an ancestor of head (branch descends from base).
git -C "$worktree" cat-file -e "${base_commit}^{commit}" 2>/dev/null \
  || reject git_evidence "base_commit does not exist: $base_commit"
git -C "$worktree" merge-base --is-ancestor "$base_commit" "$claimed_head" 2>/dev/null \
  || reject git_evidence "head does not descend from declared base"

# Claimed branch must exist and point at the claimed head.
actual_branch_head="$(git -C "$worktree" rev-parse --verify --quiet "$branch" 2>/dev/null || true)"
[ -n "$actual_branch_head" ] || reject git_evidence "branch does not exist: $branch"
full_claimed="$(git -C "$worktree" rev-parse --verify "$claimed_head" 2>/dev/null || true)"
[ "$actual_branch_head" = "$full_claimed" ] \
  || reject git_evidence "branch $branch head ($actual_branch_head) != claimed head ($full_claimed)"

# Tracked working tree must be committed (§2.1: modified-without-commit is
# invalid). Untracked files are NOT judged here — the ownership audit (§5)
# decides them against writable_paths, so generated files inside the lane pass
# while stray files outside it are rejected as ownership violations.
[ -z "$(git -C "$worktree" status --porcelain --untracked-files=no)" ] \
  || reject git_evidence "worktree has uncommitted tracked changes"

# The candidate MUST actually contain committed work. Without this, a worker can
# leave its output UNTRACKED in the worktree and still pass every gate — the
# ownership audit permits untracked files inside the lane, and verification would
# happily run against files that exist on disk but not in Git. Evidence must live
# in Git (architecture §4.1), so an empty base..head diff is not a candidate.
if [ "$(git -C "$worktree" rev-parse "$base_commit")" = "$full_claimed" ] \
   || [ -z "$(git -C "$worktree" diff --name-only "$base_commit...$full_claimed")" ]; then
  reject no_commit "head == base (or empty diff): worker produced no committed work (§2.1)"
fi

# --- 4. Ownership audit (authoritative) ------------------------------------
if ! audit_out="$("$SELF_DIR/audit-ownership.sh" "$worktree" "$base_commit" "$claimed_head" "${writable[@]}" 2>&1)"; then
  reject ownership_violation "$(printf '%s' "$audit_out" | tr '\n' ';')"
fi

# --- 5. Sandboxed verification (harness re-run; provenance = tracked policy)-
verify_dir="$run_dir/authoritative/verification"
mkdir -p "$verify_dir"
observed_json="$verify_dir/$task_id.json"
if ! "$SELF_DIR/verify.sh" "$worktree" "$verify_policy" "$observed_json" >/dev/null 2>&1; then
  hydra_ledger_append "$run_id" verification_executed task_id "$task_id" status failed
  reject verification_failed "harness re-run did not pass; see $observed_json"
fi
hydra_ledger_append "$run_id" verification_executed task_id "$task_id" status passed

# --- 6. Promotion: claims + observed + divergence --------------------------
# Divergence (§2.2): the worker's claim CONTRADICTS the harness observation on
# the SAME command. Commands the worker ran but the harness didn't (or vice
# versa) are the expected provenance gap — workers may run their own checks —
# not a divergence. We compare only the intersection of command strings.
observed="$(cat "$observed_json")"
promoted="$run_dir/authoritative/results/$task_id.json"
divergence="$(jq -n \
  --argjson claims "$(jq '.verification_claims // []' "$drop")" \
  --argjson observed "$observed" '
    ($claims  | map({key:.command, value:.status}) | from_entries) as $c
  | ($observed | map({key:.command, value:.status}) | from_entries) as $o
  | [ ($o|keys[]) as $k | select($c|has($k)) | select($c[$k] != $o[$k]) ] | length > 0
')"

jq -n \
  --slurpfile claims "$drop" \
  --argjson observed "$observed" \
  --argjson divergence "$divergence" \
  --arg promoted_at "$(hydra_now)" \
  '{
     claims: $claims[0],
     harness_observed: { verification: $observed },
     divergence: $divergence,
     promoted_at: $promoted_at
   }' >"$promoted"

hydra_ledger_append "$run_id" result_promoted task_id "$task_id" head "$full_claimed" \
  divergence "$divergence"
hydra_log "PROMOTED [$task_id] head=$full_claimed divergence=$divergence"
printf '%s\n' "$promoted"
