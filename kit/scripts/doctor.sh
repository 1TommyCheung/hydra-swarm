#!/usr/bin/env bash
# hydra-swarm-plugin/kit/scripts/doctor.sh — Wave 3 preflight check.
#
# Deterministic, non-interactive. Prints one line per check:
#   PASS <name>  |  WARN <name>: <detail>  |  FAIL <name>: <detail>
# Exit code 0 iff every FATAL check passed. WARN never affects exit code.
#
# This script is the source of truth; the /hydra-doctor command narrates its
# output in plain language. Keep it silent otherwise — no prose, no color.

set -uo pipefail

status=0
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; status=1; }
warn() { printf 'WARN %s: %s\n' "$1" "$2"; }
pass() { printf 'PASS %s\n' "$1"; }

# --- 1. Shell: bash >= 4 ------------------------------------------------
bash_major="${BASH_VERSINFO[0]:-0}"
if [ "$bash_major" -ge 4 ]; then
  pass "shell (bash ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]})"
else
  fail "shell" "bash ${BASH_VERSINFO[0]:-0}.${BASH_VERSINFO[1]:-0} found, need >=4 (macOS ships 3.2 by default — install via Homebrew: brew install bash)"
fi

# --- 2. Core: jq, node >=22.6, git --------------------------------------
if command -v jq >/dev/null 2>&1; then
  pass "jq ($(jq --version 2>/dev/null))"
else
  fail "jq" "not found — install: brew install jq  /  apt install jq"
fi

if command -v git >/dev/null 2>&1; then
  pass "git ($(git --version 2>/dev/null))"
else
  fail "git" "not found"
fi

node_ok=0
best_node=""
for candidate in "$(command -v node 2>/dev/null)" "$HOME"/.nvm/versions/node/*/bin/node \
  /opt/homebrew/bin/node /opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node; do
  [ -x "$candidate" ] || continue
  ver="$("$candidate" --version 2>/dev/null | tr -d 'v')"
  major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
  if [ -n "$major" ] && [ "$major" -gt 22 ] 2>/dev/null; then node_ok=1; best_node="$candidate ($ver)"; break; fi
  if [ "$major" = 22 ] 2>/dev/null && [ -n "$minor" ] && [ "$minor" -ge 6 ] 2>/dev/null; then
    node_ok=1; best_node="$candidate ($ver)"; break
  fi
done
if [ "$node_ok" = 1 ]; then
  pass "node (>=22.6 required for --experimental-strip-types; found $best_node)"
else
  fail "node" "no node >=22.6 found on PATH or under ~/.nvm — required for the TypeScript harness"
fi

# --- 3. Vendor CLIs (fatal only in the sense of "unusable", not install-blocking) ---
for vendor_bin in claude codex opencode kimi; do
  if command -v "$vendor_bin" >/dev/null 2>&1; then
    pass "vendor cli: $vendor_bin"
  else
    warn "vendor cli: $vendor_bin" "not found — this vendor will be unavailable for dispatch (not fatal if you only use the others)"
  fi
done
if [ "$vendor_bin" = kimi ] && command -v kimi >/dev/null 2>&1; then
  if [ -d "$HOME/.kimi-code" ]; then
    pass "kimi oauth state ($HOME/.kimi-code present)"
  else
    warn "kimi oauth state" "$HOME/.kimi-code not found — kimi may be unauthenticated"
  fi
fi

# --- 4. Code intelligence (non-fatal) -----------------------------------
if command -v gitnexus >/dev/null 2>&1; then pass "gitnexus"; else warn "gitnexus" "not found — code-intelligence risk inputs will be omitted (non-fatal)"; fi
if command -v graphify >/dev/null 2>&1; then pass "graphify"; else warn "graphify" "not found — non-fatal"; fi

# --- 5. Observability (non-fatal) ---------------------------------------
if command -v herdr >/dev/null 2>&1; then
  pass "herdr"
else
  warn "herdr" "not found — pane hosting degrades to plain background subprocess (non-fatal)"
fi

# --- 6. Sandbox: srt (replaces sandbox-exec/firejail/bwrap) ------------
if command -v srt >/dev/null 2>&1; then
  pass "srt ($(srt --version 2>/dev/null))"
  # Live smoke: write inside an allowed dir succeeds, write outside is blocked.
  smoke_dir="$(mktemp -d)"
  allowed="$smoke_dir/allowed"; mkdir -p "$allowed"
  settings="$smoke_dir/settings.json"
  cat >"$settings" <<JSON
{"network":{"allowedDomains":["localhost"],"deniedDomains":[]},"filesystem":{"allowWrite":["$allowed"],"denyWrite":[],"denyRead":[]}}
JSON
  if srt -s "$settings" -c "echo ok > '$allowed/ok.txt'" >/dev/null 2>&1 \
    && [ -f "$allowed/ok.txt" ] \
    && ! srt -s "$settings" -c "echo blocked > '$smoke_dir/outside.txt'" >/dev/null 2>&1 \
    && [ ! -f "$smoke_dir/outside.txt" ]; then
    pass "srt live smoke (write-inside succeeds, write-outside blocked)"
  else
    fail "srt live smoke" "srt is installed but did not enforce filesystem confinement as expected — Kimi's write role will refuse to run until this is resolved"
  fi
  rm -rf "$smoke_dir"
else
  warn "srt" "not found — Kimi's auto-approving write role will refuse to run (fails closed, by design) until srt is installed: npm install -g @anthropic-ai/sandbox-runtime. Other vendors are unaffected."
fi

# --- 7. Timeout fallback (informational only, never fatal) -------------
if command -v timeout >/dev/null 2>&1; then
  pass "timeout (GNU coreutils)"
elif command -v gtimeout >/dev/null 2>&1; then
  pass "gtimeout (Homebrew coreutils)"
elif command -v perl >/dev/null 2>&1; then
  warn "timeout" "neither timeout nor gtimeout found — falling back to a perl-based wrapper (portable, slightly slower)"
else
  warn "timeout" "no timeout/gtimeout/perl found — dispatch will run without a hard timeout backstop"
fi

exit "$status"
