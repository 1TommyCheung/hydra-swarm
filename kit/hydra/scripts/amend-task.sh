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
HYDRA_NODE="$(hydra_resolve_node)"
exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/amend-task.ts" "$@"
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
tmp="$(mktemp)"
awk -v to="$to_v" -v from="$from_v" -v reason="$reason" -v delivery="$delivery" '
  function print_kv(key, value,    n, i, parts) {
    if (index(value, "\n") == 0) {
      print key ": " value
      return
    }
    print key ": |"
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
      if (header == "" || header == "|" || header == ">") skipping = 1
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

hydra_ledger_append "$run_id" task_spec_amended task_id "$task_id" \
  from "v$from_v" to "v$to_v" delivery "$delivery" reason "$reason"
hydra_log "amended $task_id v$from_v -> v$to_v ($delivery): $reason"

# Re-deliver. dispatch.sh derives a new agent_run_id from the bumped version, so
# the redispatch is distinct in the ledger and inbox.
HYDRA_DELIVERY="$delivery" "$SELF_DIR/dispatch.sh" "$run_id" "$task_id"
