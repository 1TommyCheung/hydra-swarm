#!/usr/bin/env bash
# hydra/scripts/graph-impact.sh — GitNexus blast-radius as a RISK INPUT.
#
# code-intelligence.md §2.4 (authority): detect_changes and graph queries
# produce RISK INPUTS ONLY. The reviewer's classification, grounded in diff +
# tests, is authoritative. Static coverage is incomplete (generated code,
# reflection, DI, dynamic imports); absence of an edge is not proof of absence
# of a dependency. **Graph evidence never independently blocks or approves
# integration** (roadmap success criterion #6).
#
# Runs the freshness gate first (§2.2); if stale, refuses to emit graph evidence
# rather than emitting misleading results.
#
# Usage:
#   graph-impact.sh <run_id> <task_id>
# Writes authoritative/graph/<task_id>.md and emits a graph_impact ledger event
# (advisory=true). Always exits 0 unless the index is missing/stale (exit 8) —
# a stale graph is simply omitted from review, never a blocker.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" graph-impact "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" graph-impact "$@"
fi

command -v gitnexus >/dev/null 2>&1 || hydra_die "gitnexus CLI not found (Wave 1 dependency)"

run_id="${1:?usage: graph-impact.sh <run_id> <task_id>}"
task_id="${2:?usage: graph-impact.sh <run_id> <task_id>}"
run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "task spec not found: $task_spec"

# Freshness gate — a stale graph result must not participate in review.
if ! "$SELF_DIR/freshness-gate.sh" "$run_id" "$task_id" >/dev/null 2>&1; then
  hydra_ledger_append "$run_id" graph_impact task_id "$task_id" advisory true status stale_omitted
  hydra_warn "graph index stale/missing for $task_id — omitting graph evidence (never a blocker)"
  exit 8
fi

worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
base_commit="$(hydra_yaml_scalar "$task_spec" 'base_commit')"
index_name="hydra-$run_id-$task_id"
report="$run_dir/authoritative/graph/$task_id.md"
mkdir -p "$(dirname "$report")"

{
  echo "# Graph impact (RISK INPUT — advisory, never blocking) — $task_id"
  echo
  echo "_GitNexus static analysis. Coverage is incomplete for generated code,"
  echo "reflection, DI, dynamic imports, and external services. Absence of an edge"
  echo "is not proof of absence of a dependency (code-intelligence.md §2.4)._"
  echo
  echo "## Changed symbols & affected execution flows (base $base_commit .. HEAD)"
  echo '```'
  ( cd "$worktree" && gitnexus detect-changes --repo "$index_name" --scope compare --base-ref "$base_commit" 2>&1 ) \
    | sed 's/\x1b\[[0-9;]*m//g' | head -80 || echo "(detect-changes produced no output)"
  echo '```'
} >"$report"

# Coarse advisory signal for the ledger (NOT a gate): count referenced flows.
flows="$(grep -ciE 'flow|process|caller|affected' "$report" 2>/dev/null || echo 0)"
signal=low
[ "$flows" -ge 5 ] && signal=medium
[ "$flows" -ge 15 ] && signal=high

hydra_ledger_append "$run_id" graph_impact task_id "$task_id" advisory true \
  status ok signal "$signal"
hydra_log "graph impact for $task_id -> advisory signal=$signal (report: $report)"
printf '%s\n' "$report"
