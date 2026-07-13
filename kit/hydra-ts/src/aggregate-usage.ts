import { log, now, stateRoot } from './lib.ts';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Data shapes.
// ---------------------------------------------------------------------------

export interface UsageEvent {
  vendor?: unknown;
  time?: unknown;
  cost_usd?: unknown;
  tokens_out?: unknown;
  [key: string]: unknown;
}

export interface PromotedRecord {
  vendor: string;
  task_id: string;
  divergent: boolean;
}

export interface VerdictRecord {
  impl_vendor: string;
  verdict: string;
}

export interface RollingWindowEntry {
  time: unknown;
  cost_usd: unknown;
  tokens_out: unknown;
}

export interface VendorMeasurement {
  n_dispatch: number;
  total_cost_usd: number;
  median_cost_usd: number;
  rolling_window: RollingWindowEntry[];
  n_promoted?: number;
  divergent?: number;
  claim_vs_verified_divergence?: number;
  n_reviewed?: number;
  acceptance_rate?: number;
  revision_rate?: number;
}

export interface MeasuredProfile {
  vendor: string;
  evidence_class: 'measured';
  measured_at: string;
  measured: VendorMeasurement;
}

export interface AggregateUsageOptions {
  stateRoot?: string;
}

// ---------------------------------------------------------------------------
// Discovery + IO.
// ---------------------------------------------------------------------------

function profilesDir(root: string): string {
  return join(root, 'agents', 'profiles');
}

function usageLogPath(root: string): string {
  return join(root, 'agents', 'usage.jsonl');
}

function ledgerPath(root: string, runId: string): string {
  return join(
    root,
    'runs',
    `run-${runId}`,
    'authoritative',
    'ledger',
    'events.jsonl',
  );
}

function discoverRunIds(root: string): string[] {
  const runsDir = join(root, 'runs');
  if (!existsSync(runsDir)) return [];
  const entries = readdirSync(runsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => e.name.slice(4))
    .sort();
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  try {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    // jq's `[inputs]` fails when any line is malformed; the shell swallows it.
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Vendor normalization.
// ---------------------------------------------------------------------------

function vendorName(value: unknown): string {
  if (value === null || value === undefined || value === false) return 'unknown';
  const s = String(value).trim();
  return s.length > 0 ? s : 'unknown';
}

// ---------------------------------------------------------------------------
// Usage aggregation.
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

export function aggregateUsageByVendor(
  events: UsageEvent[],
): Record<string, VendorMeasurement> {
  const groups = new Map<string, UsageEvent[]>();
  for (const ev of events) {
    const v = vendorName(ev.vendor);
    const list = groups.get(v) ?? [];
    list.push(ev);
    groups.set(v, list);
  }

  const result: Record<string, VendorMeasurement> = {};
  for (const [vendor, list] of groups.entries()) {
    const costs = list.map((ev) => toNumber(ev.cost_usd)).sort((a, b) => a - b);
    const rolling = list
      .slice()
      .sort((a, b) => String(a.time).localeCompare(String(b.time)))
      .slice(-40)
      .map((ev) => ({
        time: ev.time ?? null,
        cost_usd: ev.cost_usd ?? null,
        tokens_out: ev.tokens_out ?? null,
      }));

    result[vendor] = {
      n_dispatch: list.length,
      total_cost_usd: costs.reduce((sum, c) => sum + c, 0),
      median_cost_usd: median(costs),
      rolling_window: rolling,
    };
  }
  return result;
}

export function readUsageLog(root: string): Record<string, VendorMeasurement> {
  const path = usageLogPath(root);
  if (!existsSync(path)) return {};
  return aggregateUsageByVendor(readJsonl(path) as UsageEvent[]);
}

// ---------------------------------------------------------------------------
// Outcome aggregation.
// ---------------------------------------------------------------------------

function isDivergenceTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function buildVendorMap(events: Record<string, unknown>[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const ev of events) {
    if (ev.event === 'task_started' && typeof ev.task_id === 'string') {
      map.set(ev.task_id, vendorName(ev.vendor));
    }
  }
  return map;
}

export function extractPromotedRecords(
  events: Record<string, unknown>[],
): PromotedRecord[] {
  const vendorMap = buildVendorMap(events);
  const records: PromotedRecord[] = [];
  for (const ev of events) {
    if (ev.event === 'result_promoted' && typeof ev.task_id === 'string') {
      records.push({
        vendor: vendorMap.get(ev.task_id) ?? 'unknown',
        task_id: ev.task_id,
        divergent: isDivergenceTrue(ev.divergence),
      });
    }
  }
  return records;
}

export function aggregatePromotedByVendor(
  records: PromotedRecord[],
): Record<string, Pick<VendorMeasurement, 'n_promoted' | 'divergent' | 'claim_vs_verified_divergence'>> {
  const groups = new Map<string, PromotedRecord[]>();
  for (const r of records) {
    const list = groups.get(r.vendor) ?? [];
    list.push(r);
    groups.set(r.vendor, list);
  }

  const result: Record<string, Pick<VendorMeasurement, 'n_promoted' | 'divergent' | 'claim_vs_verified_divergence'>> = {};
  for (const [vendor, list] of groups.entries()) {
    const divergent = list.filter((r) => r.divergent).length;
    result[vendor] = {
      n_promoted: list.length,
      divergent,
      claim_vs_verified_divergence: divergent / list.length,
    };
  }
  return result;
}

export function extractVerdictRecords(
  events: Record<string, unknown>[],
): VerdictRecord[] {
  const vendorMap = buildVendorMap(events);
  const records: VerdictRecord[] = [];
  for (const ev of events) {
    if (ev.event === 'review_verdict' && typeof ev.task_id === 'string') {
      records.push({
        impl_vendor: vendorMap.get(ev.task_id) ?? 'unknown',
        verdict: typeof ev.verdict === 'string' ? ev.verdict : '',
      });
    }
  }
  return records;
}

export function aggregateVerdictsByVendor(
  records: VerdictRecord[],
): Record<string, Pick<VendorMeasurement, 'n_reviewed' | 'acceptance_rate' | 'revision_rate'>> {
  const groups = new Map<string, VerdictRecord[]>();
  for (const r of records) {
    const list = groups.get(r.impl_vendor) ?? [];
    list.push(r);
    groups.set(r.impl_vendor, list);
  }

  const result: Record<string, Pick<VendorMeasurement, 'n_reviewed' | 'acceptance_rate' | 'revision_rate'>> = {};
  for (const [vendor, list] of groups.entries()) {
    const n = list.length;
    const accepted = list.filter((r) => r.verdict === 'accept').length;
    const revised = list.filter(
      (r) => r.verdict === 'revise' || r.verdict === 'reject',
    ).length;
    result[vendor] = {
      n_reviewed: n,
      acceptance_rate: accepted / n,
      revision_rate: revised / n,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Profile assembly + persistence.
// ---------------------------------------------------------------------------

export function aggregateUsage(
  options: AggregateUsageOptions = {},
): MeasuredProfile[] {
  const root = options.stateRoot ?? stateRoot();
  const profDir = profilesDir(root);
  mkdirSync(profDir, { recursive: true });

  const usageByVendor = readUsageLog(root);

  const promotedRecords: PromotedRecord[] = [];
  const verdictRecords: VerdictRecord[] = [];
  for (const runId of discoverRunIds(root)) {
    const path = ledgerPath(root, runId);
    if (!existsSync(path)) continue;
    const events = readJsonl(path);
    promotedRecords.push(...extractPromotedRecords(events));
    verdictRecords.push(...extractVerdictRecords(events));
  }

  const promotedByVendor = aggregatePromotedByVendor(promotedRecords);
  const verdictsByVendor = aggregateVerdictsByVendor(verdictRecords);

  const vendors = new Set<string>([
    ...Object.keys(usageByVendor),
    ...Object.keys(promotedByVendor),
    ...Object.keys(verdictsByVendor),
  ]);

  const written: MeasuredProfile[] = [];
  const writtenVendors: string[] = [];
  const measuredAt = now();
  for (const vendor of vendors) {
    if (!vendor || vendor === 'unknown') continue;
    const measured: VendorMeasurement = {
      ...usageByVendor[vendor],
      ...promotedByVendor[vendor],
      ...verdictsByVendor[vendor],
    };
    const profile: MeasuredProfile = {
      vendor,
      evidence_class: 'measured',
      measured_at: measuredAt,
      measured,
    };
    const out = join(profDir, `${vendor}.measured.json`);
    writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
    written.push(profile);
    writtenVendors.push(vendor);
  }

  log(`measured profiles written for: ${writtenVendors.join(' ') || 'none'} -> ${profDir}`);
  return written;
}

export function writeMeasuredProfiles(
  profiles: MeasuredProfile[],
  options: AggregateUsageOptions = {},
): void {
  const root = options.stateRoot ?? stateRoot();
  const profDir = profilesDir(root);
  mkdirSync(profDir, { recursive: true });
  for (const profile of profiles) {
    const out = join(profDir, `${profile.vendor}.measured.json`);
    writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const profiles = aggregateUsage();
    for (const profile of profiles) {
      process.stdout.write(
        `${JSON.stringify({ vendor: profile.vendor, m: profile.measured })}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
