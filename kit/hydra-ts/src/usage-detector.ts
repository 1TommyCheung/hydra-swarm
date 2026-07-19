import { readFileSync as defaultReadFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageLimitDetails } from './dispatch.ts';

/**
 * usage-detector.ts — vendor usage-limit detection (task 2a: OpenCode only).
 *
 * Motivation: an OpenCode/GLM dispatch once hung for the full timeout twice
 * because the vendor CLI retried a rate-limited provider internally forever —
 * never exiting, never erroring — while the only evidence was a
 *   level=ERROR ... message="stream error" ... error.error="AI_APICallError:
 *   Usage limit reached for 5 hour. Your limit will reset at ..."
 * record buried in the CLI's diagnostic log stream. The adapter now runs the
 * CLI with `--print-logs --log-level ERROR`, so those records land in the
 * per-attempt `.stderr` capture file this module tails.
 *
 * TRUST BOUNDARY (the property the whole system depends on): a detection is
 * only ever derived from a line matching the vendor CLI's own structured
 * diagnostic record shape — `level=ERROR` + `message="stream error"` + an
 * `error.error="..."` field — and the limit phrasing is read exclusively out
 * of that structured field. The phrase "usage limit reached" appearing in ANY
 * other context (assistant-authored text, tool output, file contents, the
 * task prompt) is never a match. This keeps the detector unreachable by
 * content the worker/vendor model itself could have generated.
 *
 * Precision is deliberately favored over recall: a false positive (killing a
 * task that was not actually rate-limited) is worse than a missed detection,
 * since the existing stall/timeout mechanisms remain as a backstop.
 */

export interface UsageDetectorState {
  enabled: boolean;
  capturePath: string | null;
  /** Bytes of capturePath already consumed. The capture is append-only for the life of one attempt. */
  offset: number;
  /** Sticky once a match fired; the attempt is being torn down, so never re-fire. */
  matched: boolean;
}

export interface UsageDetectorOptions {
  vendor: string;
  sessionsDir: string;
  agentRunId: string;
  env?: NodeJS.ProcessEnv;
  readFileSync?: (path: string) => Buffer | undefined;
}

export interface UsageDetectorTickResult {
  state: UsageDetectorState;
  match: UsageLimitDetails | null;
}

/** Vendors with a classifier in this module. Others are gated off entirely. */
const SUPPORTED_VENDORS = new Set(['opencode']);

// The trusted OpenCode `--print-logs` diagnostic record shape. All three
// markers must be present as whitespace-delimited structured fields.
const LEVEL_ERROR_RE = /(?:^|\s)level=ERROR(?:\s|$)/;
const STREAM_ERROR_MESSAGE_RE = /(?:^|\s)message="stream error"(?:\s|$)/;
const ERROR_FIELD_RE = /(?:^|\s)error\.error="((?:[^"\\]|\\.)*)"/;
const PROVIDER_FIELD_RE = /(?:^|\s)providerID=(\S+)/;
const MODEL_FIELD_RE = /(?:^|\s)modelID=(\S+)/;

// Limit phrasing, matched ONLY against the structured error.error field value.
const USAGE_WINDOW_RE = /usage\s*limit|usage window/i;
const RATE_LIMIT_RE = /rate\s*limit|\b429\b|too many requests/i;
const QUOTA_RE = /quota|insufficient\s+\w*\s*(credit|balance)|billing/i;
const GENERIC_LIMIT_RE = /\blimit(?:ed)?\b|\bexceeded\b|\bexhausted\b|\bthrottled?\b/i;
const API_CALL_ERROR_RE = /AI_APICallError/;

// "Your limit will reset at 2026-07-19 18:37:11" — the CLI logs in host-local
// time with no zone designator; parse as local and convert to UTC ISO-8601.
// Components are captured individually so they can be range-checked first.
const RESET_AT_RE = /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})?/i;

const RAW_ERROR_CAP = 500;

function daysInMonth(year: number, month: number): number {
  // month is 1-based; February follows the Gregorian leap-year rule.
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) return 29;
  return lengths[month - 1] ?? 0;
}

function parseRetryAt(errorText: string): string | undefined {
  const match = RESET_AT_RE.exec(errorText);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  // reject impossible calendar values before constructing a Date, since JS silently normalizes them
  // (e.g. "2026-02-30" would roll over to 2026-03-02, fabricating a wrong
  // retry_at — and a wrong retry_at is actively harmful).
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  // No zone suffix => host-local time (per the CLI's local logging); an
  // explicit Z/offset suffix is honored as-is.
  const parsed = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone ?? ''}`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/**
 * Classify one capture line. Returns null unless the line is a trusted,
 * structured vendor diagnostic record whose error.error field carries
 * recognizable rate-limit/usage/quota phrasing.
 */
export function classifyUsageLimitLine(line: string, vendor: string): UsageLimitDetails | null {
  if (!SUPPORTED_VENDORS.has(vendor)) return null;

  if (!LEVEL_ERROR_RE.test(line)) return null;
  if (!STREAM_ERROR_MESSAGE_RE.test(line)) return null;
  const errorField = ERROR_FIELD_RE.exec(line);
  if (!errorField) return null;
  const errorText = errorField[1];

  // AI_APICallError is now a hard requirement, not just a confidence signal.
  // The vendor SDK's own error class must be present in the structured
  // error.error field; a structured-looking line without it (possibly crafted
  // by untrusted content) is rejected outright, at any confidence level.
  if (!API_CALL_ERROR_RE.test(errorText)) return null;

  let limitKind: UsageLimitDetails['limitKind'];
  if (USAGE_WINDOW_RE.test(errorText)) limitKind = 'usage_window';
  else if (RATE_LIMIT_RE.test(errorText)) limitKind = 'rate_limit';
  else if (QUOTA_RE.test(errorText)) limitKind = 'quota_exhausted';
  else if (GENERIC_LIMIT_RE.test(errorText)) limitKind = 'unknown';
  else return null;

  // The SDK class marker is guaranteed present here (hard gate above), so a
  // classified line is always an exact match.
  const confidence: UsageLimitDetails['confidence'] = 'exact';
  const retryAt = parseRetryAt(errorText);
  const provider = PROVIDER_FIELD_RE.exec(line)?.[1];
  const model = MODEL_FIELD_RE.exec(line)?.[1];

  return {
    vendor,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    limitKind,
    // A vendor-supplied reset time, or a limit kind that resets by definition,
    // means the attempt is safe to retry later; anything else stays unknown.
    retryable: retryAt !== undefined || limitKind === 'usage_window' || limitKind === 'rate_limit',
    ...(retryAt === undefined ? {} : { retryAt }),
    source: 'stderr',
    confidence,
    rawError: errorText.slice(0, RAW_ERROR_CAP),
  };
}

export function createUsageDetectorState(): UsageDetectorState {
  return {
    enabled: true,
    capturePath: null,
    offset: 0,
    matched: false,
  };
}

/**
 * Read only the bytes appended to the attempt's `.stderr` capture since the
 * previous tick, split them into complete lines, and return the first
 * classified usage-limit match (or null). Deliberately simpler than
 * loop-detector's incremental reader: the capture is append-only for one
 * attempt, so a bare byte offset plus a truncation guard is sufficient.
 */
export function usageDetectorTick(
  state: UsageDetectorState,
  options: UsageDetectorOptions,
): UsageDetectorTickResult {
  if (options.env?.HYDRA_USAGE_DETECTOR === '0' || !SUPPORTED_VENDORS.has(options.vendor)) {
    state.enabled = false;
    return { state, match: null };
  }
  state.enabled = true;
  if (state.matched) return { state, match: null };

  const capturePath = join(options.sessionsDir, `${options.agentRunId}.stderr`);
  if (state.capturePath !== capturePath) {
    state.capturePath = capturePath;
    state.offset = 0;
  }

  const read = options.readFileSync
    ?? ((path: string): Buffer | undefined => {
      try {
        return defaultReadFileSync(path);
      } catch {
        return undefined;
      }
    });

  let contents: Buffer | undefined;
  try {
    contents = read(capturePath);
  } catch {
    contents = undefined;
  }
  if (!contents) return { state, match: null };
  if (contents.length < state.offset) {
    // Truncated or rewritten mid-attempt: start over rather than trust offsets.
    state.offset = 0;
  }

  const available = contents.subarray(state.offset);
  const lastNewline = available.lastIndexOf(0x0a);
  if (lastNewline < 0) return { state, match: null };

  const consumed = lastNewline + 1;
  const lines = available.subarray(0, consumed).toString('utf8').split('\n');
  state.offset += consumed;

  for (const line of lines) {
    if (!line) continue;
    const match = classifyUsageLimitLine(line, options.vendor);
    if (match) {
      state.matched = true;
      return { state, match };
    }
  }
  return { state, match: null };
}
