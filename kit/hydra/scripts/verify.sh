#!/usr/bin/env bash
# hydra/scripts/verify.sh — sandboxed verification runner (authoritative gate).
#
# trust-and-permissions.md §6: candidate branches may have altered test
# runners, build scripts, or dependencies, so verification runs UNTRUSTED
# CANDIDATE CODE. We therefore:
#   - take the command list ONLY from the tracked policy passed in (never from
#     worker output) — the command-provenance rule;
#   - scrub credentials/secrets from the environment;
#   - run inside the candidate worktree with a wall-clock timeout;
#   - report per-command observed outcomes as JSON.
#
# Usage:
#   verify.sh <worktree> <verification_policy.yaml> [out.json]
#
# Prints a JSON array of {command,status} to stdout (and to out.json if given).
# Exit 0  -> every mandatory command passed.
# Exit 4  -> at least one command failed (status "failed").
# Exit 2  -> usage / policy error.
#
# NOTE (Wave 0 honesty): true OS network isolation is a hardening milestone.
# Here we strip credential-bearing env vars and rely on the structural fact
# that no remote/push credentials exist in a worker environment. The sandbox
# boundary is documented, not yet kernel-enforced.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"

worktree="${1:?usage: verify.sh <worktree> <policy.yaml> [out.json]}"
policy="${2:?usage: verify.sh <worktree> <policy.yaml> [out.json]}"
out="${3:-}"

[ -d "$worktree" ] || hydra_die "worktree not found: $worktree"
[ -f "$policy" ]   || hydra_die "policy not found: $policy"

# Mandatory commands come from the tracked policy ONLY.
mapfile -t commands < <(hydra_yaml_list "$policy" '  commands' )
if [ "${#commands[@]}" -eq 0 ]; then
  # Support both `commands:` at column 0 and nested under verification_policy.
  mapfile -t commands < <(hydra_yaml_list "$policy" 'commands')
fi
[ "${#commands[@]}" -gt 0 ] || hydra_die "no verification commands in policy: $policy"

timeout_min="$(hydra_yaml_scalar "$policy" '  timeout_minutes')"
[ -n "$timeout_min" ] || timeout_min="$(hydra_yaml_scalar "$policy" 'timeout_minutes')"
[ -n "$timeout_min" ] || timeout_min=15
timeout_sec=$(( timeout_min * 60 ))

results_json='[]'
overall=0

# Minimal, credential-scrubbed environment. Keep only what a build needs.
run_sandboxed() {
  local cmd="$1"
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    LANG="${LANG:-C}" \
    HYDRA_SANDBOX=1 \
    NO_NETWORK=1 \
    bash -c "cd \"$worktree\" && $cmd"
}

for cmd in "${commands[@]}"; do
  [ -n "$cmd" ] || continue
  hydra_log "verify: running: $cmd"
  status="passed"
  if ! hydra_timeout "$timeout_sec" bash -c '
        cmd="$1"; worktree="$2"
        env -i PATH="'"$PATH"'" HOME="'"$HOME"'" LANG="${LANG:-C}" \
            HYDRA_SANDBOX=1 NO_NETWORK=1 \
            bash -c "cd \"$worktree\" && $cmd"
      ' _ "$cmd" "$worktree" >/dev/null 2>&1; then
    rc=$?
    if [ "$rc" -eq 124 ]; then status="timed_out"; else status="failed"; fi
    overall=4
  fi
  results_json="$(jq -c --arg c "$cmd" --arg s "$status" '. + [{command:$c, status:$s}]' <<<"$results_json")"
done

printf '%s\n' "$results_json"
[ -n "$out" ] && printf '%s\n' "$results_json" >"$out"
exit "$overall"
