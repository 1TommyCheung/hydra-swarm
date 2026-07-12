#!/usr/bin/env bash
# hydra/scripts/run-init.sh — create the external state layout for a run.
#
# Domain 2 bootstrap (state-and-worktrees.md §1). Creates the run directory
# tree under the external state root and emits the `run_started` ledger event.
# The lead calls this; it is the only way a run's authoritative/ tree comes
# into existence.
#
# Usage: run-init.sh <run_id> [base_commit]
#   base_commit defaults to current HEAD of the main checkout.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

run_id="${1:?usage: run-init.sh <run_id> [base_commit]}"
base_commit="${2:-$(git -C "$(hydra_repo_root)" rev-parse HEAD)}"

run_dir="$(hydra_run_dir "$run_id")"
[ -e "$run_dir" ] && hydra_die "run already exists: $run_dir"

mkdir -p \
  "$run_dir/tasks" \
  "$run_dir/inbox" \
  "$run_dir/authoritative/ledger" \
  "$run_dir/authoritative/results" \
  "$run_dir/authoritative/reviews" \
  "$run_dir/authoritative/verification" \
  "$run_dir/sessions"

# Lock down the authoritative tree so accidental non-harness writes are at
# least inconvenient (defense in depth; the real boundary is that workers
# cannot reach this path at all).
chmod 0755 "$run_dir/authoritative"

cat >"$run_dir/run.yaml" <<YAML
run_id: "$run_id"
base_commit: $base_commit
repo_id: $(hydra_repo_id)
created: $(hydra_now)
state: planning
tasks: []
YAML

hydra_ledger_append "$run_id" run_started base_commit "$base_commit"
hydra_log "run $run_id initialized at $run_dir (base $base_commit)"
printf '%s\n' "$run_dir"
