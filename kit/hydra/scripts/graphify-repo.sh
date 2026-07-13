#!/usr/bin/env bash
# hydra/scripts/graphify-repo.sh — standing repo-wide semantic graph (code + docs).
#
# code-intelligence.md §3. Unlike graphify-baseline.sh (run-scoped, ephemeral,
# for a single candidate's investigation), this maintains a PERSISTENT graph over
# the whole repository — the harness's own semantic map of code + docs. It is the
# substrate for design-to-implementation traceability and documentation-conflict
# detection (the "does the implementation still match approved design intent"
# question), including over the bash harness and markdown docs that GitNexus
# cannot parse into symbols.
#
# Stored in graphify-out/ (gitignored) at the repo root — the tool's default
# location, so `graphify query` / code-intel.sh find it with no flags.
#
# Verbs:
#   build            full semantic extraction (AST + LLM) over the repo
#   update           AST-only re-extraction of changed code (no LLM, cheap)
#   query "<q>"      BFS traversal of the standing graph for a question
#   status           node/edge counts + freshness vs HEAD
#
# LLM backend (build only): claude (ANTHROPIC_API_KEY) or kimi (MOONSHOT_API_KEY).
# A Kimi coding-plan key works via GRAPHIFY_KIMI_BASE_URL + a kimi-code-cli
# User-Agent patch (installed package untouched).

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/graphify-repo.ts" "$@"
fi

command -v graphify >/dev/null 2>&1 || hydra_die "graphify CLI not found (Wave 2 dependency)"
repo_root="$(hydra_repo_root)"
out_dir="$repo_root/graphify-out"
graph="$out_dir/graph.json"
stamp="$out_dir/.hydra_indexed_commit"

verb="${1:-status}"; shift || true

_extract() {
  local backend="${1:-kimi}"
  # Use the interpreter that ships with the graphify CLI, not PATH python3.
  local gpy; gpy="$(dirname "$(command -v graphify)")/python3"
  [ -x "$gpy" ] || gpy="python3"
  local cap="${GRAPHIFY_TIMEOUT_SEC:-900}"

  # --- claude-cli: route graphify's claude backend through the AUTHENTICATED
  # `claude` CLI (no raw ANTHROPIC_API_KEY needed) --------------------------
  # graphify's claude backend calls api.anthropic.com directly; here we patch
  # _call_claude to shell out to `claude -p` instead, using the Claude Code login.
  # Three things this required (each a real gotcha):
  #   - stdin=DEVNULL: else the nested claude inherits our stdin and treats it as
  #     extra prompt input (and flags it as injection).
  #   - --allowedTools "": pure completion; no agentic tool use / hook interference.
  #   - the extraction schema goes in the USER turn as a task, NOT a system-prompt
  #     persona (Claude Code refuses "you are a JSON-only agent" role overrides).
  if [ "$backend" = claude-cli ]; then
    command -v claude >/dev/null 2>&1 || hydra_die "claude CLI not found (backend claude-cli)"
    hydra_log "building standing repo graph via authenticated claude CLI (${GRAPHIFY_CLAUDE_MODEL:-claude-sonnet-5})…"
    ( cd "$repo_root" && hydra_timeout "$cap" "$gpy" - "$repo_root" <<'PY' >/dev/null 2>&1
import sys, runpy, os, subprocess, json
import graphify.llm as L
os.environ["ANTHROPIC_API_KEY"] = "via-claude-cli"          # satisfy graphify's precheck
L.BACKENDS["claude"]["default_model"] = os.environ.get("GRAPHIFY_CLAUDE_MODEL", "claude-sonnet-5")
_SCHEMA = L._EXTRACTION_SYSTEM
def _claude_cli(api_key, model, user_message):
    prompt = ("Extract a knowledge-graph fragment from the files below per these rules; "
              "reply with ONLY the JSON object (no prose, no code fences):\n\n"
              + _SCHEMA + "\n\n--- FILES ---\n" + user_message)
    try:
        p = subprocess.run(
            ["claude","-p",prompt,"--model",model,"--output-format","json","--allowedTools",""],
            capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        out = json.loads(p.stdout or "{}")
    except Exception:
        out = {}
    res = L._parse_llm_json(out.get("result","") or "{}")
    u = out.get("usage",{}) or {}
    res["input_tokens"]=u.get("input_tokens",0); res["output_tokens"]=u.get("output_tokens",0)
    res["model"]=model; res["finish_reason"] = "length" if out.get("stop_reason")=="max_tokens" else "stop"
    return res
L._call_claude = _claude_cli
# graphify batches files up to token_budget=60_000 per chunk — far too large for
# a single claude-CLI call (the whole chunk fails and is SKIPPED, silently
# dropping all its files). Shrink the budget so docs extract reliably (a single
# ~6KB doc yields ~26 nodes; a giant multi-doc chunk yields nothing).
_orig_ecp = L.extract_corpus_parallel
def _ecp(*a, **k):
    k.setdefault("token_budget", int(os.environ.get("GRAPHIFY_TOKEN_BUDGET", "12000")))
    return _orig_ecp(*a, **k)
L.extract_corpus_parallel = _ecp
src = sys.argv[1]
sys.argv = ["graphify","extract",src,"--backend","claude","--out",src]
runpy.run_module("graphify", run_name="__main__")
PY
    ) || hydra_die "graphify extract via claude CLI failed or timed out after ${cap}s"
    [ -f "$graph" ] || graph="$(find "$out_dir" -name graph.json | head -1)"
    [ -f "$graph" ] || hydra_die "graphify produced no graph.json"
    git -C "$repo_root" rev-parse HEAD >"$stamp"
    return 0
  fi

  local key_ok=false
  case "$backend" in
    claude) [ -n "${ANTHROPIC_API_KEY:-}" ] && key_ok=true ;;
    kimi)   [ -n "${MOONSHOT_API_KEY:-}" ] && key_ok=true ;;
  esac
  [ "$key_ok" = true ] || hydra_die "no LLM key for graphify --backend $backend (set ANTHROPIC_API_KEY / MOONSHOT_API_KEY, or use backend 'claude-cli')"

  hydra_log "building standing repo graph over code + docs (backend $backend)…"
  if [ "$backend" = kimi ] && [ -n "${GRAPHIFY_KIMI_BASE_URL:-}" ]; then
    ( cd "$repo_root" && hydra_timeout "$cap" "$gpy" - "$repo_root" <<'PY' >/dev/null 2>&1
import sys, runpy, os
import graphify.llm as L
L.BACKENDS["kimi"]["base_url"] = os.environ["GRAPHIFY_KIMI_BASE_URL"]
L.BACKENDS["kimi"]["default_model"] = os.environ.get("GRAPHIFY_KIMI_MODEL", "kimi-for-coding")
import openai as _oai
_UA = os.environ.get("GRAPHIFY_KIMI_USER_AGENT", "kimi-code-cli/0.23.6")
_Orig = _oai.OpenAI
def _P(*a, **k):
    h = dict(k.get("default_headers") or {}); h.setdefault("User-Agent", _UA); k["default_headers"] = h
    return _Orig(*a, **k)
_oai.OpenAI = _P
src = sys.argv[1]
sys.argv = ["graphify", "extract", src, "--backend", "kimi", "--out", src]
runpy.run_module("graphify", run_name="__main__")
PY
    ) || hydra_die "graphify extract (override) failed or timed out after ${cap}s"
  else
    ( cd "$repo_root" && hydra_timeout "$cap" graphify extract "$repo_root" --backend "$backend" --out "$repo_root" ) >/dev/null 2>&1 \
      || hydra_die "graphify extract failed or timed out after ${cap}s"
  fi
  # graphify writes graphify-out/graph.json under --out.
  [ -f "$graph" ] || graph="$(find "$out_dir" -name graph.json | head -1)"
  [ -f "$graph" ] || hydra_die "graphify produced no graph.json"
  git -C "$repo_root" rev-parse HEAD >"$stamp"
}

case "$verb" in
  build)
    _extract "${1:-kimi}"
    n="$(jq '.nodes|length' "$graph" 2>/dev/null || echo 0)"
    e="$(jq '(.links // .edges)|length' "$graph" 2>/dev/null || echo 0)"
    ex="$(jq '[(.links // .edges)[]|select(.confidence=="EXTRACTED")]|length' "$graph" 2>/dev/null || echo 0)"
    hydra_log "standing repo graph: $n nodes, $e edges ($ex EXTRACTED) -> $graph"
    printf '%s\n' "$graph"
    ;;
  update)
    [ -f "$graph" ] || hydra_die "no standing graph yet; run: graphify-repo.sh build"
    ( cd "$repo_root" && graphify update "$repo_root" ) 2>&1 | tail -3
    git -C "$repo_root" rev-parse HEAD >"$stamp"
    ;;
  query)
    [ -f "$graph" ] || hydra_die "no standing graph yet; run: graphify-repo.sh build"
    q="${1:?usage: graphify-repo.sh query \"<question>\"}"
    ( cd "$repo_root" && graphify query "$q" )
    ;;
  status)
    if [ -f "$graph" ]; then
      indexed="$(cat "$stamp" 2>/dev/null || echo unknown)"
      head="$(git -C "$repo_root" rev-parse HEAD)"
      fresh=$([ "$indexed" = "$head" ] && echo "up-to-date" || echo "STALE (indexed ${indexed:0:8}, HEAD ${head:0:8})")
      printf 'standing repo graph: %s nodes, %s edges — %s\n' \
        "$(jq '.nodes|length' "$graph")" "$(jq '(.links // .edges)|length' "$graph")" "$fresh"
    else
      echo "no standing repo graph yet — run: graphify-repo.sh build"
    fi
    ;;
  *) hydra_die "usage: graphify-repo.sh build|update|query \"<q>\"|status" ;;
esac
