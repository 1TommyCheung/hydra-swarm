#!/usr/bin/env bash
# hydra-swarm-plugin/kit/scripts/doctor-fix.sh — single-fix executor.
#
# This is the ONLY script allowed to execute a remediation command for a
# doctor.sh failure. It is meant to be driven by /hydra-doctor's opt-in
# remediation flow; do not run it standalone without understanding what it will
# execute.
#
# Usage: bash kit/scripts/doctor-fix.sh <check-name>

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$SELF_DIR/doctor.sh"

[ "$#" -ge 1 ] || { echo "usage: $0 <check-name>" >&2; exit 2; }
check_name="$1"

die() { echo "doctor-fix: error: $*" >&2; exit 1; }

# Extract a JSON object line for the named check from doctor.sh --json output.
# We rely on the compact one-object-per-line format emitted by doctor.sh.
fetch_check_obj() {
  "$DOCTOR" --json | while IFS= read -r line; do
    case "$line" in
      *"\"name\":\"$check_name\""*) printf '%s\n' "$line"; break ;;
    esac
  done
}

# Naive JSON string extractor for the constrained values we emit (no embedded
# unescaped quotes/newlines). Returns the raw value on stdout.
json_get_str() {
  local obj="$1" key="$2"
  local prefix="\"$key\":\""
  local rest="${obj#*"$prefix"}"
  [ "$rest" != "$obj" ] || return 1
  printf '%s' "${rest%%\"*}"
}

# Extract a nested JSON object value for a key.
json_get_obj() {
  local obj="$1" key="$2"
  local prefix="\"$key\":{"
  local rest="${obj#*"$prefix"}"
  [ "$rest" != "$obj" ] || return 1
  # Find matching close brace by counting opens/closes.
  local depth=1 i c out=""
  for ((i=1; i<=${#rest}; i++)); do
    c="${rest:$i-1:1}"
    out="$out$c"
    case "$c" in
      "{") ((depth++)) ;;
      "}") ((depth--)); [ "$depth" -eq 0 ] && { printf '{%s' "$out"; return 0; } ;;
    esac
  done
  return 1
}

# Get a value from a fix object (nested keys are string values).
fix_get_str() {
  local fix="$1" key="$2"
  json_get_str "$fix" "$key"
}

obj="$(fetch_check_obj)"
[ -n "$obj" ] || die "check '$check_name' not found in doctor.sh --json output"

# Trim leading whitespace/commas/brackets.
obj="${obj#"${obj%%[![:space:],[]*}"}"

status="$(json_get_str "$obj" status)"
category="$(json_get_str "$obj" category)"

[ "$category" = "auto" ] || die "this check is not auto-fixable; category is $category"

# Dependency ordering safety: srt install requires working npm/node.
if [ "$check_name" = "srt" ]; then
  node_obj=""
  while IFS= read -r line; do
    case "$line" in *'"name":"node"'*) node_obj="$line"; break ;; esac
  done < <("$DOCTOR" --json)
  node_status=""
  if [ -n "$node_obj" ]; then
    node_status="$(json_get_str "$node_obj" status 2>/dev/null || true)"
  fi
  [ "$node_status" = "pass" ] || die "refusing srt fix because the node check is not passing (dependency ordering safety)"
fi

# Detect package manager / platform.
fix_obj=""
if fix_obj="$(json_get_obj "$obj" fix)"; then
  :
else
  die "no fix object found for check '$check_name'"
fi

select_fix_command() {
  local fix="$1"
  if command -v brew >/dev/null 2>&1; then
    if fix_get_str "$fix" brew >/dev/null 2>&1; then
      fix_get_str "$fix" brew
      return 0
    fi
    die "no Homebrew fix available for '$check_name'"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    if fix_get_str "$fix" apt >/dev/null 2>&1; then
      fix_get_str "$fix" apt
      return 0
    fi
    die "no apt-get fix available for '$check_name'"
  fi
  if command -v dnf >/dev/null 2>&1; then
    if fix_get_str "$fix" dnf >/dev/null 2>&1; then
      fix_get_str "$fix" dnf
      return 0
    fi
    die "no dnf fix available for '$check_name'"
  fi
  die "no supported package manager found (brew, apt-get, or dnf)"
}

build_command() {
  local fix="$1"
  case "$check_name" in
    node)
      local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
      local bootstrap install
      if [ -s "$nvm_dir/nvm.sh" ]; then
        install="$(fix_get_str "$fix" nvm_install)"
        printf 'export NVM_DIR=%q && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && %s' "$nvm_dir" "$install"
      else
        bootstrap="$(fix_get_str "$fix" nvm_bootstrap)"
        install="$(fix_get_str "$fix" nvm_install)"
        printf '%s && export NVM_DIR=%q && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && %s' "$bootstrap" "$nvm_dir" "$install"
      fi
      ;;
    srt)
      fix_get_str "$fix" npm
      ;;
    *)
      select_fix_command "$fix"
      ;;
  esac
}

cmd="$(build_command "$fix_obj")"

echo "doctor-fix: applying fix for '$check_name'"
echo "doctor-fix: $cmd"
eval "$cmd"

# Re-verify the single check (use the JSON parser, not a regex, so check names
# containing regex metachacters cannot silently mis-match).
rv_obj="$(fetch_check_obj)"
if [ -n "$rv_obj" ] && [ "$(json_get_str "$rv_obj" status)" = "pass" ]; then
  echo "doctor-fix: '$check_name' now passes"
  exit 0
else
  echo "doctor-fix: '$check_name' still does not pass after fix" >&2
  exit 1
fi
