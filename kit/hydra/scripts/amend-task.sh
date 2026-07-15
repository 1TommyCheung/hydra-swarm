#!/usr/bin/env bash
# hydra/scripts/amend-task.sh — versioned spec amendment (resume protocol).
#
# architecture.md §4.6 + task-result-review-contracts.md §1.1 + vendor-adapters
# §1. Mid-turn instruction injection is prohibited; course-correction happens at
# turn boundaries via a version-bumped spec amendment recorded as a ledger event,
# then re-delivery via resume() (or cold-restart if the vendor can't resume —
# cheap, because work is committed at checkpoints).
#
# The lead FIRST edits the instantiated task spec's substantive fields (objective,
# writable_paths, ...). THEN calls this to bump the version, stamp amendment
# metadata, record the event, and re-dispatch. Gates evaluate only the latest
# version; results claiming an older version are stale and rejected at promotion.
#
# Usage:
#   amend-task.sh <run_id> <task_id> "<amendment_reason>" [resume|restart]
#     delivery defaults to restart (universally safe); resume uses the captured
#     session id where the adapter supports it.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec "$HYDRA_BIN_PATH" amend-task "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" amend-task "$@"
fi

run_id="${1:?usage: amend-task.sh <run_id> <task_id> <reason> [resume|restart]}"
task_id="${2:?usage: amend-task.sh <run_id> <task_id> <reason> [resume|restart]}"
reason="${3:?amendment_reason required}"
delivery="${4:-restart}"

run_dir="$(hydra_run_dir "$run_id")"
task_spec="$run_dir/tasks/$task_id.yaml"
[ -f "$task_spec" ] || hydra_die "task spec not found: $task_spec"

from_v="$(hydra_yaml_scalar "$task_spec" 'spec_version')"
[ -n "$from_v" ] || hydra_die "task spec has no spec_version"
to_v=$(( from_v + 1 ))

# Rewrite version + stamp amendment metadata (idempotent on the four keys).
#
# amendment_reason/delivered_via may be multi-line free text; a plain scalar
# cannot span lines, so a multi-line value is emitted as a literal block
# scalar (`key: |` + 2-space-indented lines) instead, and any PRIOR block
# scalar's continuation lines are skipped (not just its header) when dropping
# stale amendment metadata from a spec that was already amended once before.
#
# Preflight the recorded worktree BEFORE mutating the authoritative spec --
# checking only after the rewrite would leave a broken half-amended state on
# a missing worktree: spec_version bumped, amendment_reason set, but no
# refreshed worktree copy, no ledger event, and no redispatch.
worktree="$(hydra_yaml_scalar "$task_spec" 'worktree')"
if [ -n "$worktree" ]; then
  [ -d "$worktree" ] || hydra_die "amend-task: worktree not found, cannot refresh its task spec copy: $worktree"
fi

tmp="$(mktemp)"
awk -v to="$to_v" -v from="$from_v" -v reason="$reason" -v delivery="$delivery" '
  # An implicit (bare |) indentation indicator makes a real YAML parser
  # auto-detect the base indent from the first content line -- but this
  # writer always adds exactly 2 spaces regardless of that first line own
  # leading whitespace. If the value first line is more indented than a
  # later "root level" line within the same value, auto-detection picks up
  # the larger indent and the less-indented line becomes invalid YAML.
  # Declaring |2 explicitly removes the ambiguity: every emitted line is
  # unambiguously 2 spaces deep.
  function print_kv(key, value,    n, i, parts) {
    if (index(value, "\n") == 0) {
      print key ": " value
      return
    }
    print key ": |2"
    n = split(value, parts, "\n")
    for (i = 1; i <= n; i++) {
      if (parts[i] == "") print ""
      else print "  " parts[i]
    }
  }
  {
    if (skipping) {
      if ($0 == "" || $0 ~ /^[[:space:]]/) next
      skipping = 0
    }
    if ($0 ~ /^spec_version:/) { print "spec_version: " to; next }
    if ($0 ~ /^(supersedes|amendment_reason|delivered_via):/) {
      header = $0
      sub(/^[a-zA-Z_]+:[[:space:]]*/, "", header)
      if (header == "" || header ~ /^[|>]([1-9][+-]?|[+-][1-9]?)?$/) skipping = 1
      next
    }
    print
  }
  END {
    print "supersedes: " from
    print_kv("amendment_reason", reason)
    print_kv("delivered_via", delivery)
  }
' "$task_spec" >"$tmp"
mv "$tmp" "$task_spec"

# The worktree's own .hydra-task.yaml (written once by create-worktree.sh,
# read-only, and the ONLY task spec the sandboxed vendor CLI ever sees -- it
# has no access to the authoritative state root) must be refreshed to match,
# or a resumed/restarted worker silently keeps reading the PRE-amendment
# spec: no error, just the old objective and no amendment_reason at all.
#
# Written to a TEMP file, chmod'd read-only, THEN renamed over the
# destination -- the actual served .hydra-task.yaml is therefore either the
# old, complete, correctly-permissioned file or the new one, atomically,
# never a partially-written or briefly-writable version of itself (mv only
# runs after chmod, and rename is atomic). The temp file itself is
# necessarily writable while `cp` populates it (mktemp cannot pre-create a
# 0444 file you can then write into); the trap below removes it if `cp` or
# `chmod` fails under `set -e`, instead of leaving a stray writable file
# behind in the worktree.
if [ -n "$worktree" ]; then
  worktree_spec="$worktree/.hydra-task.yaml"
  wt_tmp="$(mktemp "$worktree/.hydra-task-XXXXXX")"
  trap 'rm -f "$wt_tmp"' EXIT
  cp "$task_spec" "$wt_tmp"
  chmod 444 "$wt_tmp"
  mv "$wt_tmp" "$worktree_spec"
  trap - EXIT
fi

hydra_ledger_append "$run_id" task_spec_amended task_id "$task_id" \
  from "v$from_v" to "v$to_v" delivery "$delivery" reason "$reason"
hydra_log "amended $task_id v$from_v -> v$to_v ($delivery): $reason"

# Re-deliver. dispatch.sh derives a new agent_run_id from the bumped version, so
# the redispatch is distinct in the ledger and inbox.
HYDRA_DELIVERY="$delivery" "$SELF_DIR/dispatch.sh" "$run_id" "$task_id"
