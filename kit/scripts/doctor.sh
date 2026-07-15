#!/usr/bin/env bash
# hydra-swarm-plugin/kit/scripts/doctor.sh — Wave 3 preflight check.
#
# Deterministic, non-interactive. Prints one line per check:
#   PASS <name>  |  WARN <name>: <detail>  |  FAIL <name>: <detail>
# Exit code 0 iff every FATAL check passed. WARN never affects exit code.
#
# This script is the source of truth; the /hydra-doctor command narrates its
# output in plain language. Keep it silent otherwise — no prose, no color.
#
# --json mode (opt-in): emits a JSON array to stdout, one object per check,
# with category/fix metadata consumed by doctor-fix.sh. Default output is
# unchanged.

set -uo pipefail

json_mode=0
for arg in "$@"; do
  [ "$arg" = "--json" ] && json_mode=1
done

status=0
json_items=()

fail() { status=1; [ "$json_mode" -eq 1 ] || printf 'FAIL %s: %s\n' "$1" "$2"; }
warn() { [ "$json_mode" -eq 1 ] || printf 'WARN %s: %s\n' "$1" "$2"; }
pass() { [ "$json_mode" -eq 1 ] || printf 'PASS %s\n' "$1"; }

json_escape() {
  # Minimal JSON string escaping for the values we control (no newlines/quotes).
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

json_emit() {
  # json_emit <name> <status> <detail> <category> [fix_json] [url] [manual_note]
  [ "$json_mode" -eq 1 ] || return 0
  local name="$1" st="$2" detail="$3" category="$4" fix_json="${5:-}" url="${6:-}" note="${7:-}"
  local obj
  obj="{\"name\":\"$(json_escape "$name")\",\"status\":\"$st\",\"category\":\"$category\""
  if [ -n "$fix_json" ]; then
    obj="$obj,\"fix\":$fix_json"
  fi
  if [ -n "$url" ]; then
    obj="$obj,\"url\":\"$(json_escape "$url")\""
  fi
  if [ -n "$note" ]; then
    obj="$obj,\"note\":\"$(json_escape "$note")\""
  fi
  obj="$obj,\"detail\":\"$(json_escape "$detail")\"}"
  json_items+=("$obj")
}

print_json() {
  [ "$json_mode" -eq 1 ] || return 0
  local i n
  n=${#json_items[@]}
  printf '[\n'
  for i in "${!json_items[@]}"; do
    printf '  %s' "${json_items[$i]}"
    [ "$i" -lt $((n - 1)) ] && printf ','
    printf '\n'
  done
  printf ']\n'
}

# --- 1. Shell: bash >= 4 ------------------------------------------------
bash_major="${BASH_VERSINFO[0]:-0}"
bash_minor="${BASH_VERSINFO[1]:-0}"
if [ "$bash_major" -ge 4 ]; then
  pass "shell (bash ${bash_major}.${bash_minor})"
  json_emit "shell" "pass" "bash ${bash_major}.${bash_minor}" "none"
else
  detail="bash ${bash_major:-0}.${bash_minor:-0} found, need >=4 (macOS ships 3.2 by default — install via Homebrew: brew install bash)"
  fail "shell" "$detail"
  if [ "$(uname -s)" = "Darwin" ]; then
    json_emit "shell" "fail" "$detail" "auto" '{"brew":"brew install bash"}'
  else
    json_emit "shell" "fail" "$detail" "manual" "" "" "Linux system bash is unexpectedly old; upgrade manually"
  fi
fi

# --- 2. Core: jq, node >=22.6, git --------------------------------------
if command -v jq >/dev/null 2>&1; then
  pass "jq ($(jq --version 2>/dev/null))"
  json_emit "jq" "pass" "$(jq --version 2>/dev/null)" "none"
else
  detail="not found — install: brew install jq  /  apt install jq"
  fail "jq" "$detail"
  json_emit "jq" "fail" "$detail" "auto" '{"brew":"brew install jq","apt":"sudo apt-get install -y jq","dnf":"sudo dnf install -y jq"}'
fi

if command -v git >/dev/null 2>&1; then
  pass "git ($(git --version 2>/dev/null))"
  json_emit "git" "pass" "$(git --version 2>/dev/null)" "none"
else
  detail="not found"
  fail "git" "$detail"
  json_emit "git" "fail" "$detail" "auto" '{"brew":"brew install git","apt":"sudo apt-get install -y git","dnf":"sudo dnf install -y git"}'
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
  json_emit "node" "pass" "found $best_node" "none"
else
  detail="no node >=22.6 found on PATH or under ~/.nvm — required for the TypeScript harness"
  fail "node" "$detail"
  json_emit "node" "fail" "$detail" "auto" '{"nvm_bootstrap":"curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash","nvm_install":"nvm install 22 && nvm alias default 22"}'
fi

# --- 3. Vendor CLIs (fatal only in the sense of "unusable", not install-blocking) ---
for vendor_bin in claude codex opencode kimi; do
  if command -v "$vendor_bin" >/dev/null 2>&1; then
    pass "vendor cli: $vendor_bin"
    json_emit "vendor cli: $vendor_bin" "pass" "found" "none"
  else
    case "$vendor_bin" in
      codex)
        detail="not found — this vendor will be unavailable for dispatch (not fatal if you only use the others); install: npm install -g @openai/codex (or: curl -fsSL https://chatgpt.com/codex/install.sh | sh)"
        warn "vendor cli: $vendor_bin" "$detail"
        json_emit "vendor cli: $vendor_bin" "warn" "$detail" "guide" "" "https://github.com/openai/codex"
        ;;
      opencode)
        detail="not found — this vendor will be unavailable for dispatch (not fatal if you only use the others); install: curl -fsSL https://opencode.ai/install | bash (or: npm i -g opencode-ai@latest)"
        warn "vendor cli: $vendor_bin" "$detail"
        json_emit "vendor cli: $vendor_bin" "warn" "$detail" "guide" "" "https://github.com/opencode-ai/opencode"
        ;;
      kimi)
        detail="not found — this vendor will be unavailable for dispatch (not fatal if you only use the others); install: see the official install script in that repo's README -- requires Node >=24.15.0"
        warn "vendor cli: $vendor_bin" "$detail"
        json_emit "vendor cli: $vendor_bin" "warn" "$detail" "guide" "" "https://github.com/MoonshotAI/kimi-code"
        ;;
      claude)
        detail="not found — unexpected: you are running inside Claude Code right now"
        warn "vendor cli: $vendor_bin" "$detail"
        json_emit "vendor cli: $vendor_bin" "warn" "$detail" "manual" "" "" "this is the CLI the harness itself is running inside"
        ;;
    esac
  fi
done
if [ "$vendor_bin" = kimi ] && command -v kimi >/dev/null 2>&1; then
  if [ -d "$HOME/.kimi-code" ]; then
    pass "kimi oauth state ($HOME/.kimi-code present)"
    json_emit "kimi oauth state" "pass" "$HOME/.kimi-code present" "none"
  else
    detail="$HOME/.kimi-code not found — kimi may be unauthenticated"
    warn "kimi oauth state" "$detail"
    json_emit "kimi oauth state" "warn" "$detail" "manual" "" "" "requires an interactive login flow that cannot be scripted"
  fi
fi

# --- 4. Code intelligence (non-fatal) -----------------------------------
if command -v gitnexus >/dev/null 2>&1; then
  pass "gitnexus"
  json_emit "gitnexus" "pass" "found" "none"
else
  detail="not found — code-intelligence risk inputs will be omitted (non-fatal); install: npm install -g gitnexus"
  warn "gitnexus" "$detail"
  json_emit "gitnexus" "warn" "$detail" "guide" "" "https://github.com/abhigyanpatwari/GitNexus"
fi
if command -v graphify >/dev/null 2>&1; then
  pass "graphify"
  json_emit "graphify" "pass" "found" "none"
else
  detail="not found — non-fatal; install: uv tool install graphifyy  (or: pipx install graphifyy)"
  warn "graphify" "$detail"
  json_emit "graphify" "warn" "$detail" "guide" "" "https://github.com/safishamsi/graphify"
fi

# --- 5. Observability (non-fatal) ---------------------------------------
if command -v herdr >/dev/null 2>&1; then
  pass "herdr"
  json_emit "herdr" "pass" "found" "none"
else
  detail="not found — pane hosting degrades to plain background subprocess (non-fatal)"
  warn "herdr" "$detail"
  json_emit "herdr" "warn" "$detail" "manual" "" "" "install herdr outside the auto-fix scope; see the project observability docs"
fi

# --- 6. Sandbox: srt (replaces sandbox-exec/firejail/bwrap) ------------
if command -v srt >/dev/null 2>&1; then
  pass "srt ($(srt --version 2>/dev/null))"
  json_emit "srt" "pass" "found" "none"
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
    json_emit "srt live smoke" "pass" "confinement working" "none"
  else
    detail="srt is installed but did not enforce filesystem confinement as expected — Kimi's write role will refuse to run until this is resolved"
    fail "srt live smoke" "$detail"
    json_emit "srt live smoke" "fail" "$detail" "manual" "" "" "srt binary is present but not enforcing sandbox rules; investigate installation/environment"
  fi
  rm -rf "$smoke_dir"
else
  detail="not found — Kimi's auto-approving write role will refuse to run (fails closed, by design) until srt is installed: npm install -g @anthropic-ai/sandbox-runtime. Other vendors are unaffected."
  warn "srt" "$detail"
  json_emit "srt" "warn" "$detail" "auto" '{"npm":"npm install -g @anthropic-ai/sandbox-runtime"}'
fi

# --- 7. Timeout fallback (informational only, never fatal) -------------
if command -v timeout >/dev/null 2>&1; then
  pass "timeout (GNU coreutils)"
  json_emit "timeout" "pass" "GNU coreutils timeout found" "none"
elif command -v gtimeout >/dev/null 2>&1; then
  pass "gtimeout (Homebrew coreutils)"
  json_emit "timeout" "pass" "Homebrew coreutils gtimeout found" "none"
elif command -v perl >/dev/null 2>&1; then
  detail="neither timeout nor gtimeout found — falling back to a perl-based wrapper (portable, slightly slower)"
  warn "timeout" "$detail"
  json_emit "timeout" "warn" "$detail" "auto" '{"brew":"brew install coreutils","apt":"sudo apt-get install -y coreutils","dnf":"sudo dnf install -y coreutils"}'
else
  detail="no timeout/gtimeout/perl found — dispatch will run without a hard timeout backstop"
  warn "timeout" "$detail"
  json_emit "timeout" "warn" "$detail" "auto" '{"brew":"brew install coreutils","apt":"sudo apt-get install -y coreutils","dnf":"sudo dnf install -y coreutils"}'
fi

print_json
exit "$status"
