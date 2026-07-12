#!/usr/bin/env bash
# hydra/tests/recovery-drill.sh — standing lead-recovery drill (Wave 1).
#
# roadmap Wave 1 + success criterion #2: "Replacement lead resumes an interrupted
# run from Git + state store alone." This is a REPEATABLE test: it builds a real
# mid-run state through the harness (freeze + promote a candidate), then
# simulates a lead kill by reconstructing the run in a context-free `env -i`
# shell that has ONLY the state store + Git — no conversational memory. It
# asserts the reconstruction is correct and that promoted evidence is real.
#
# Self-contained: all state redirected to a throwaway dir. Touches nothing real.

set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SELF_DIR/../scripts"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hydra-recovery.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export HYDRA_STATE_ROOT="$TMP/state"
export HYDRA_WORKTREE_ROOT="$TMP/worktrees"
export HYDRA_REPO_ID="recovery-fixture"
export HYDRA_VERIFY_POLICY="$TMP/verify.yaml"
RUN_ID="drill"

pass=0; fail=0
green() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# --- fixture repo + a promoted candidate -----------------------------------
FIX="$TMP/fixture-repo"; mkdir -p "$FIX/src"
git -C "$FIX" init -q; git -C "$FIX" config user.email t@h.local; git -C "$FIX" config user.name t
printf 'console.log(1);\n' >"$FIX/src/app.js"; git -C "$FIX" add -A; git -C "$FIX" commit -qm base
BASE="$(git -C "$FIX" rev-parse HEAD)"
printf 'verification_policy:\n  commands:\n    - node --check src/app.js\n  timeout_minutes: 1\n' >"$HYDRA_VERIFY_POLICY"

RD="$HYDRA_STATE_ROOT/runs/run-$RUN_ID"
"$SCRIPTS/run-init.sh" "$RUN_ID" >/dev/null
WT="$HYDRA_WORKTREE_ROOT/run-$RUN_ID-widget"
git -C "$FIX" worktree add -q -b "hydra/$RUN_ID/widget" "$WT" "$BASE"
printf 'console.log(2);\n' >"$WT/src/app.js"; git -C "$WT" commit -qam change
HEAD="$(git -C "$WT" rev-parse HEAD)"
cat >"$RD/tasks/widget.yaml" <<YAML
task_id: widget
run_id: $RUN_ID
spec_version: 1
base_commit: $BASE
branch: hydra/$RUN_ID/widget
worktree: $WT
assigned_vendor: claude
writable_paths:
  - src/**
verification:
  - node --check src/app.js
timeout_minutes: 1
YAML
mkdir -p "$RD/inbox/widget"
jq -n --arg h "$HEAD" --arg bc "$BASE" '{task_id:"widget",run_id:"drill",spec_version:1,vendor:"claude",session_id:"x",status:"completed",branch:"hydra/drill/widget",base_commit:$bc,head_commit:$h,summary:"t",files_changed:["src/app.js"],verification_claims:[{command:"node --check src/app.js",status:"passed"}],risks:[],unresolved_questions:[],suggested_additional_checks:[]}' >"$RD/inbox/widget/result.json"
"$SCRIPTS/promote.sh" "$RUN_ID" widget "$RD/inbox/widget/result.json" >/dev/null 2>&1

echo "Hydra-Swarm — lead-recovery drill"
echo "state: $HYDRA_STATE_ROOT"
echo

# --- SIMULATE LEAD KILL: reconstruct in a context-free env -i shell ---------
recon="$(env -i PATH="$PATH" HOME="$HOME" FIX="$FIX" RD="$RD" bash <<'RECOVER'
set -euo pipefail
ledger="$RD/authoritative/ledger/events.jsonl"
# Which tasks reached which state? (last event per task)
for spec in "$RD"/tasks/*.yaml; do
  t="$(basename "$spec" .yaml)"
  last="$(jq -r --arg t "$t" 'select(.task_id==$t)|.event' "$ledger" | tail -1)"
  head="$(jq -r --arg t "$t" 'select(.task_id==$t and .event=="result_promoted")|.head' "$ledger" | tail -1)"
  # Prove the promoted evidence is real, not claimed.
  objtype="$(git -C "$FIX" cat-file -t "$head" 2>/dev/null || echo MISSING)"
  echo "$t|$last|$head|$objtype"
done
RECOVER
)"
echo "reconstructed (no conversational context):"
printf '  %s\n' "$recon"
echo

# --- assertions -------------------------------------------------------------
line="$(printf '%s\n' "$recon" | grep '^widget|')"
laststate="$(printf '%s' "$line" | cut -d'|' -f2)"
head="$(printf '%s' "$line" | cut -d'|' -f3)"
objtype="$(printf '%s' "$line" | cut -d'|' -f4)"

[ "$laststate" = "result_promoted" ] \
  && green "reconstructed task state = result_promoted (from ledger alone)" \
  || red "expected result_promoted, got '$laststate'"

[ "$objtype" = "commit" ] \
  && green "promoted head $head is a real git commit (evidence, not claim)" \
  || red "promoted head not a real git object ($objtype)"

# The reconstruction used no files outside the state store + git.
[ -n "$head" ] && [ "$head" != "null" ] \
  && green "run fully reconstructable from state store + Git (no transcript)" \
  || red "could not reconstruct promoted head"

echo
echo "----------------------------------------"
printf 'recovery drill: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
