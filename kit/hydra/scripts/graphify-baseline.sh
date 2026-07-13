#!/usr/bin/env bash
# hydra/scripts/graphify-baseline.sh — Graphify baseline over code + docs (Wave 2).
#
# code-intelligence.md §3: built at run baseline over code + docs + diagrams;
# external state, RUN-SCOPED; never per-candidate (LLM cost). Primary consumers:
# documentation-conflict detection and the "does the implementation still match
# approved design intent" combined-review question.
#
# The semantic pass is LLM-backed. Backends: claude (ANTHROPIC_API_KEY) or kimi
# (MOONSHOT_API_KEY). A Kimi *coding-plan* key (api.kimi.com/coding) works via
# GRAPHIFY_KIMI_BASE_URL + GRAPHIFY_KIMI_MODEL overrides (patched in-memory, the
# installed package is untouched). No key -> no baseline; Graphify evidence is
# simply omitted (never a blocker; §3 + criterion #6).
#
# Usage: graphify-baseline.sh <run_id> [source_path] [--backend claude|kimi]

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

command -v graphify >/dev/null 2>&1 || hydra_die "graphify CLI not found (Wave 2 dependency)"

run_id="${1:?usage: graphify-baseline.sh <run_id> [source_path] [--backend claude|kimi]}"
src="${2:-$(hydra_repo_root)}"
backend="kimi"
[ "${3:-}" = "--backend" ] && backend="${4:-kimi}"

out_dir="$(hydra_graphify_dir "$run_id")"
mkdir -p "$out_dir"

key_present=false
case "$backend" in
  claude) [ -n "${ANTHROPIC_API_KEY:-}" ] && key_present=true ;;
  kimi)   [ -n "${MOONSHOT_API_KEY:-}" ] && key_present=true ;;
esac
if [ "$key_present" != true ]; then
  hydra_ledger_append "$run_id" graphify_baseline status skipped_no_key backend "$backend"
  hydra_warn "no LLM key for graphify --backend $backend; Graphify baseline omitted (never a blocker)"
  exit 8
fi

hydra_log "building Graphify baseline over $src (backend $backend)"
if [ "$backend" = kimi ] && [ -n "${GRAPHIFY_KIMI_BASE_URL:-}" ]; then
  # In-memory backend override for a coding-plan key; installed package untouched.
  # Use graphify's own interpreter (PATH python3 may lack the package).
  gpy="$(dirname "$(command -v graphify)")/python3"; [ -x "$gpy" ] || gpy="python3"
  ( cd "$src" && "$gpy" - "$src" "$out_dir" <<'PY' >/dev/null 2>&1
import sys, runpy, os
import graphify.llm as L
# Point the kimi backend at the coding-plan endpoint the key belongs to.
L.BACKENDS["kimi"]["base_url"] = os.environ["GRAPHIFY_KIMI_BASE_URL"]
L.BACKENDS["kimi"]["default_model"] = os.environ.get("GRAPHIFY_KIMI_MODEL", "kimi-for-coding")
# api.kimi.com/coding authenticates the kimi-code-cli device — send its
# User-Agent so requests match the login. graphify imports OpenAI lazily, so
# patch the source class `openai.OpenAI` (picked up at call time).
_UA = os.environ.get("GRAPHIFY_KIMI_USER_AGENT", "kimi-code-cli/0.23.6")
import openai as _oai
_Orig = _oai.OpenAI
def _Patched(*a, **k):
    h = dict(k.get("default_headers") or {})
    h.setdefault("User-Agent", _UA)
    k["default_headers"] = h
    return _Orig(*a, **k)
_oai.OpenAI = _Patched
src, out = sys.argv[1], sys.argv[2]
sys.argv = ["graphify", "extract", src, "--backend", "kimi", "--out", out]
runpy.run_module("graphify", run_name="__main__")
PY
  ) || hydra_die "graphify extract (override) failed"
else
  ( cd "$src" && graphify extract "$src" --backend "$backend" --out "$out_dir" ) >/dev/null 2>&1 \
    || hydra_die "graphify extract failed"
fi

# graphify may nest graphify-out under --out; locate the graph.json.
graph="$(find "$out_dir" -name graph.json -type f 2>/dev/null | head -1)"
[ -n "$graph" ] && [ -f "$graph" ] || hydra_die "graphify produced no graph.json under $out_dir"

nodes="$(jq '.nodes|length' "$graph" 2>/dev/null || echo 0)"
edges="$(jq '(.links // .edges)|length' "$graph" 2>/dev/null || echo 0)"
extracted="$(jq '[(.links // .edges)[]|select(.confidence=="EXTRACTED")]|length' "$graph" 2>/dev/null || echo 0)"
inferred="$(jq '[(.links // .edges)[]|select(.confidence=="INFERRED")]|length' "$graph" 2>/dev/null || echo 0)"
# Stable pointer for consumers.
ln -sf "$graph" "$out_dir/graph.json" 2>/dev/null || cp "$graph" "$out_dir/graph.json"

hydra_ledger_append "$run_id" graphify_baseline status ok backend "$backend" \
  nodes "$nodes" edges "$edges" extracted "$extracted" inferred "$inferred"
hydra_log "Graphify baseline: $nodes nodes, $edges edges ($extracted EXTRACTED / $inferred INFERRED)"
printf '%s\n' "$out_dir/graph.json"
