#!/usr/bin/env bash
# hydra/scripts/otel-env.sh — emit OTel exporter env for Claude workers (Wave 2).
#
# roadmap Wave 2: "Claude workers export OTel to a local collector." Sourced by
# the Claude adapter path before a worker starts. If no collector is listening on
# the endpoint, export is a harmless no-op — telemetry is advisory; Git + ledger
# remain authoritative (observability.yaml normative rule).
#
# Usage:  eval "$(hydra/scripts/otel-env.sh)"   # then dispatch a Claude worker

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SELF_DIR/lib.sh"
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
if [ "${HYDRA_HARNESS:-ts}" = "bin" ] && HYDRA_BIN_PATH="$(hydra_resolve_bin)"; then exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" otel-env "$@"; fi
HYDRA_NODE="$(hydra_resolve_node)"; exec "$HYDRA_NODE" --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/cli.ts" otel-env "$@"
fi
policy="$SELF_DIR/../policies/observability.yaml"
endpoint="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"

# Emit exportable assignments; caller `eval`s them.
cat <<ENV
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=$endpoint
export OTEL_RESOURCE_ATTRIBUTES=service.name=hydra-swarm
ENV
