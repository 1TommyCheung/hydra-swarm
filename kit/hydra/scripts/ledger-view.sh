#!/usr/bin/env bash
# hydra/scripts/ledger-view.sh — authoritative Layer-2 ledger web renderer (Wave 2).
#
# roadmap Wave 2 observability: "minimal ledger web renderer as Layer-2
# authoritative view." NORMATIVE RULE: live state (herdr, panes) is ADVISORY;
# Git + ledger WIN; a disagreement between them is itself an anomaly event. This
# renderer reads ONLY the append-only ledger + promoted results/reviews — the
# authoritative sources — and produces a self-contained HTML page (no external
# assets, CSP-safe). It never scrapes worker output as truth.
#
# Usage: ledger-view.sh <run_id> [out.html]
# Prints the output path.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" ledger-view "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" ledger-view "$@"
fi

run_id="${1:?usage: ledger-view.sh <run_id> [out.html]}"
run_dir="$(hydra_run_dir "$run_id")"
ledger="$run_dir/authoritative/ledger/events.jsonl"
[ -f "$ledger" ] || hydra_die "no ledger for run $run_id"
out="${2:-$run_dir/authoritative/ledger-view.html}"

# Build rows HTML from the ledger (authoritative). Escape values via jq @html.
rows="$(jq -rc '
  ([ to_entries[] | select(.key|IN("event","time","run_id")|not) | "\(.key)=\(.value)" ] | join("  ")) as $detail
  | "<tr class=\"ev-\(.event)\"><td class=\"t\">\(.time // "")</td><td class=\"e\">\(.event)</td><td class=\"d\">\($detail|@html)</td></tr>"
' "$ledger")"

n_events="$(wc -l <"$ledger" | tr -d ' ')"
n_promoted="$(grep -c '"result_promoted"' "$ledger" 2>/dev/null || echo 0)"
n_rejected="$(grep -c '"result_rejected"' "$ledger" 2>/dev/null || echo 0)"
base="$(hydra_yaml_scalar "$run_dir/run.yaml" 'base_commit' 2>/dev/null || echo '?')"

cat >"$out" <<HTML
<!doctype html><html><head><meta charset="utf-8">
<title>Hydra-Swarm run $run_id — authoritative ledger</title>
<style>
 body{font:13px/1.5 ui-monospace,Menlo,monospace;background:#111;color:#ddd;margin:0;padding:24px}
 h1{font-size:16px;color:#fff;margin:0 0 4px} .sub{color:#888;margin:0 0 16px}
 .stats{display:flex;gap:16px;margin:0 0 16px;flex-wrap:wrap}
 .stat{background:#1c1c1c;border:1px solid #333;border-radius:6px;padding:8px 14px}
 .stat b{color:#fff;font-size:18px;display:block}
 table{border-collapse:collapse;width:100%;max-width:100%}
 td{padding:5px 8px;border-bottom:1px solid #222;vertical-align:top}
 .t{color:#6aa;white-space:nowrap} .e{font-weight:700;white-space:nowrap} .d{color:#aaa;word-break:break-all}
 tr.ev-result_promoted .e{color:#4ade80} tr.ev-result_rejected .e{color:#f87171}
 tr.ev-review_verdict .e{color:#c084fc} tr.ev-graph_impact .e,tr.ev-graphify_investigation .e{color:#fbbf24}
 tr.ev-agent_usage .e{color:#60a5fa} tr.ev-combined_verification .e{color:#4ade80}
 tr.ev-task_spec_amended .e{color:#fb923c}
 .note{color:#666;margin-top:16px;font-size:11px}
</style></head><body>
<h1>Hydra-Swarm — run $run_id</h1>
<p class="sub">Authoritative Layer-2 view · base $base · rendered from the append-only ledger only</p>
<div class="stats">
 <div class="stat"><b>$n_events</b>events</div>
 <div class="stat"><b>$n_promoted</b>promoted</div>
 <div class="stat"><b>$n_rejected</b>rejected</div>
</div>
<table>$rows</table>
<p class="note">Live state (herdr/panes) is advisory; Git + ledger win. This page
never scrapes worker output as truth. A disagreement between live state and this
view is itself an anomaly event.</p>
</body></html>
HTML

hydra_log "authoritative ledger view -> $out ($n_events events)"
printf '%s\n' "$out"
