import { env } from 'node:process';

// ---------------------------------------------------------------------------
// OpenTelemetry exporter environment for Claude workers (Wave 2).
//
// Port of hydra/scripts/otel-env.sh. Builds the OTEL_* resource attribute map
// from run context. Telemetry is advisory; Git + ledger remain authoritative.
// ---------------------------------------------------------------------------

export const OTEL_DEFAULT_ENDPOINT = 'http://localhost:4318';

/**
 * Build the OpenTelemetry env-var map emitted by the bash script.
 *
 * Reads `OTEL_EXPORTER_OTLP_ENDPOINT` from the current process environment and
 * falls back to `http://localhost:4318` when unset or empty, matching bash
 * `${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}`.
 */
export function buildOtelEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT || OTEL_DEFAULT_ENDPOINT,
    OTEL_RESOURCE_ATTRIBUTES: 'service.name=hydra-swarm',
  };
}

/**
 * Format an env-var map as `export KEY=value` lines, suitable for `eval`.
 * Matches the bash here-document output including the trailing newline.
 */
export function formatOtelEnv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `export ${key}=${value}`)
    .join('\n') + '\n';
}

/**
 * Return the full shell snippet produced by the original bash script.
 */
export function otelEnvShell(): string {
  return formatOtelEnv(buildOtelEnv());
}

// Backwards-compatible default export for consumers that import the module.
export default {
  OTEL_DEFAULT_ENDPOINT,
  buildOtelEnv,
  formatOtelEnv,
  otelEnvShell,
};
