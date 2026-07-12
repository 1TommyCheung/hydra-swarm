#!/usr/bin/env bash
# hydra/tests/run-boundary-tests.sh — the trust boundary's unit tests.
#
# wave0-implementation.md §3 Step 2: prove promote.sh REJECTS the six ways a
# worker drop can lie, before any live agent is trusted. Plus a positive
# control so we know the gate isn't rejecting everything.
#
# Each case builds an isolated fixture repo + candidate worktree, an
# instantiated task spec, and a worker drop, then asserts promote.sh's exit code
# and the `result_rejected` reason recorded in the ledger.
#
# Fully self-contained: redirects all Hydra state to a throwaway dir via
# HYDRA_STATE_ROOT / HYDRA_WORKTREE_ROOT / HYDRA_REPO_ID. Touches nothing real.

set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SELF_DIR/../scripts"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hydra-boundary.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

export HYDRA_STATE_ROOT="$TMP/state"
export HYDRA_WORKTREE_ROOT="$TMP/worktrees"
export HYDRA_REPO_ID="fixture"
export HYDRA_VERIFY_POLICY="$TMP/verify.yaml"
RUN_ID="test"

pass=0; fail=0
green() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# --- fixture product repo ---------------------------------------------------
FIX="$TMP/fixture-repo"
mkdir -p "$FIX"
git -C "$FIX" init -q
git -C "$FIX" config user.email test@hydra.local
git -C "$FIX" config user.name "Hydra Test"
mkdir -p "$FIX/src" "$FIX/docs"
printf 'console.log(1);\n' >"$FIX/src/app.js"
printf '# docs\n' >"$FIX/docs/readme.md"
git -C "$FIX" add -A
git -C "$FIX" commit -qm "base"
BASE="$(git -C "$FIX" rev-parse HEAD)"

# fixture verification policy: a deterministic syntax gate on src/app.js
cat >"$HYDRA_VERIFY_POLICY" <<YAML
verification_policy:
  commands:
    - node --check src/app.js
  timeout_minutes: 1
YAML

# --- helpers ----------------------------------------------------------------
run_dir() { printf '%s/runs/run-%s' "$HYDRA_STATE_ROOT" "$RUN_ID"; }

# make_candidate <task_id> <spec_version> : fresh worktree+branch from BASE.
# Prints the worktree path.
make_candidate() {
  local task_id="$1" spec_version="$2"
  local wt="$HYDRA_WORKTREE_ROOT/run-$RUN_ID-$task_id"
  local branch="hydra/$RUN_ID/$task_id"
  mkdir -p "$HYDRA_WORKTREE_ROOT"
  git -C "$FIX" worktree add -q -b "$branch" "$wt" "$BASE"
  mkdir -p "$(run_dir)/tasks" "$(run_dir)/authoritative/ledger" \
           "$(run_dir)/authoritative/results" "$(run_dir)/authoritative/verification" \
           "$(run_dir)/inbox/$task_id"
  cat >"$(run_dir)/tasks/$task_id.yaml" <<YAML
task_id: $task_id
run_id: $RUN_ID
spec_version: $spec_version
base_commit: $BASE
branch: $branch
worktree: $wt
assigned_vendor: claude
writable_paths:
  - src/**
  - tests/**
verification:
  - node --check src/app.js
timeout_minutes: 1
YAML
  printf '%s' "$wt"
}

# write_drop <task_id> <head> <spec_version> <verif_status> [worker_status]
write_drop() {
  local task_id="$1" head="$2" sv="$3" vstatus="$4" wstatus="${5:-completed}"
  local branch="hydra/$RUN_ID/$task_id"
  jq -n --arg t "$task_id" --arg r "$RUN_ID" --argjson sv "$sv" \
        --arg b "$branch" --arg bc "$BASE" --arg h "$head" --arg vs "$vstatus" --arg ws "$wstatus" '{
    task_id:$t, run_id:$r, spec_version:$sv, vendor:"claude", session_id:"x",
    status:$ws, branch:$b, base_commit:$bc, head_commit:$h,
    summary:"test", files_changed:["src/app.js"],
    verification_claims:[{command:"node --check src/app.js", status:$vs}],
    risks:[], unresolved_questions:[], suggested_additional_checks:[]
  }' >"$(run_dir)/inbox/$task_id/result.json"
  printf '%s' "$(run_dir)/inbox/$task_id/result.json"
}

last_reject_reason() {
  # No `tac` on macOS; filter, then take the last matching reason.
  local task_id="$1"
  jq -r --arg t "$task_id" \
    'select(.event=="result_rejected" and .task_id==$t) | .reason' \
    "$(run_dir)/authoritative/ledger/events.jsonl" 2>/dev/null | tail -1
}

# assert_reject <label> <task_id> <expected_reason>
assert_reject() {
  local label="$1" task_id="$2" want="$3" drop="$4"
  "$SCRIPTS/promote.sh" "$RUN_ID" "$task_id" "$drop" >/dev/null 2>&1
  local rc=$?
  local reason; reason="$(last_reject_reason "$task_id")"
  if [ "$rc" -eq 5 ] && [ "$reason" = "$want" ]; then
    green "$label (rc=$rc reason=$reason)"
  else
    red "$label (rc=$rc reason=${reason:-<none>}, expected 5/$want)"
  fi
}

echo "Hydra-Swarm — promote.sh boundary rejection tests"
echo "state: $HYDRA_STATE_ROOT"
echo

# --- 0. Positive control: a clean, honest candidate must PROMOTE ------------
wt="$(make_candidate ok-control 1)"
printf 'console.log(2);\n' >"$wt/src/app.js"
git -C "$wt" commit -qam "valid change"
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop ok-control "$head" 1 passed)"
if "$SCRIPTS/promote.sh" "$RUN_ID" ok-control "$drop" >/dev/null 2>&1; then
  green "positive control promotes a clean candidate"
else
  red "positive control FAILED to promote a clean candidate (rc=$?)"
fi

# --- 1. Nonexistent SHA -----------------------------------------------------
wt="$(make_candidate bad-sha 1)"
printf 'console.log(3);\n' >"$wt/src/app.js"; git -C "$wt" commit -qam c
drop="$(write_drop bad-sha deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 1 passed)"
assert_reject "1. nonexistent head SHA -> git_evidence" bad-sha git_evidence "$drop"

# --- 2. Claims 'passed' but re-run fails ------------------------------------
wt="$(make_candidate false-pass 1)"
printf 'console.log(  ;;;broken\n' >"$wt/src/app.js"   # invalid JS
git -C "$wt" commit -qam "break syntax"
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop false-pass "$head" 1 passed)"
assert_reject "2. false 'passed' claim -> verification_failed" false-pass verification_failed "$drop"

# --- 3. Diff touches a non-writable path ------------------------------------
wt="$(make_candidate out-of-lane 1)"
printf 'edited outside lane\n' >>"$wt/docs/readme.md"   # docs/ not writable
git -C "$wt" commit -qam "touch docs"
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop out-of-lane "$head" 1 passed)"
assert_reject "3. write outside writable_paths -> ownership_violation" out-of-lane ownership_violation "$drop"

# --- 4. Untracked file outside ownership ------------------------------------
wt="$(make_candidate untracked 1)"
printf 'console.log(4);\n' >"$wt/src/app.js"; git -C "$wt" commit -qam c
printf 'stray\n' >"$wt/evil.txt"                        # untracked, root, out of lane
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop untracked "$head" 1 passed)"
assert_reject "4. untracked file outside ownership -> ownership_violation" untracked ownership_violation "$drop"

# --- 5. Symlink escaping the worktree ---------------------------------------
wt="$(make_candidate symlink-escape 1)"
ln -s /etc/passwd "$wt/src/leak"                        # inside lane, target escapes
git -C "$wt" add src/leak; git -C "$wt" commit -qam "add escaping symlink"
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop symlink-escape "$head" 1 passed)"
assert_reject "5. symlink escapes worktree -> ownership_violation" symlink-escape ownership_violation "$drop"

# --- 6. Stale spec_version --------------------------------------------------
wt="$(make_candidate stale 2)"                          # latest spec is v2
printf 'console.log(6);\n' >"$wt/src/app.js"; git -C "$wt" commit -qam c
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop stale "$head" 1 passed)"             # drop claims v1
assert_reject "6. stale spec_version -> stale_spec" stale stale_spec "$drop"

# --- 7. Uncommitted work: worker left output UNTRACKED, never committed -----
# Real regression (Wave 2, run 0007): Kimi wrote the file but never committed it.
# The tree looks "clean" (untracked ignored), the ownership audit permits
# untracked files inside the lane, and verification passes against the file
# sitting on disk — so the candidate promoted with head == base and NO work in
# Git. Evidence must live in Git (architecture §4.1).
wt="$(make_candidate no-commit 1)"
printf 'console.log(7);\n' >"$wt/src/uncommitted.js"   # written, never committed
head="$(git -C "$wt" rev-parse HEAD)"                  # == BASE
drop="$(write_drop no-commit "$head" 1 passed)"
assert_reject "7. work left uncommitted (head==base) -> no_commit" no-commit no_commit "$drop"

# --- 8. Worker-declared failure must never promote --------------------------
wt="$(make_candidate declared-fail 1)"
printf 'console.log(8);\n' >"$wt/src/app.js"; git -C "$wt" commit -qam c
head="$(git -C "$wt" rev-parse HEAD)"
drop="$(write_drop declared-fail "$head" 1 passed failed)"   # status: failed
assert_reject "8. worker-declared 'failed' status -> not_completed" declared-fail not_completed "$drop"

echo
echo "----------------------------------------"
printf 'boundary tests: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
