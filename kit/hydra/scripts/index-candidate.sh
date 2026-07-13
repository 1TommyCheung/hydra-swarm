#!/usr/bin/env bash
# hydra/scripts/index-candidate.sh — harness-generated, post-freeze GitNexus index.
#
# code-intelligence.md §2.1 (normative index custody). A worker-writable
# .gitnexus/ could let a worker shape the index that later informs its own
# review, so indexes that participate in review are HARNESS-generated AFTER the
# candidate is frozen:
#   1. worker done + committed (dispatch ended)
#   2. confirm clean worktree + expected HEAD
#   3. delete any worker-created graph artifacts
#   4. build a fresh index (--index-only: no AGENTS.md/CLAUDE.md/skills injection)
#   5. copy to external custody keyed by commit + write the manifest (§2.2)
#   6. mark the in-worktree index read-only for the review phase
#
# Usage:
#   index-candidate.sh <run_id> <task_id> [logical_label]
#     logical_label defaults to candidate/<task_id>/<head-sha> (§2.3)
#
# Prints the registered index name. Requires the `gitnexus` CLI.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-bash}" = "ts" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/index-candidate.ts" "$@"
fi

command -v gitnexus >/dev/null 2>&1 || hydra_die "gitnexus CLI not found (Wave 1 dependency)"

run_id="${1:?usage: index-candidate.sh <run_id> <task_id> [logical_label]}"
task_id="${2:?usage: index-candidate.sh <run_id> <task_id> [logical_label]}"
run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "task spec not found: $task_spec"

worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
[ -d "$worktree" ] || hydra_die "worktree not found: $worktree"
head_sha="$(git -C "$worktree" rev-parse HEAD)"
logical="${3:-candidate/$task_id/$head_sha}"

# --- 2. Freeze verification: clean tracked tree + expected HEAD -------------
# (Untracked derived files like a worker's own .gitnexus are removed next; only
# tracked modifications would indicate the worker isn't actually frozen.)
[ -z "$(git -C "$worktree" status --porcelain --untracked-files=no)" ] \
  || hydra_die "worktree has uncommitted tracked changes; not frozen: $worktree"

# --- 3. Delete any worker-created graph artifacts --------------------------
rm -rf "$worktree/.gitnexus"
# Ensure the index can never dirty the worktree even if base lacks the ignore.
exclude_file="$(git -C "$worktree" rev-parse --git-path info/exclude)"
grep -qxF '.gitnexus/' "$exclude_file" 2>/dev/null || echo '.gitnexus/' >>"$exclude_file"

# --- 4. Build a fresh index (registered by name; no tracked-file injection) -
# --skip-agents-md + --skip-skills avoid mutating AGENTS.md/CLAUDE.md/skills
# (which would dirty the frozen worktree), while --name still registers the
# index so reviewers can target it with `detect-changes -r`. (--index-only would
# skip registration too, leaving nothing to query.)
index_name="hydra-$run_id-$task_id"
hydra_log "indexing $task_id @ $head_sha as '$index_name'"
gitnexus analyze --skip-agents-md --skip-skills --name "$index_name" \
  --allow-duplicate-name "$worktree" >/dev/null 2>&1 \
  || hydra_die "gitnexus analyze failed for $task_id"
indexer_version="$(gitnexus --version 2>/dev/null | head -1)"

# --- 5. External custody keyed by commit + manifest (§2.1, §2.2) -----------
custody="$(hydra_gitnexus_dir "$head_sha")"
mkdir -p "$custody"
if [ -d "$worktree/.gitnexus" ]; then
  # Copy the index blob for cache/forensics (custody is the authoritative home).
  cp -R "$worktree/.gitnexus/." "$custody/" 2>/dev/null || true
fi
manifest="$custody/manifest.yaml"
cat >"$manifest" <<YAML
worktree: $(basename "$worktree")
logical_index: $logical
index_name: $index_name
indexed_commit: $head_sha
working_tree_dirty_at_index: false
indexer_version: ${indexer_version:-unknown}
created_at: $(hydra_now)
YAML
# Also record the manifest under the run's authoritative tree for review access.
mkdir -p "$run_dir/authoritative/graph"
cp "$manifest" "$run_dir/authoritative/graph/$task_id.manifest.yaml"

# --- 6. Read-only for the review phase -------------------------------------
[ -d "$worktree/.gitnexus" ] && chmod -R a-w "$worktree/.gitnexus" 2>/dev/null || true

hydra_ledger_append "$run_id" index_built task_id "$task_id" \
  index_name "$index_name" indexed_commit "$head_sha" logical "$logical"
hydra_log "index custody: $custody"
printf '%s\n' "$index_name"
