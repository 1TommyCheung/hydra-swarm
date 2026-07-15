import { die, ledger, now, stateRoot } from './lib.ts';
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

export interface DivergenceRecord {
  vendor: string;
  divergence: boolean;
}

export interface VendorScore {
  n: number;
  divergent: number;
  claim_vs_verified_divergence: number;
}

export interface Scorecard {
  measured_at: string;
  evidence_class: 'measured';
  per_vendor: Record<string, VendorScore>;
}

// ---------------------------------------------------------------------------
// Discovery + IO.
// ---------------------------------------------------------------------------

function ledgerPath(root: string, runId: string): string {
  // Reproduce the path layout from lib.ledger() while allowing an explicit
  // state root (used by tests to point at a temp directory).
  return join(root, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
}

export function discoverRunIds(root: string): string[] {
  const runsDir = join(root, 'runs');
  if (!existsSync(runsDir)) return [];
  const entries = readdirSync(runsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => e.name.slice(4))
    .sort();
}

export function readLedger(ledgerPath: string): Record<string, unknown>[] {
  const content = readFileSync(ledgerPath, 'utf8');
  try {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    // jq's `[inputs]` buffers the ledger and produces no records when any
    // input line is malformed; the shell then swallows jq's failure.
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Divergence semantics.
// ---------------------------------------------------------------------------

export function isDivergenceTrue(value: unknown): boolean {
  return value === 'true' || value === true;
}

export function extractDivergenceRecords(
  events: Record<string, unknown>[],
): DivergenceRecord[] {
  const vendorMap = new Map<string, string>();
  for (const ev of events) {
    if (ev.event === 'task_started' && typeof ev.task_id === 'string') {
      const vendor = ev.vendor === null || ev.vendor === undefined || ev.vendor === false
        ? 'unknown'
        : String(ev.vendor);
      vendorMap.set(ev.task_id, vendor);
    }
  }

  const records: DivergenceRecord[] = [];
  for (const ev of events) {
    if (ev.event === 'result_promoted' && typeof ev.task_id === 'string') {
      records.push({
        vendor: vendorMap.get(ev.task_id) ?? 'unknown',
        divergence: isDivergenceTrue(ev.divergence),
      });
    }
  }
  return records;
}

export function aggregateScorecard(
  records: DivergenceRecord[],
): Record<string, VendorScore> {
  const groups = new Map<string, DivergenceRecord[]>();
  for (const r of records) {
    const list = groups.get(r.vendor) ?? [];
    list.push(r);
    groups.set(r.vendor, list);
  }

  const perVendor: Record<string, VendorScore> = {};
  for (const [vendor, list] of groups.entries()) {
    const divergent = list.filter((r) => r.divergence).length;
    perVendor[vendor] = {
      n: list.length,
      divergent,
      claim_vs_verified_divergence: divergent / list.length,
    };
  }
  return perVendor;
}

// ---------------------------------------------------------------------------
// Scorecard assembly + persistence.
// ---------------------------------------------------------------------------

export function scorecardPath(root: string): string {
  return join(root, 'agents', 'divergence-scorecard.json');
}

export interface MeasureOptions {
  stateRoot?: string;
}

export function measureDivergence(
  runIds?: string[],
  options: MeasureOptions = {},
): Scorecard {
  const root = options.stateRoot ?? stateRoot();
  const ids = runIds && runIds.length > 0 ? runIds : discoverRunIds(root);

  if (ids.length === 0) {
    die(`no runs found under ${join(root, 'runs')}`);
  }

  const records: DivergenceRecord[] = [];
  for (const runId of ids) {
    const path = options.stateRoot ? ledgerPath(root, runId) : ledger(runId);
    if (!existsSync(path)) continue;
    const events = readLedger(path);
    records.push(...extractDivergenceRecords(events));
  }

  return {
    measured_at: now(),
    evidence_class: 'measured',
    per_vendor: aggregateScorecard(records),
  };
}

export function writeScorecard(
  scorecard: Scorecard,
  options: MeasureOptions = {},
): void {
  const root = options.stateRoot ?? stateRoot();
  const out = scorecardPath(root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(scorecard, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const scorecard = measureDivergence(args.length > 0 ? args : undefined);
    writeScorecard(scorecard);
    process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
