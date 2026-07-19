import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { warn } from './lib.ts';

// ---------------------------------------------------------------------------
// Vendor usage-limit cooldown registry (run 0055, task 3).
//
// When a usage-limit detector confirms a vendor is exhausted, dispatch records
// a machine-global cooldown fact here. Vendor credentials are machine-global
// (every repo on the machine shares the same ~/.claude, ~/.codex,
// ~/.local/share/opencode, ~/.kimi-code auth), so a per-repo cooldown would let
// a different repo immediately re-hit the same exhausted account and hang
// again. The file lives next to detect-heads.ts's heads.json in
// ~/.local/state/hydra (deliberately NOT the per-repo stateRoot()) and mirrors
// that module's directory resolution and atomic-write pattern exactly.
//
// Consumers:
//   - dispatch.ts  runUsageDetectorTick records a cooldown alongside
//     recordUsageLimited (best-effort: a write failure never blocks the
//     usage-limited termination)
//   - dispatch.ts  enforceVendorCooldown refuses to START a dispatch to a
//     vendor with an active cooldown, mirroring enforceHeadAvailability: the
//     operator waits for the reset or re-pins assigned_vendor — hydra never
//     auto-substitutes, never auto-reroutes, never auto-retries.
// ---------------------------------------------------------------------------

/**
 * Fallback cooldown window applied when the vendor's own error carried no
 * usable reset timestamp: a very recent detection still blocks dispatch, but
 * the cooldown expires on its own without any explicit clear step.
 * Deliberately short — it exists so an unknown-reset detection can never
 * silently hang a second dispatch, not to guess the vendor's real window.
 */
export const FALLBACK_COOLDOWN_MS = 15 * 60 * 1000;

export interface CooldownDetails {
  /** Vendor whose usage limit was hit. */
  vendor: string;
  /** Upstream provider; omitted when the detection could not determine one. */
  provider?: string;
  /** Model; omitted when the detection could not determine one. */
  model?: string;
  /** UTC ISO-8601 reset timestamp from the vendor's own error, when known. */
  retryAt?: string;
  /** Vendor's raw error text (already redacted/size-capped by the caller). */
  rawError: string;
}

export interface CooldownOptions {
  /** Machine-global hydra state dir; defaults to ~/.local/state/hydra. */
  stateDir?: string;
  /** Environment for HYDRA_COOLDOWN_FILE / HOME; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock (ms since epoch); defaults to Date.now. */
  now?: () => number;
}

interface StoredCooldown {
  vendor: string;
  provider?: string;
  model?: string;
  /** Vendor-reported reset time; stored only when known. Read-time expiry. */
  retryAt?: string;
  /** UTC ISO-8601 recording time; basis of FALLBACK_COOLDOWN_MS when retryAt is absent or unusable. */
  recordedAt: string;
  rawError: string;
}

interface CooldownFile {
  cooldowns: Record<string, StoredCooldown>;
}

/** An active-cooldown hit: the vendor's reset time when known, else absent. */
export interface ActiveCooldown {
  retryAt?: string;
  rawError: string;
}

/** The machine-global hydra state dir (deliberately NOT per-repo). */
function defaultStateDir(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? '', '.local/state/hydra');
}

/**
 * Resolve the vendor-cooldowns.json path: an explicit stateDir wins, then the
 * HYDRA_COOLDOWN_FILE override (tests/ops), then the machine-global default —
 * the same precedence headsFilePath() uses for heads.json.
 */
export function cooldownFilePath(
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  if (options.stateDir !== undefined) return join(options.stateDir, 'vendor-cooldowns.json');
  if (env.HYDRA_COOLDOWN_FILE) return env.HYDRA_COOLDOWN_FILE;
  return join(defaultStateDir(env), 'vendor-cooldowns.json');
}

/**
 * Deterministic storage key for a vendor/provider/model composite. Absent
 * components encode as JSON null, so "no provider known" can never collide
 * with the literal string 'undefined' or 'null', and JSON array encoding keeps
 * distinct combinations in distinct buckets no matter what the values contain.
 */
export function cooldownKey(vendor: string, provider?: string, model?: string): string {
  return JSON.stringify([vendor, provider ?? null, model ?? null]);
}

/**
 * Read the cooldown file; null when missing, unparsable, or misshapen. A
 * missing file is the normal "no cooldowns on record" case and stays silent; a
 * corrupt file warns (the fact that detection state was lost is operator-visible)
 * but still fails open.
 */
function readCooldownFile(path: string): CooldownFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`vendor cooldown file is corrupt (${path}); ignoring it`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`vendor cooldown file is misshapen (${path}); ignoring it`);
    return null;
  }
  const cooldowns = (parsed as Record<string, unknown>).cooldowns;
  if (cooldowns === null || typeof cooldowns !== 'object' || Array.isArray(cooldowns)) {
    warn(`vendor cooldown file is misshapen (${path}); ignoring it`);
    return null;
  }
  return parsed as CooldownFile;
}

/** Write the cooldown file atomically so concurrent readers never see a torn file. */
function writeCooldownAtomic(path: string, file: CooldownFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Record (or refresh) the cooldown for a vendor/provider/model composite.
 * When details.retryAt is present it is stored as the cooldown's expiry; when
 * absent the read side falls back to FALLBACK_COOLDOWN_MS from the recording
 * time. Best-effort by contract: any failure is logged and swallowed so a
 * cooldown write can never block a dispatch or a usage-limited termination.
 */
export function recordCooldown(details: CooldownDetails, options: CooldownOptions = {}): void {
  try {
    const path = cooldownFilePath(options);
    const file = readCooldownFile(path) ?? { cooldowns: {} };
    const nowMs = (options.now ?? Date.now)();
    const entry: StoredCooldown = {
      vendor: details.vendor,
      recordedAt: new Date(nowMs).toISOString(),
      rawError: details.rawError,
    };
    if (details.provider !== undefined) entry.provider = details.provider;
    if (details.model !== undefined) entry.model = details.model;
    if (details.retryAt !== undefined) entry.retryAt = details.retryAt;
    file.cooldowns[cooldownKey(details.vendor, details.provider, details.model)] = entry;
    writeCooldownAtomic(path, file);
  } catch (error) {
    warn(`failed to record vendor cooldown: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** True when the entry has not yet expired relative to nowMs. */
function isActive(entry: StoredCooldown, nowMs: number): boolean {
  const retryAtMs = typeof entry.retryAt === 'string' ? Date.parse(entry.retryAt) : NaN;
  if (Number.isFinite(retryAtMs)) return retryAtMs > nowMs;
  const recordedAtMs = typeof entry.recordedAt === 'string' ? Date.parse(entry.recordedAt) : NaN;
  if (!Number.isFinite(recordedAtMs)) return false;
  return recordedAtMs + FALLBACK_COOLDOWN_MS > nowMs;
}

/**
 * Look up an active cooldown. A query component that is provided must equal
 * the recorded one; an omitted query component matches any recorded value, so
 * a bare `activeCooldown(vendor)` — what the dispatch gate calls — finds EVERY
 * cooldown recorded against that vendor's machine-global credential, however
 * much provider/model detail the detection carried.
 *
 * Expiry is computed at read time: a parseable retryAt in the future keeps the
 * cooldown active; without a usable retryAt the FALLBACK_COOLDOWN_MS window
 * from recordedAt applies. An expired cooldown needs no explicit clear — it
 * simply stops matching once the vendor's reset time has passed. Returns null
 * (fail open, never throws) when the file is missing/corrupt, nothing matches,
 * or every match has expired.
 */
export function activeCooldown(
  vendor: string,
  provider?: string,
  model?: string,
  options: CooldownOptions = {},
): ActiveCooldown | null {
  try {
    const file = readCooldownFile(cooldownFilePath(options));
    if (file === null) return null;
    const nowMs = (options.now ?? Date.now)();
    for (const entry of Object.values(file.cooldowns)) {
      if (entry === null || typeof entry !== 'object') continue;
      if (entry.vendor !== vendor) continue;
      if (provider !== undefined && entry.provider !== provider) continue;
      if (model !== undefined && entry.model !== model) continue;
      if (!isActive(entry, nowMs)) continue;
      const active: ActiveCooldown = {
        rawError: typeof entry.rawError === 'string' ? entry.rawError : '',
      };
      if (typeof entry.retryAt === 'string' && Number.isFinite(Date.parse(entry.retryAt))) {
        active.retryAt = entry.retryAt;
      }
      return active;
    }
    return null;
  } catch (error) {
    // Fail open: a broken cooldown store must never itself block dispatch.
    warn(`vendor cooldown check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
