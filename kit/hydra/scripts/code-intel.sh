#!/usr/bin/env bash
# hydra/scripts/code-intel.sh — combined code intelligence: GitNexus + Graphify.
#
# code-intelligence.md §1 tool selection, used TOGETHER:
#   - GitNexus  → structure: dependency / blast-radius / call-chains, file-level
#                 change detection. Deterministic AST. **JS symbols here; bash is
#                 file-level only (GitNexus has no bash parser).** Authority:
#                 RISK INPUT (§2.4) — informs review, never gates.
#   - Graphify  → intent: code + docs + design semantics, design-to-implementation
#                 traceability, documentation-conflict. Covers bash + markdown.
#                 Authority: INVESTIGATION-NOT-VERDICT (§3) — EXTRACTED opens an
#                 investigation, INFERRED is a question; never blocks alone.
#
# Neither tool independently blocks or approves integration (roadmap #6). This
# script surfaces both, each labelled with its source and authority, so the
# reviewer (human/lead) decides.
#
# Subcommands:
#   changed [--base <ref>]   what changed, structurally (GitNexus) + which design
#                            intent it touches (Graphify)
#   impact  <symbol>         blast-radius (GitNexus, JS) + semantic neighbours (Graphify)
#   query   "<question>"     execution flows (GitNexus) + semantic hits (Graphify)
#   drift                    docs-vs-code: design→implementation edges to confirm,
#                            and doc claims with no code counterpart (Graphify),
#                            code side confirmed present (GitNexus)
#
# Requires the standing Graphify graph (graphify-repo.sh build) and a GitNexus
# index (gitnexus analyze). Missing either → that half is omitted, never fatal.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/code-intel.ts" "$@"
fi

repo_root="$(hydra_repo_root)"
repo_id="${HYDRA_GITNEXUS_REPO:-$(hydra_repo_id)}"
graph="$repo_root/graphify-out/graph.json"

have_gitnexus() { command -v gitnexus >/dev/null 2>&1; }
have_graph()    { [ -f "$graph" ]; }

gn() { gitnexus "$@" --repo "$repo_id" 2>/dev/null; }

# --- Graphify helpers (read the standing graph; edges under .links) ----------
# node id -> source_file map, used to classify edge endpoints by file/area.
_gf_nodefile() { jq -c '[.nodes[] | {(.id): (.source_file // "")}] | add // {}' "$graph" 2>/dev/null; }

# Edges (with endpoint files) touching any of the given path fragments.
_gf_edges_touching() {  # args: path fragments
  local frags; frags="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
  jq -c --argjson frags "$frags" '
    ([.nodes[] | {(.id): (.source_file // "")}] | add // {}) as $nf
    | [ (.links // .edges // [])[]
        | . as $e
        | { rel:.relation, conf:.confidence, score:.confidence_score,
            src:.source, tgt:.target,
            src_file: ($nf[.source] // .source_file // ""),
            tgt_file: ($nf[.target] // "") }
        | select( any($frags[]; . as $f | (.src_file|contains($f)) or (.tgt_file|contains($f))) ) ]
  ' "$graph" 2>/dev/null || echo '[]'
}

verb="${1:-}"; shift || true
case "$verb" in
  changed)
    base="main"; [ "${1:-}" = "--base" ] && base="${2:-main}"
    echo "# code-intel: changed  (base $base)"
    echo
    echo "## Structure — GitNexus (RISK INPUT; JS symbol-level, bash file-level)"
    if have_gitnexus; then
      gn detect-changes --scope compare --base-ref "$base" | sed 's/\x1b\[[0-9;]*m//g' | head -40
    else echo "  (gitnexus not available)"; fi
    echo
    echo "## Design intent touched — Graphify (INVESTIGATION-NOT-VERDICT)"
    if have_graph; then
      mapfile -t files < <(git -C "$repo_root" diff --name-only "$base...HEAD" 2>/dev/null)
      [ "${#files[@]}" -gt 0 ] || files=(HEAD)
      _gf_edges_touching "${files[@]}" | jq -r '
        (map(select(.conf=="EXTRACTED")) ) as $inv
        | (map(select(.conf=="INFERRED" or .conf=="AMBIGUOUS"))) as $q
        | "EXTRACTED investigations (confirm against source/diff/tests): \($inv|length)",
          ($inv[]? | "  - \(.rel): \(.src) → \(.tgt)  [\(.src_file)]"),
          "INFERRED questions (never a gate): \($q|length)",
          ($q[]?  | "  - \(.rel): \(.src) → \(.tgt)")'
    else echo "  (no standing graph — run: graphify-repo.sh build)"; fi
    ;;

  impact)
    sym="${1:?usage: code-intel.sh impact <symbol>}"
    echo "# code-intel: impact  ($sym)"
    echo
    echo "## Blast radius — GitNexus (RISK INPUT; JS only)"
    if have_gitnexus; then gn impact --target "$sym" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -30 || gn context "$sym" | head -20; else echo "  (gitnexus not available)"; fi
    echo
    echo "## Semantic neighbours — Graphify (all langs + docs)"
    if have_graph; then
      _gf_edges_touching "$sym" | jq -r '.[]? | "  - \(.conf) \(.rel): \(.src) → \(.tgt)  [\(.src_file)]"' | head -20
    else echo "  (no standing graph)"; fi
    ;;

  query)
    q="${1:?usage: code-intel.sh query \"<question>\"}"
    echo "# code-intel: query  ($q)"
    echo
    echo "## Execution flows — GitNexus"
    if have_gitnexus; then gn query "$q" | sed 's/\x1b\[[0-9;]*m//g' | head -25; else echo "  (gitnexus not available)"; fi
    echo
    echo "## Semantic — Graphify"
    if have_graph; then ( cd "$repo_root" && graphify query "$q" 2>/dev/null | head -25 ); else echo "  (no standing graph)"; fi
    ;;

  drift)
    echo "# code-intel: docs-vs-code drift  (Graphify design→implementation edges)"
    echo
    have_graph || hydra_die "no standing graph — run: graphify-repo.sh build"
    # EXTRACTED edges linking a docs/ node to a hydra|src code node = the design's
    # explicit references to implementation. These are the spots to confirm the
    # code still matches the doc (the §3 'does implementation match approved
    # design intent' question). Advisory — never a verdict.
    jq -r '
      ([.nodes[] | {(.id): {f:(.source_file // ""), t:(.file_type // "")}}] | add // {}) as $nf
      | [ (.links // .edges // [])[]
          | . as $e
          | ($nf[.source].f // "") as $sf | ($nf[.target].f // "") as $tf
          | select(.confidence=="EXTRACTED")
          | select( (($sf|startswith("docs/")) and (($tf|startswith("hydra/")) or ($tf|startswith("src/"))))
                 or (($tf|startswith("docs/")) and (($sf|startswith("hydra/")) or ($sf|startswith("src/")))) )
          | { doc: (if ($sf|startswith("docs/")) then $sf else $tf end),
              code:(if ($sf|startswith("docs/")) then $tf else $sf end),
              rel:.relation } ]
      | "Design→implementation edges to confirm (EXTRACTED, advisory): \(length)",
        (.[] | "  - \(.doc)  —\(.rel)→  \(.code)")
    ' "$graph"
    echo
    echo "_These are where a doc explicitly references code. Confirm the code still"
    echo "matches the doc's claim (source/diff/tests) — Graphify says WHERE to look,"
    echo "it never independently declares a conflict (code-intelligence.md §3)._"
    ;;

  *)
    hydra_die "usage: code-intel.sh changed [--base <ref>] | impact <symbol> | query \"<q>\" | drift"
    ;;
esac
