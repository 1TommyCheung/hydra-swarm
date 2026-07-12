#!/usr/bin/env bash
# hydra/adapters/kimi.sh — Kimi K2.7 Code adapter (Wave 2).
#
# vendor-adapters.md §4: Kimi is the ONLY natively-multimodal coder in the pool
# (screenshots, mockups, video repro) — its headline role is `visual_debugging`,
# plus mobile/UI implementation and cheap contained loops. Print mode
# AUTO-APPROVES tools (`-y`, no allowlist), so **Kimi never takes a write role
# outside a full filesystem/network sandbox**. On macOS we confine it with
# sandbox-exec: file writes are denied everywhere except the worktree (the
# strongest enforceable guarantee, trust §4.1), backed by the authoritative
# post-hoc ownership audit (layer 4).
#
# HONEST CAVEAT (Wave 2): Kimi's own API needs network, and sandbox-exec cannot
# cleanly separate "model shell command network" from "CLI API network", so
# network is allowed. Filesystem confinement + the diff audit are the boundary;
# full network isolation is a hardening item. Refuses the write role if no OS
# sandbox is available — never runs an auto-approving writer unconfined.
#
# Verbs:
#   start  <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior]   (write, sandboxed)
#   visual <cwd> <prompt> <out_prefix> <agent_run_id> [image_path]            (read-only multimodal)

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib.sh
source "$SELF_DIR/../scripts/lib.sh"

command -v kimi >/dev/null 2>&1 || hydra_die "kimi CLI not found (Wave 2 dependency)"

verb="${1:?usage: kimi.sh start|visual ...}"
shift

# Build an SBPL profile that allows all-but-file-writes, then permits writes only
# under the given roots. Prints the profile path.
make_sandbox_profile() {
  # BSD/macOS mktemp requires the X's at the END of the template. A suffix after
  # them (e.g. ...-XXXXXX.sb) makes mktemp create a LITERAL file of that name —
  # which then collides forever ("File exists"), yielding an empty path and a
  # `sandbox-exec -f ""` invocation. Also strip TMPDIR's trailing slash.
  local tmpdir="${TMPDIR:-/tmp}"; tmpdir="${tmpdir%/}"
  local prof; prof="$(mktemp "$tmpdir/hydra-kimi-sb-XXXXXX")" || return 1
  [ -n "$prof" ] || return 1
  {
    echo '(version 1)'
    echo '(allow default)'
    echo '(deny file-write*)'
    # Device nodes are NOT the threat model — the lane is. A blanket
    # file-write deny also blocks /dev/null, which bash and git open for
    # read/write on almost every command ("fatal: could not open '/dev/null'"),
    # silently crippling the worker inside its own sandbox.
    echo '(allow file-write* (subpath "/dev"))'
    # The herdr status hook connects to herdr's unix socket to report
    # working/idle/blocked. Without this the pane shows a stale "idle".
    if [ -n "${HERDR_SOCKET_DIR:-}" ]; then
      printf '(allow file-write* (subpath "%s"))\n' "$HERDR_SOCKET_DIR"
    elif [ -d "$HOME/.config/herdr" ]; then
      printf '(allow file-write* (subpath "%s/.config/herdr"))\n' "$HOME"
    fi
    for root in "$@"; do
      [ -n "$root" ] || continue
      printf '(allow file-write* (subpath "%s"))\n' "$root"
    done
  } >"$prof"
  printf '%s' "$prof"
}

case "$verb" in
  visual)
    # Read-only multimodal analysis. No sandbox needed (no writes requested).
    cwd="${1:?cwd required}"; prompt="${2:?prompt required}"; out_prefix="${3:?out_prefix required}"
    agent_run_id="${4:?agent_run_id required}"; image="${5:-}"
    mkdir -p "$(dirname "$out_prefix")"
    # Attach an image by referencing its path in the prompt (Kimi resolves local
    # paths under --add-dir); video/screenshots supported the same way.
    full_prompt="$prompt"
    [ -n "$image" ] && full_prompt="$prompt

Image to analyze: $image"
    ( cd "$cwd" && kimi -p "$full_prompt" --output-format stream-json --add-dir "$cwd" ${image:+--add-dir "$(dirname "$image")"} ) \
      </dev/null >"$out_prefix.jsonl" 2>"$out_prefix.stderr" || true
    # Kimi stream-json: assistant text in .content; session id in a meta event.
    jq -rs 'map(select(.role=="assistant") | .content) | last // empty' "$out_prefix.jsonl" 2>/dev/null >"$out_prefix.txt" || true
    session_id="$(jq -rs 'map(.session_id // empty) | map(select(. != "")) | last // empty' "$out_prefix.jsonl" 2>/dev/null || true)"
    jq -n --arg sid "$session_id" --arg aid "$agent_run_id" \
      '{agent_run_id:$aid, vendor:"kimi", role:"visual_debugging", session_id:$sid}' >"$out_prefix.session.json"
    hydra_log "kimi visual_debugging done (session=$session_id)"
    printf '%s\n' "$out_prefix.txt"
    ;;

  start)
    command -v sandbox-exec >/dev/null 2>&1 \
      || hydra_die "no OS sandbox (sandbox-exec) — refusing Kimi write role (auto-approves tools)"
    task_spec="${1:?}"; worktree="${2:?}"; inbox="${3:?}"; sessions="${4:?}"; agent_run_id="${5:?}"
    result_path="$inbox/result.json"; worker_result="$worktree/.hydra-result.json"
    mkdir -p "$inbox" "$sessions"; rm -f "$worker_result"
    prompt="$("$SELF_DIR/build-worker-prompt.sh" "$task_spec")"

    wt_abs="$(cd "$worktree" && pwd -P)"
    # A linked worktree's git metadata lives in the git-common-dir OUTSIDE the
    # worktree; Kimi must write there to commit. Resolve to a physical path so
    # sandbox-exec subpath matching works (/var -> /private/var).
    git_common="$(cd "$worktree" && cd "$(git rev-parse --path-format=absolute --git-common-dir)" && pwd -P)"
    prof="$(make_sandbox_profile "$wt_abs" "$git_common" "${TMPDIR:-/tmp}" "/private/tmp" "$HOME/.kimi-code")" || prof=""
    # HARD GUARD: never invoke an auto-approving agent without a real profile.
    # `sandbox-exec -f ""` must never happen — refuse the write role instead.
    [ -n "$prof" ] && [ -s "$prof" ] \
      || hydra_die "failed to build sandbox profile — refusing to run Kimi (auto-approves tools) unsandboxed"
    hydra_log "kimi write role under sandbox-exec (writes confined to worktree + git-common-dir)"

    # NOTE: `kimi -p` (print mode) ALREADY auto-approves tools — that is exactly
    # why the OS sandbox is mandatory. `-y` is both redundant and rejected
    # ("Cannot combine --prompt with --yolo"), so it is intentionally absent.
    ( cd "$worktree" && sandbox-exec -f "$prof" \
        kimi -p "$prompt" --output-format stream-json --add-dir "$worktree" ) \
      </dev/null >"$sessions/$agent_run_id.cli.jsonl" 2>"$sessions/$agent_run_id.stderr" || true
    rm -f "$prof"

    session_id="$(jq -rs 'map(.session_id // empty) | map(select(. != "")) | last // empty' "$sessions/$agent_run_id.cli.jsonl" 2>/dev/null || true)"
    jq -n --arg sid "$session_id" --arg aid "$agent_run_id" --arg vendor kimi \
      '{agent_run_id:$aid, vendor:$vendor, session_id:$sid}' >"$sessions/$agent_run_id.json"

    if [ -f "$worker_result" ] && jq -e . "$worker_result" >/dev/null 2>&1; then
      jq --arg sid "$session_id" '.vendor = "kimi" | .session_id = (.session_id // $sid)' \
        "$worker_result" >"$result_path"
    elif hydra_derive_drop_from_git "$task_spec" "$worktree" kimi "$session_id" "$result_path"; then
      hydra_log "kimi committed without a self-report; drop derived from git evidence"
    else
      jq -n --arg t "$(hydra_yaml_scalar "$task_spec" 'task_id')" \
            --arg r "$(hydra_yaml_scalar "$task_spec" 'run_id')" \
            --argjson sv "$(hydra_yaml_scalar "$task_spec" 'spec_version')" \
            --arg b "$(hydra_yaml_scalar "$task_spec" 'branch')" \
            --arg bc "$(hydra_yaml_scalar "$task_spec" 'base_commit')" --arg sid "$session_id" '{
          task_id:$t, run_id:$r, spec_version:$sv, vendor:"kimi", session_id:$sid,
          status:"failed", branch:$b, base_commit:$bc, head_commit:$bc,
          summary:"worker produced no result drop and no commit", files_changed:[],
          verification_claims:[], risks:["adapter synthesized a failed drop"],
          unresolved_questions:[], suggested_additional_checks:[]
        }' >"$result_path"
    fi
    printf '%s\n' "$agent_run_id"
    ;;
  *) hydra_die "kimi.sh: unknown verb '$verb'";;
esac
