#!/usr/bin/env bash
# hydra/scripts/wait-run.sh — block until every named task in a run (or every
# task in the run) reaches a terminal state.
#
# LAUNCHER ONLY. This wrapper keeps the stable filename and routes the
# 'wait-run' subcommand to the TypeScript harness (HYDRA_HARNESS unset or 'ts')
# or a pinned compiled binary ('bin'); see hydra_launch in lib.sh for the exact
# runtime contract.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
hydra_launch wait-run "$@"
