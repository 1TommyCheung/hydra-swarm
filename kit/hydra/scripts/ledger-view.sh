#!/usr/bin/env bash
# hydra/scripts/ledger-view.sh — authoritative Layer-2 ledger web renderer (Wave 2).
#
# LAUNCHER ONLY. The Bash implementation body of this command was retired
# (docs/bash-lane-retirement-plan.md). This wrapper keeps the stable filename
# and routes the 'ledger-view' subcommand to the TypeScript harness (HYDRA_HARNESS
# unset or 'ts') or a pinned compiled binary ('bin'); see hydra_launch in
# lib.sh for the exact runtime contract.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
hydra_launch ledger-view "$@"
