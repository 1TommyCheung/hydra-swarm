#!/usr/bin/env bash
# hydra/scripts/freshness-gate.sh — graph-index freshness gate (code-intelligence §2.2).
#
# "A graph result participates in review only if current HEAD == indexed_commit
# AND the working tree is clean; otherwise re-index." Index identity equals HEAD
# holds only at index time — this gate re-checks it at query time.
#
# Usage:
#   freshness-gate.sh <run_id> <task_id>
# Exit 0 -> fresh (safe to query). Exit 8 -> stale (must re-index). Exit 2 -> usage.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" freshness-gate "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" freshness-gate "$@"
fi

run_id="${1:?usage: freshness-gate.sh <run_id> <task_id>}"
task_id="${2:?usage: freshness-gate.sh <run_id> <task_id>}"
run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
manifest="$run_dir/authoritative/graph/$task_id.manifest.yaml"
[ -f "$task_spec" ] || hydra_die "task spec not found: $task_spec"
[ -f "$manifest" ]  || { hydra_warn "no index manifest for $task_id — stale"; exit 8; }

worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
[ -d "$worktree" ] || hydra_die "worktree not found: $worktree"

indexed_commit="$(hydra_yaml_scalar "$manifest" 'indexed_commit')"
current_head="$(git -C "$worktree" rev-parse HEAD)"
dirty="$(git -C "$worktree" status --porcelain --untracked-files=no)"

if [ "$indexed_commit" != "$current_head" ]; then
  hydra_warn "STALE: indexed $indexed_commit != HEAD $current_head"
  exit 8
fi
if [ -n "$dirty" ]; then
  hydra_warn "STALE: working tree dirty since index"
  exit 8
fi
hydra_log "fresh: index == HEAD ($current_head), tree clean"
exit 0
