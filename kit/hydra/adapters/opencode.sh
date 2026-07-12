#!/usr/bin/env bash
# hydra/adapters/opencode.sh — OpenCode / GLM 5.2 adapter (Wave 1).
#
# vendor-adapters.md §4: OpenCode roles in Wave 1 are EXPLORATION fan-out and
# LONG textual-diff / whole-repo review — both READ-ONLY. GLM's documented
# weaknesses (from-scratch generation, marathon tasks) keep it out of write
# roles; it takes no implementer role in Wave 1. The read-only guarantee is
# enforced by the `hydra-reviewer` agent profile in opencode.json (edit/bash
# deny) plus the fact that its output is advisory and never writes authoritative
# state (promotion/record-review is the boundary).
#
# Verbs:
#   explore <cwd> <prompt> <out_prefix> <agent_run_id>
#   review  <cwd> <prompt> <out_prefix> <agent_run_id>
# Both write:
#   <out_prefix>.txt          final assistant message (findings / verdict)
#   <out_prefix>.session.json { session_id, vendor, model, tokens, cost }
#   <out_prefix>.events.jsonl raw event stream
#
# Model is spec-defaulted to GLM 5.2 but overridable (HYDRA_OPENCODE_MODEL) —
# the provider prefix differs per account (e.g. zai-coding-plan/glm-5.2).

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib.sh
source "$SELF_DIR/../scripts/lib.sh"

command -v opencode >/dev/null 2>&1 || hydra_die "opencode CLI not found (Wave 1 dependency)"

verb="${1:?usage: opencode.sh explore|review <cwd> <prompt> <out_prefix> <agent_run_id>}"
case "$verb" in explore|review) ;; *) hydra_die "opencode.sh: unknown verb '$verb'";; esac
shift
cwd="${1:?cwd required}"; prompt="${2:?prompt required}"; out_prefix="${3:?out_prefix required}"
agent_run_id="${4:?agent_run_id required}"

model="${HYDRA_OPENCODE_MODEL:-zhipu/glm-5.2}"
events="$out_prefix.events.jsonl"
mkdir -p "$(dirname "$out_prefix")"

# Read-only run under the hydra-reviewer agent profile.
opencode run --model "$model" --agent hydra-reviewer --format json --dir "$cwd" "$prompt" \
  </dev/null >"$events" 2>"$out_prefix.stderr" || true

# Final assistant text (last text event).
jq -rs 'map(select(.type=="text" or (.part.type=="text")) | (.text // .part.text // empty)) | last // empty' \
  "$events" 2>/dev/null >"$out_prefix.txt" || true

# Session id + usage. Top-level .type is "step_finish"; tokens/cost live under
# .part on those events. .sessionID is present on every event.
session_id="$(jq -rs 'map(.sessionID // empty) | map(select(. != "")) | last // empty' "$events" 2>/dev/null || true)"
usage="$(jq -cs '
  [ .[] | select(.type=="step_finish") | .part ] as $sf
  | { tokens: ([ $sf[].tokens ] | map(select(. != null)) | last // {}),
      cost:   ([ $sf[].cost ]   | map(select(. != null)) | add // 0) }
' "$events" 2>/dev/null || true)"
[ -n "$usage" ] || usage='{"tokens":{},"cost":0}'

jq -n --arg sid "$session_id" --arg aid "$agent_run_id" --arg model "$model" \
  --argjson usage "$usage" \
  '{agent_run_id:$aid, vendor:"opencode", model:$model, session_id:$sid,
    tokens:($usage.tokens // {}), cost:($usage.cost // 0)}' \
  >"$out_prefix.session.json"

hydra_log "opencode $verb done ($model) session=$session_id"
printf '%s\n' "$out_prefix.txt"
