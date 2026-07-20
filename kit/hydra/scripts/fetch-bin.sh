#!/usr/bin/env bash
# hydra/scripts/fetch-bin.sh — download the release binary matching THIS
# plugin's version (or its semver-base fallback tag, e.g. 0.6.8.1 -> v0.6.8)
# into the version-keyed cache hydra_resolve_bin probes.
#
# Verification gates (all must pass or nothing is installed; the ts source
# lane keeps working regardless):
#   1. SHA-256 against the release's build-matrix manifest
#   2. the binary's own `version --json` must equal the selected release tag
#   3. artifact name matches this machine's target triple
#
# HYDRA_BIN_BASE_URL overrides the download base FOR TESTS ONLY (a local
# fixture server); the default is the pinned GitHub Releases URL and https is
# enforced for it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

DEFAULT_BASE_URL="https://github.com/1TommyCheung/hydra-swarm/releases/download"
base_url="${HYDRA_BIN_BASE_URL:-$DEFAULT_BASE_URL}"

version="$(_hydra_plugin_version)"
[ -n "$version" ] || hydra_die "cannot determine plugin version from .claude-plugin/plugin.json"
target="$(_hydra_bin_target)"
[ -n "$target" ] || hydra_die "unsupported platform: $(uname -s)/$(uname -m) — release targets are darwin-arm64, darwin-x64, linux-x64, linux-arm64 (Windows: use WSL)"

command -v curl >/dev/null 2>&1 || hydra_die "curl is required to download release binaries"
command -v jq >/dev/null 2>&1 || hydra_die "jq is required to verify the release manifest"

if [ "$base_url" = "$DEFAULT_BASE_URL" ]; then
  curl_proto=(--proto '=https' --tlsv1.2)
else
  # Test override: allow a local http fixture server, and say so loudly.
  curl_proto=()
  printf 'hydra: warn: HYDRA_BIN_BASE_URL override in effect (%s) — test mode, not the pinned release URL\n' "$base_url" >&2
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

bin_asset="hydra-cli-${target}"
manifest_asset="manifest-${target}.json"
release_version="$version"
if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+$ ]]; then
  release_version="${BASH_REMATCH[1]}"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/hydra-fetch-bin.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

downloaded=0
for candidate in "$version" "$release_version"; do
  [ -n "$candidate" ] || continue
  [ "$downloaded" -eq 0 ] || break
  url_base="${base_url}/v${candidate}"
  printf 'hydra: fetching %s (release v%s, cache key v%s)\n' "$bin_asset" "$candidate" "$version" >&2
  if ! curl -fsSL "${curl_proto[@]}" -o "$tmp_dir/$manifest_asset" "$url_base/$manifest_asset"; then
    continue
  fi
  curl -fsSL "${curl_proto[@]}" -o "$tmp_dir/$bin_asset" "$url_base/$bin_asset" \
    || hydra_die "binary download failed: $url_base/$bin_asset"
  release_version="$candidate"
  downloaded=1
done
[ "$downloaded" -eq 1 ] || hydra_die "manifest download failed for release tags v$version and v$release_version (is either release published?)"

# Gate 3: the manifest must describe exactly this target.
manifest_target="$(jq -r '.target // empty' "$tmp_dir/$manifest_asset")"
[ "$manifest_target" = "bun-${target}" ] \
  || hydra_die "manifest target mismatch: expected bun-${target}, manifest says '${manifest_target}'"

# Gate 1: checksum.
expected_sha="$(jq -r '.sha256 // empty' "$tmp_dir/$manifest_asset")"
[ -n "$expected_sha" ] || hydra_die "manifest has no sha256 field"
actual_sha="$(sha256_of "$tmp_dir/$bin_asset")"
[ "$actual_sha" = "$expected_sha" ] \
  || hydra_die "sha256 mismatch: manifest $expected_sha, downloaded $actual_sha — refusing to install"

# Gate 2: the binary must self-report the version we asked for. env -u strips
# a leaked BUN_BE_BUN=1, which would hijack a Bun-compiled binary into Bun's
# own CLI (docs/bun-migration-spike-results.md).
chmod 755 "$tmp_dir/$bin_asset"
reported="$(env -u BUN_BE_BUN "$tmp_dir/$bin_asset" version --json 2>/dev/null | jq -r '.version // empty' || true)"
[ "$reported" = "$release_version" ] \
  || hydra_die "binary self-reports version '${reported:-unreadable}', expected '$release_version' — refusing to install"

install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/hydra-bin/v${version}"
mkdir -p "$install_dir"
mv -f "$tmp_dir/$bin_asset" "$install_dir/$bin_asset"
mv -f "$tmp_dir/$manifest_asset" "$install_dir/$manifest_asset"

printf 'hydra: installed %s/%s (sha256 verified, release v%s, cache key v%s)\n' "$install_dir" "$bin_asset" "$release_version" "$version"
