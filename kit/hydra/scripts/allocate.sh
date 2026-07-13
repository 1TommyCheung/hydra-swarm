#!/usr/bin/env bash
# hydra/scripts/allocate.sh — allocation RECOMMENDATION (vendor-adapters.md §5).
#
# Ranking pipeline (§5):
#   hard constraints (capability matrix + role rules)
#     -> availability filter
#     -> capability ranking (measured when n>=8, else seeded priors)
#     -> cost/latency tie-break
#     -> cross-vendor-review diversity override
# RECOMMEND-ONLY. No automatic role-pin changes — the ledger recommends, humans
# pin. Community-sourced claims (do_not_allocate_on) never drive allocation.
#
# Usage:
#   allocate.sh <role> <task_type> [risk] [--exclude-vendor <v>]
#     role: implementer | reviewer | explorer | visual_debugging | integrator
#
# Prints a ranked recommendation JSON with per-vendor rationale + evidence class.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/allocate.ts" "$@"
fi

role="${1:?usage: allocate.sh <role> <task_type> [risk] [--exclude-vendor <v>]}"
task_type="${2:?task_type required}"
risk="${3:-medium}"
exclude=""
[ "${4:-}" = "--exclude-vendor" ] && exclude="${5:-}"

repo_root="$(hydra_repo_root)"
prof_dir="$repo_root/hydra/profiles"
measured_dir="$(hydra_state_root)/agents/profiles"
MIN_N=8   # measured drives ranking only at n>=8 (§5); else seeded priors

# --- Hard constraints: which vendors CAN take this role at all --------------
# (capability matrix §2/§3; role rules §8; Wave 2 write-role policy)
eligible() {
  case "$role" in
    visual_debugging) echo "kimi" ;;                         # multimodal HARD pin
    implementer)      echo "claude codex kimi" ;;            # opencode read-only; kimi sandboxed
    integrator)       echo "claude codex" ;;
    reviewer)         echo "codex opencode claude" ;;        # glm long-diff; kimi small-context excluded
    explorer)         echo "claude codex opencode kimi" ;;
    *)                echo "claude codex" ;;
  esac
}

candidates=()
for v in $(eligible); do
  [ "$v" = "$exclude" ] && continue                          # diversity / cross-vendor override
  candidates+=("$v")
done
[ "${#candidates[@]}" -gt 0 ] || hydra_die "no eligible vendor for role=$role"

# canonical seed filename per vendor
seedfile() {
  case "$1" in
    claude) echo "claude-fable-5.yaml";; codex) echo "codex-gpt-5.6-sol.yaml";;
    opencode) echo "opencode-glm-5.2.yaml";; kimi) echo "kimi-k2.7-code.yaml";;
  esac
}

# --- Score each candidate ---------------------------------------------------
rows='[]'
for v in "${candidates[@]}"; do
  seed="$prof_dir/$(seedfile "$v")"
  measured="$measured_dir/$v.measured.json"
  # Seeded relevance: does any seeded_strength mention the task_type stem?
  seed_hit=0
  if [ -f "$seed" ] && grep -qiE "${task_type%%_*}|review|refactor|implement|visual|explor" "$seed"; then seed_hit=1; fi
  n_measured=0; accept="null"; divergence="null"; evidence=seeded
  if [ -f "$measured" ]; then
    n_measured="$(jq -r '(.measured.n_reviewed // .measured.n_promoted // 0)' "$measured")"
    if [ "${n_measured:-0}" -ge "$MIN_N" ]; then
      accept="$(jq -r '(.measured.acceptance_rate // 0)' "$measured")"
      divergence="$(jq -r '(.measured.claim_vs_verified_divergence // 0)' "$measured")"
      evidence=measured
    fi
  fi
  cost="$(hydra_yaml_scalar "$seed" 'cost_hint')"
  rows="$(jq -c \
    --arg v "$v" --argjson seed_hit "$seed_hit" --argjson nm "${n_measured:-0}" \
    --arg accept "$accept" --arg div "$divergence" --arg ev "$evidence" --arg cost "$cost" \
    '. + [{vendor:$v, evidence_class:$ev, n_measured:$nm, seed_relevant:($seed_hit==1),
           acceptance_rate:($accept|try tonumber catch null),
           divergence:($div|try tonumber catch null), cost_hint:$cost}]' <<<"$rows")"
done

# --- Rank: measured acceptance desc (when present) -> seed relevance -> cost -
ranked="$(jq -c '
  sort_by(
    [ (if .acceptance_rate != null then (1 - .acceptance_rate) else 0.5 end),
      (if .seed_relevant then 0 else 1 end),
      (.divergence // 0) ]
  )' <<<"$rows")"

jq -n --arg role "$role" --arg tt "$task_type" --arg risk "$risk" --arg ex "$exclude" \
  --argjson ranked "$ranked" '{
    role:$role, task_type:$tt, risk:$risk, excluded:($ex | if .=="" then null else . end),
    recommendation: ($ranked[0].vendor // null),
    ranked: $ranked,
    human_gated: true,
    note: "Recommendation only — a human pins the role. Ranking uses measured stats at n>=8, else seeded priors; community claims marked do_not_allocate_on are never used."
  }'
