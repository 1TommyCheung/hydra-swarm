#!/usr/bin/env bash
# hydra/scripts/measure-divergence.sh — per-vendor claim_vs_verified_divergence.
#
# roadmap success criterion #7: "Per-vendor claim_vs_verified_divergence measured
# by end of Wave 1." Aggregates the divergence flag recorded on every
# result_promoted event (promote.sh §2.2) across one or all runs, grouped by
# vendor, into a measured scorecard written to agents/ (Domain 2). This is the
# `measured` evidence class of vendor-adapters §5 — written ONLY by the harness,
# never mixed with seeded priors.
#
# Usage:
#   measure-divergence.sh [run_id ...]     # default: all runs under the state root
#
# Prints the scorecard JSON and writes agents/divergence-scorecard.json.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/measure-divergence.ts" "$@"
fi

state_root="$(hydra_state_root)"
runs=()
if [ "$#" -gt 0 ]; then
  for r in "$@"; do runs+=("$state_root/runs/run-$r"); done
else
  while IFS= read -r d; do runs+=("$d"); done < <(find "$state_root/runs" -maxdepth 1 -type d -name 'run-*' 2>/dev/null | sort)
fi
[ "${#runs[@]}" -gt 0 ] || hydra_die "no runs found under $state_root/runs"

# Join each result_promoted (has divergence) with its task_started (has vendor)
# within the same run, then aggregate per vendor.
tmp="$(mktemp)"
for rd in "${runs[@]}"; do
  ledger="$rd/authoritative/ledger/events.jsonl"
  [ -f "$ledger" ] || continue
  jq -cn '
    [inputs] as $events
    | ($events | map(select(.event=="task_started")) | map({(.task_id): .vendor}) | add // {}) as $vend
    | $events[] | select(.event=="result_promoted")
    | {vendor: ($vend[.task_id] // "unknown"),
       divergence: (.divergence == "true" or .divergence == true)}
  ' "$ledger" >>"$tmp" 2>/dev/null || true
done

scorecard="$(jq -sc '
  group_by(.vendor)
  | map({ (.[0].vendor): {
        n: length,
        divergent: (map(select(.divergence)) | length),
        claim_vs_verified_divergence: ((map(select(.divergence)) | length) / length)
      } }) | add // {}
' "$tmp")"
rm -f "$tmp"
[ -n "$scorecard" ] || scorecard='{}'

out="$state_root/agents/divergence-scorecard.json"
mkdir -p "$(dirname "$out")"
jq -n --argjson s "$scorecard" --arg at "$(hydra_now)" \
  '{measured_at:$at, evidence_class:"measured", per_vendor:$s}' | tee "$out"
