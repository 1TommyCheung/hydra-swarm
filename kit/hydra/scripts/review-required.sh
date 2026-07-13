#!/usr/bin/env bash
# hydra/scripts/review-required.sh — risk-triggered cross-vendor review decision.
#
# task-result-review-contracts §3 + roadmap Wave 1 ("cross-vendor review policy
# formalized — risk-triggered, not convention"). Given a candidate's risk and
# labels plus the implementer vendor, decides whether cross-vendor review is
# MANDATORY and which reviewer vendor to use. Pure decision helper (no state
# mutation); the lead acts on the printed JSON.
#
# Usage:
#   review-required.sh <implementer_vendor> <risk> [label ...]
#
# Prints: {"cross_vendor_required":bool,"reviewer_vendor":"<vendor|any>","reason":"..."}

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/review-required.ts" "$@"
fi

impl="${1:?usage: review-required.sh <implementer_vendor> <risk> [label...]}"
risk="${2:?risk required (low|medium|high|critical)}"; shift 2
labels=("$@")

policy="$(hydra_repo_root)/hydra/policies/review-policy.yaml"
risk_at_least="$(hydra_yaml_scalar "$policy" '    risk_at_least')"
[ -n "$risk_at_least" ] || risk_at_least=high
mapfile -t trigger_labels < <(hydra_yaml_list "$policy" '    labels_any')

rank() { case "$1" in low) echo 0;; medium) echo 1;; high) echo 2;; critical) echo 3;; *) echo 0;; esac; }

required=false
reason="no trigger matched (single-vendor review permitted)"

if [ "$(rank "$risk")" -ge "$(rank "$risk_at_least")" ]; then
  required=true
  reason="risk '$risk' >= '$risk_at_least'"
else
  for l in "${labels[@]}"; do
    for t in "${trigger_labels[@]}"; do
      if [ "$l" = "$t" ]; then required=true; reason="label '$l' triggers cross-vendor review"; break 2; fi
    done
  done
fi

reviewer=any
if [ "$required" = true ]; then
  reviewer="$(hydra_yaml_scalar "$policy" "    $impl")"
  [ -n "$reviewer" ] || reviewer="any-other-vendor"
fi

jq -cn --argjson req "$required" --arg rev "$reviewer" --arg reason "$reason" \
  '{cross_vendor_required:$req, reviewer_vendor:$rev, reason:$reason}'
