#!/usr/bin/env bash
# hydra/scripts/record-review.sh — record a branch-review verdict.
#
# task-result-review-contracts.md §3. A reviewer's output is UNTRUSTED like any
# agent output: this script validates it against review.schema.json before
# writing it to the authoritative tree and emitting a review_verdict ledger
# event. Keeps the "only harness scripts write authoritative state" invariant
# (it is the `record-review` operation from the daemon hardening milestone).
#
# Usage:
#   record-review.sh <run_id> <task_id> <verdict.json>
#
# Exit 0 -> recorded (path printed). Exit 5 -> invalid verdict (rejected).

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/record-review.ts" "$@"
fi

run_id="${1:?usage: record-review.sh <run_id> <task_id> <verdict.json>}"
task_id="${2:?usage: record-review.sh <run_id> <task_id> <verdict.json>}"
verdict="${3:?usage: record-review.sh <run_id> <task_id> <verdict.json>}"

repo_root="$(hydra_repo_root)"
schema="$repo_root/hydra/schemas/review.schema.json"
run_dir="$(hydra_run_dir "$run_id")"
[ -f "$verdict" ] || hydra_die "verdict file not found: $verdict"

if ! err="$(node "$SELF_DIR/jsonschema.mjs" "$schema" "$verdict" 2>&1)"; then
  hydra_ledger_append "$run_id" review_rejected task_id "$task_id" \
    reason schema_invalid detail "$(printf '%s' "$err" | head -2 | tr '\n' ';')"
  hydra_warn "review verdict rejected (schema): $err"
  exit 5
fi

out="$run_dir/authoritative/reviews/$task_id.json"
mkdir -p "$(dirname "$out")"
cp "$verdict" "$out"

v="$(jq -r '.verdict' "$out")"
reviewer="$(jq -r '.reviewer // "unknown"' "$out")"
risk="$(jq -r '.risk // "unknown"' "$out")"
hydra_ledger_append "$run_id" review_verdict task_id "$task_id" \
  verdict "$v" reviewer "$reviewer" risk "$risk"
hydra_log "review recorded [$task_id]: $v (reviewer=$reviewer risk=$risk)"
printf '%s\n' "$out"
