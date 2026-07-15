#!/usr/bin/env bash
# hydra/scripts/graphify-investigate.sh — investigation-not-verdict policy (Wave 2).
#
# code-intelligence.md §3 confidence policy (NORMATIVE):
#   - INFERRED edge  -> never blocking; review QUESTIONS only.
#   - EXTRACTED edge -> may open a blocking INVESTIGATION (integration pauses
#                       pending a check).
#   - An actual blocking VERDICT requires confirmation from source, diff, tests,
#     or reproducible behavior. Graph data identifies WHERE to look; it never
#     independently stops integration (roadmap success criterion #6).
#
# Given a run's Graphify baseline and a set of changed files (a candidate's diff,
# or an explicit file list for documentation-conflict detection), this emits
# investigations (EXTRACTED) and questions (INFERRED/AMBIGUOUS) that touch the
# changed surface — as ADVISORY items requiring confirmation, never verdicts.
#
# Usage:
#   graphify-investigate.sh <run_id> <task_id>            # investigate a candidate's diff
#   graphify-investigate.sh <run_id> --files <f1> <f2>... # doc-conflict / design-intent scan
#
# Exit 0 (report written) / 8 (no baseline — Graphify evidence omitted).

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" graphify-investigate "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" graphify-investigate "$@"
fi

run_id="${1:?usage: graphify-investigate.sh <run_id> <task_id> | <run_id> --files <f>...}"
shift
run_dir="$(hydra_run_dir "$run_id")"
graph="$(hydra_graphify_dir "$run_id")/graph.json"
[ -f "$graph" ] || { hydra_ledger_append "$run_id" graphify_investigation status no_baseline advisory true; hydra_warn "no Graphify baseline for run $run_id — omitted (never a blocker)"; exit 8; }

# Resolve the changed-file set + a label.
changed=()
if [ "${1:-}" = "--files" ]; then
  shift; changed=("$@"); task_id="doc-conflict"; report="$run_dir/authoritative/graph/graphify-doc-conflict.md"
else
  task_id="${1:?task_id required}"
  task_spec="$run_dir/tasks/$task_id.yaml"
  [ -f "$task_spec" ] || hydra_die "task spec not found: $task_spec"
  worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
  base="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
  mapfile -t changed < <(git -C "$worktree" diff --name-only "$base...HEAD" 2>/dev/null)
  report="$run_dir/authoritative/graph/$task_id.graphify.md"
fi
mkdir -p "$(dirname "$report")"
[ "${#changed[@]}" -gt 0 ] || { hydra_warn "no changed files to investigate"; changed=(); }

# Match an edge to the changed set if its source_file OR either endpoint node's
# source_file relates to a changed file (by basename/suffix — robust to graphify's
# path-prefix normalization). `.links` is the networkx edge array.
changed_json="$(printf '%s\n' "${changed[@]}" | jq -R 'select(length>0) | sub(".*/";"")' | jq -sc .)"

edge_filter='
  ( [ .nodes[] | {(.id): (.source_file // "")} ] | add // {} ) as $nf
  | ( .links // .edges // [] ) as $e
  | [ $e[] | select(.confidence==$conf[0] or .confidence==$conf[1])
      | . as $edge
      | [ ($edge.source_file // ""), ($nf[$edge.source] // ""), ($nf[$edge.target] // "") ]
        | map(sub(".*/";"")) as $files
      | select( any($files[]; . as $f | ($f|length>0) and any($changed[]; . as $c | $f==$c)) )
      | $edge ]'

investigations="$(jq -c --argjson changed "$changed_json" --argjson conf '["EXTRACTED","EXTRACTED"]' "$edge_filter" "$graph" 2>/dev/null || echo '[]')"
questions="$(jq -c --argjson changed "$changed_json" --argjson conf '["INFERRED","AMBIGUOUS"]' "$edge_filter" "$graph" 2>/dev/null || echo '[]')"

n_inv="$(jq 'length' <<<"$investigations")"
n_q="$(jq 'length' <<<"$questions")"

{
  echo "# Graphify investigation ($task_id) — NOT a verdict (code-intelligence §3)"
  echo
  echo "_EXTRACTED edges open a blocking INVESTIGATION (integration pauses pending a"
  echo "check). INFERRED/AMBIGUOUS edges are review QUESTIONS only. A real blocking"
  echo "verdict requires confirmation from source, diff, tests, or behavior — the"
  echo "graph says only WHERE to look. Graph evidence never blocks or approves on its own._"
  echo
  echo "## Blocking investigations (EXTRACTED, require confirmation) — $n_inv"
  jq -r '.[] | "- **\(.relation)**: \(.source) → \(.target)  _(\(.source_file), score \(.confidence_score))_ — confirm against source/diff/tests before it can block."' <<<"$investigations"
  echo
  echo "## Review questions (INFERRED/AMBIGUOUS, never blocking) — $n_q"
  jq -r '.[] | "- \(.relation): \(.source) → \(.target)  _(score \(.confidence_score))_ — worth a look; not a gate."' <<<"$questions"
} >"$report"

hydra_ledger_append "$run_id" graphify_investigation task_id "$task_id" advisory true \
  investigations "$n_inv" questions "$n_q" requires_confirmation true
hydra_log "graphify investigation ($task_id): $n_inv EXTRACTED investigations, $n_q INFERRED questions (advisory)"
printf '%s\n' "$report"
