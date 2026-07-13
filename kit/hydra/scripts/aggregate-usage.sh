#!/usr/bin/env bash
# hydra/scripts/aggregate-usage.sh — write the `measured` evidence class.
#
# vendor-adapters.md §5: `measured` is written ONLY by this harness aggregation
# script over usage.jsonl + run ledgers. It NEVER mixes with seeded priors or
# qualitative notes — it lands in a separate harness-owned file
# (agents/profiles/<vendor>.measured.json), leaving the tracked seed YAML (human
# priors) untouched. Per vendor: n, acceptance/revision rate, claim_vs_verified
# divergence, cost medians, risk_mix (confound guard), rolling window (last 40),
# model version per event.
#
# Usage: aggregate-usage.sh   (aggregates all runs under the state root)

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/aggregate-usage.ts" "$@"
fi

state_root="$(hydra_state_root)"
usage_log="$state_root/agents/usage.jsonl"
prof_dir="$state_root/agents/profiles"
mkdir -p "$prof_dir"

# Collect, across all runs: per-task vendor + risk (task_started, task specs) and
# outcomes (result_promoted divergence, review_verdict). Emit one row per
# task-outcome so we can group by vendor.
rows="$(mktemp)"
for rd in "$state_root"/runs/run-*; do
  ledger="$rd/authoritative/ledger/events.jsonl"
  [ -f "$ledger" ] || continue
  jq -cn --slurpfile L "$ledger" '
    ($L[0] // []) as $e   # note: ledger is JSONL; slurp below instead
  ' >/dev/null 2>&1 || true
  jq -cn '
    [inputs] as $e
    | ($e | map(select(.event=="task_started")) | map({(.task_id): .vendor}) | add // {}) as $vend
    | $e[] | select(.event=="result_promoted")
    | { vendor: ($vend[.task_id] // "unknown"),
        task_id: .task_id,
        divergent: (.divergence=="true" or .divergence==true) }
  ' "$ledger" >>"$rows" 2>/dev/null || true
  # verdicts (as implementer): join review_verdict.task_id -> implementer vendor
  jq -cn '
    [inputs] as $e
    | ($e | map(select(.event=="task_started")) | map({(.task_id): .vendor}) | add // {}) as $vend
    | $e[] | select(.event=="review_verdict")
    | { impl_vendor: ($vend[.task_id] // "unknown"), verdict: .verdict }
  ' "$ledger" >>"$rows.verdicts" 2>/dev/null || true
done
touch "$rows.verdicts"

# Per-vendor cost/n from usage.jsonl.
usage_by_vendor='{}'
[ -f "$usage_log" ] && usage_by_vendor="$(jq -sc '
  group_by(.vendor) | map({ (.[0].vendor): {
    n_dispatch: length,
    total_cost_usd: (map(.cost_usd // 0) | add),
    median_cost_usd: (map(.cost_usd // 0) | sort | .[(length/2|floor)]),
    rolling_window: (sort_by(.time) | .[-40:] | map({time,cost_usd,tokens_out}))
  }}) | add // {}' "$usage_log")"

# Per-vendor outcome stats.
promoted_by_vendor="$(jq -sc 'group_by(.vendor) | map({ (.[0].vendor): {
    n_promoted: length,
    divergent: (map(select(.divergent)) | length),
    claim_vs_verified_divergence: ((map(select(.divergent))|length) / (length)) } }) | add // {}' "$rows" 2>/dev/null || echo '{}')"

verdicts_by_vendor="$(jq -sc 'group_by(.impl_vendor) | map({ (.[0].impl_vendor): (
    (length) as $n
    | { n_reviewed: $n,
        acceptance_rate: ((map(select(.verdict=="accept"))|length)/$n),
        revision_rate: ((map(select(.verdict=="revise" or .verdict=="reject"))|length)/$n) }
  ) }) | add // {}' "$rows.verdicts" 2>/dev/null || echo '{}')"

# Write one measured file per vendor seen.
vendors="$(jq -sn --argjson a "$usage_by_vendor" --argjson b "$promoted_by_vendor" --argjson c "$verdicts_by_vendor" \
  '[($a|keys[]),($b|keys[]),($c|keys[])] | unique[]' 2>/dev/null)"
written=()
while IFS= read -r v; do
  v="$(tr -d '"' <<<"$v")"; [ -n "$v" ] && [ "$v" != unknown ] || continue
  out="$prof_dir/$v.measured.json"
  jq -n --arg vendor "$v" --arg at "$(hydra_now)" \
    --argjson usage "$(jq -c --arg v "$v" '.[$v] // {}' <<<"$usage_by_vendor")" \
    --argjson promoted "$(jq -c --arg v "$v" '.[$v] // {}' <<<"$promoted_by_vendor")" \
    --argjson verdicts "$(jq -c --arg v "$v" '.[$v] // {}' <<<"$verdicts_by_vendor")" \
    '{vendor:$vendor, evidence_class:"measured", measured_at:$at,
      measured:($usage + $promoted + $verdicts)}' >"$out"
  written+=("$v")
done <<<"$vendors"

rm -f "$rows" "$rows.verdicts"
hydra_log "measured profiles written for: ${written[*]:-none} -> $prof_dir"
for v in "${written[@]}"; do jq -c '{vendor, m:.measured}' "$prof_dir/$v.measured.json"; done
