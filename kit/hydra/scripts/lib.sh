# shellcheck shell=bash
# hydra/scripts/lib.sh — shared launcher helpers (sourced by every wrapper).
#
# The Bash implementation lane is RETIRED (docs/bash-lane-retirement-plan.md).
# The 28 wrappers in this directory are thin launchers that only route their
# subcommand to the TypeScript harness or a pinned compiled binary. This file
# retains exactly what that routing needs:
#   - logging helpers (hydra_die / hydra_warn / hydra_log)
#   - strict HYDRA_HARNESS validation + dispatch (hydra_launch)
#   - Node.js >=22.6 resolution for the default ts lane (hydra_resolve_node)
#   - hardened compiled-binary resolution for the bin lane (hydra_resolve_bin)
#
# This file defines functions only. It performs no work when sourced.

hydra_die() { printf 'hydra: error: %s\n' "$*" >&2; exit 1; }
hydra_warn() { printf 'hydra: warn: %s\n' "$*" >&2; }
hydra_log() { printf 'hydra: %s\n' "$*" >&2; }

# Resolve a Node.js runtime new enough to execute TypeScript via
# --experimental-strip-types. The result is cached only in this shell process;
# every entry-point invocation performs a fresh resolution.
_hydra_node_version() {
  "$1" -p 'process.versions.node' 2>/dev/null
}

_hydra_node_meets_requirement() {
  local version major minor patch
  version="$(_hydra_node_version "$1")" || return 1
  version="${version#v}"
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( 10#$major > 22 || (10#$major == 22 && 10#$minor >= 6) ))
}

_hydra_node_version_is_greater() {
  local candidate="${1#v}" current="${2#v}"
  local candidate_major candidate_minor candidate_patch
  local current_major current_minor current_patch

  [ -z "$current" ] && return 0
  candidate="${candidate%%-*}"
  current="${current%%-*}"
  IFS=. read -r candidate_major candidate_minor candidate_patch <<<"$candidate"
  IFS=. read -r current_major current_minor current_patch <<<"$current"
  [[ "$candidate_major" =~ ^[0-9]+$ && "$candidate_minor" =~ ^[0-9]+$ && "$candidate_patch" =~ ^[0-9]+$ ]] || return 1
  [[ "$current_major" =~ ^[0-9]+$ && "$current_minor" =~ ^[0-9]+$ && "$current_patch" =~ ^[0-9]+$ ]] || return 0

  (( 10#$candidate_major > 10#$current_major )) && return 0
  (( 10#$candidate_major < 10#$current_major )) && return 1
  (( 10#$candidate_minor > 10#$current_minor )) && return 0
  (( 10#$candidate_minor < 10#$current_minor )) && return 1
  (( 10#$candidate_patch > 10#$current_patch ))
}

_hydra_absolute_node_path() {
  local candidate="$1" directory basename
  case "$candidate" in
    /*) ;;
    *) candidate="$PWD/$candidate" ;;
  esac
  directory="${candidate%/*}"
  basename="${candidate##*/}"
  directory="$(cd "$directory" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s' "$directory" "$basename"
}

hydra_resolve_node() {
  local candidate version resolved
  local best_node='' best_version=''

  if [ -n "${_HYDRA_RESOLVED_NODE:-}" ] \
    && _hydra_node_meets_requirement "$_HYDRA_RESOLVED_NODE"; then
    printf '%s\n' "$_HYDRA_RESOLVED_NODE"
    return 0
  fi

  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate" ] && _hydra_node_meets_requirement "$candidate"; then
    resolved="$(_hydra_absolute_node_path "$candidate")" || resolved=''
    if [ -n "$resolved" ]; then
      _HYDRA_RESOLVED_NODE="$resolved"
      printf '%s\n' "$resolved"
      return 0
    fi
  fi

  if [ -n "${HOME:-}" ]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
      [ -x "$candidate" ] || continue
      if _hydra_node_meets_requirement "$candidate"; then
        version="$(_hydra_node_version "$candidate")"
        if _hydra_node_version_is_greater "$version" "$best_version"; then
          best_node="$candidate"
          best_version="$version"
        fi
      fi
    done
  fi

  if [ -n "$best_node" ]; then
    _HYDRA_RESOLVED_NODE="$best_node"
    printf '%s\n' "$best_node"
    return 0
  fi

  for candidate in \
    /opt/homebrew/bin/node \
    /opt/homebrew/opt/node/bin/node \
    /usr/local/opt/node/bin/node; do
    if _hydra_node_meets_requirement "$candidate"; then
      _HYDRA_RESOLVED_NODE="$candidate"
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  hydra_die "Node.js >=22.6 is required for the TypeScript harness; install Node.js >=22.6 or select a pinned compiled binary with HYDRA_HARNESS=bin HYDRA_BIN=<absolute path>"
}

# A candidate compiled binary must be an ABSOLUTE path naming a regular
# executable FILE. `-x` alone is also true for a searchable directory (bash
# then crashes with "is a directory" at exec instead of failing cleanly), and a
# relative path would make the override's meaning depend on the caller's cwd.
_hydra_bin_is_usable() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  [ -f "$1" ] && [ -x "$1" ]
}

# Resolve the compiled single-binary CLI for HYDRA_HARNESS=bin. HYDRA_BIN
# (operator/rollback override — point at a specific pinned build) wins when it
# names an absolute, regular, executable file; otherwise the default
# `npm run build:bin` output (kit/hydra-ts/dist/hydra-cli) is used. Prints the
# resolved path and returns 0 on success.
#
# An unusable binary is a HARD ERROR, never a silent fallback to the ts lane:
# an operator who explicitly asked for `bin` and got quietly downgraded to `ts`
# would not notice the rollback path was broken until they needed it
# (docs/bash-lane-retirement-plan.md §3, Lane 1 runtime contract).
hydra_resolve_bin() {
  local lib_dir candidate
  if [ -n "${HYDRA_BIN:-}" ]; then
    if _hydra_bin_is_usable "$HYDRA_BIN"; then
      printf '%s\n' "$HYDRA_BIN"
      return 0
    fi
    hydra_die "HYDRA_HARNESS=bin requested but HYDRA_BIN=$HYDRA_BIN is missing, not a regular file, or not executable; an explicit HYDRA_BIN never falls back to ts — point it at a usable pinned binary (e.g. \$HOME/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64)"
  fi
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  candidate="$lib_dir/../../hydra-ts/dist/hydra-cli"
  if _hydra_bin_is_usable "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  hydra_die "HYDRA_HARNESS=bin requested but no compiled binary at $candidate; run 'npm run build:bin' in kit/hydra-ts or set HYDRA_BIN to a pinned known-good binary (e.g. \$HOME/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64)"
}

# The ONE call every wrapper makes: hydra_launch <subcommand> [args...].
# Selects the implementation strictly by HYDRA_HARNESS:
#   unset | ts  resolve Node >=22.6 and exec src/cli.ts <subcommand> "$@"
#               (default; argv byte-identical to the historical preamble)
#   bin         resolve a usable compiled binary and exec it via
#               `env -u BUN_BE_BUN` <subcommand> "$@"
# `bash` is retired and any other value is invalid: both exit 2 BEFORE any
# runtime is resolved, so a retired or mistyped selection can never silently
# launch the wrong implementation.
hydra_launch() {
  local subcommand="$1"; shift
  local harness="${HYDRA_HARNESS:-ts}"
  case "$harness" in
    ts)
      local node lib_dir
      node="$(hydra_resolve_node)"
      lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
      exec "$node" --experimental-strip-types "$lib_dir/../../hydra-ts/src/cli.ts" "$subcommand" "$@"
      ;;
    bin)
      local bin
      bin="$(hydra_resolve_bin)"
      exec env -u BUN_BE_BUN "$bin" "$subcommand" "$@"
      ;;
    bash)
      printf '%s\n' 'HYDRA_HARNESS=bash was retired; use HYDRA_HARNESS=bin with a pinned HYDRA_BIN, or use ts' >&2
      exit 2
      ;;
    *)
      printf 'hydra: error: unknown HYDRA_HARNESS=%s; accepted values: ts, bin\n' "$harness" >&2
      exit 2
      ;;
  esac
}
