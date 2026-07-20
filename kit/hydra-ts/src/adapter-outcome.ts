import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AdapterUsageLimitDetails {
  vendor: string;
  provider?: string;
  model?: string;
  limitKind: 'rate_limit' | 'quota_exhausted' | 'usage_window' | 'concurrency_limit' | 'unknown';
  scope?: 'credential' | 'account' | 'provider' | 'model' | 'unknown';
  retryAt?: string;
  retryable: boolean;
  source: 'structured_event' | 'cli_diagnostic' | 'stderr' | 'exit';
  confidence: 'exact' | 'high' | 'heuristic';
  rawError: string;
}

export type AdapterOutcome =
  | { version: 1; vendor: string; kind: 'success' }
  | { version: 1; vendor: string; kind: 'usage_limited'; details: AdapterUsageLimitDetails }
  | { version: 1; vendor: string; kind: 'terminal_failure'; reason: string; rawError: string };

const RAW_ERROR_CAP = 500;
const CLAUDE_QUOTA_MARKER_RE = /^(?:API Error:\s*)?(?:usage credits? required|credit balance|quota (?:exceeded|exhausted)|billing limit)/i;
const LIMIT_KINDS = new Set(['rate_limit', 'quota_exhausted', 'usage_window', 'concurrency_limit', 'unknown']);
const SOURCES = new Set(['structured_event', 'cli_diagnostic', 'stderr', 'exit']);
const CONFIDENCES = new Set(['exact', 'high', 'heuristic']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function rawError(envelope: Record<string, unknown>): string {
  return typeof envelope.result === 'string'
    ? envelope.result.slice(0, RAW_ERROR_CAP)
    : 'Claude returned a structured API error';
}

/** Classify only Claude-owned result-envelope fields. Result prose is read
 * only after a structured error gate, so assistant text cannot trigger this. */
export function classifyClaudeOutcome(raw: string): AdapterOutcome | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, vendor: 'claude', kind: 'terminal_failure', reason: 'Claude result envelope was malformed', rawError: 'malformed Claude JSON result envelope' };
  }
  const envelope = record(parsed);
  if (!envelope) {
    return { version: 1, vendor: 'claude', kind: 'terminal_failure', reason: 'Claude result envelope was malformed', rawError: 'non-object Claude JSON result envelope' };
  }
  const status = typeof envelope.api_error_status === 'number' && Number.isInteger(envelope.api_error_status)
    ? envelope.api_error_status : undefined;
  if (envelope.is_error !== true && status === undefined) {
    return envelope.is_error === false ? { version: 1, vendor: 'claude', kind: 'success' } : null;
  }
  const error = rawError(envelope);
  if (status === 429 || CLAUDE_QUOTA_MARKER_RE.test(error)) {
    return {
      version: 1, vendor: 'claude', kind: 'usage_limited',
      details: {
        vendor: 'claude',
        limitKind: status === 429 ? 'rate_limit' : 'quota_exhausted',
        retryable: status === 429,
        source: 'structured_event', confidence: 'exact', rawError: error,
      },
    };
  }
  return {
    version: 1, vendor: 'claude', kind: 'terminal_failure',
    reason: status === undefined ? 'Claude API error' : `Claude API error (HTTP ${status})`,
    rawError: error,
  };
}

export function adapterOutcomePath(sessionsDir: string, agentRunId: string): string {
  return join(sessionsDir, `${agentRunId}.outcome.json`);
}

export function writeAdapterOutcome(sessionsDir: string, agentRunId: string, outcome: AdapterOutcome): void {
  writeFileSync(adapterOutcomePath(sessionsDir, agentRunId), `${JSON.stringify(outcome)}\n`, 'utf8');
}

export function readAdapterOutcome(sessionsDir: string, agentRunId: string): AdapterOutcome | null {
  const path = adapterOutcomePath(sessionsDir, agentRunId);
  if (!existsSync(path)) return null;
  try {
    const parsed = record(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed || parsed.version !== 1 || typeof parsed.vendor !== 'string') throw new Error('invalid');
    if (parsed.kind === 'success') return parsed as unknown as AdapterOutcome;
    if (parsed.kind === 'terminal_failure' && typeof parsed.reason === 'string' && typeof parsed.rawError === 'string') return parsed as unknown as AdapterOutcome;
    const details = record(parsed.details);
    if (parsed.kind === 'usage_limited' && details && details.vendor === parsed.vendor
      && typeof details.limitKind === 'string' && LIMIT_KINDS.has(details.limitKind)
      && typeof details.retryable === 'boolean'
      && typeof details.source === 'string' && SOURCES.has(details.source)
      && typeof details.confidence === 'string' && CONFIDENCES.has(details.confidence)
      && typeof details.rawError === 'string') return parsed as unknown as AdapterOutcome;
  } catch {
    // Present-but-malformed differs from an absent legacy sidecar and fails closed.
  }
  return { version: 1, vendor: 'unknown', kind: 'terminal_failure', reason: 'adapter outcome sidecar was malformed', rawError: 'malformed adapter outcome sidecar' };
}
