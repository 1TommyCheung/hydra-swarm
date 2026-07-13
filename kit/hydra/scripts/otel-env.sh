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
if [ "${HYDRA_HARNESS:-ts}" != "bash" ]; then
exec node --experimental-strip-types "$SELF_DIR/../../hydra-ts/src/otel-env.ts" "$@"
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
