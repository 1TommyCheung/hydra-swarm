import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  die,
  ledgerAppend,
  now,
  runDir,
  stateRoot,
  warn,
  yamlScalar,
} from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';

export interface Usage {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

function zeroUsage(): Usage {
  return { cost_usd: 0, tokens_in: 0, tokens_out: 0 };
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function readUsageClaude(cliPath: string): Usage | null {
  if (!existsSync(cliPath)) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(cliPath, 'utf8'));
  } catch {
    return { cost_usd: 0, tokens_in: 0, tokens_out: 0 };
  }
  const obj = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  const usage = typeof obj.usage === 'object' && obj.usage !== null
    ? obj.usage as Record<string, unknown>
    : {};
  const result = {
    cost_usd: toNumber(obj.total_cost_usd ?? obj.cost_usd ?? 0),
    tokens_in: toNumber(usage.input_tokens ?? 0),
    tokens_out: toNumber(usage.output_tokens ?? 0),
  };
  const structuredError = obj.is_error === true || typeof obj.api_error_status === 'number';
  if (structuredError && result.cost_usd === 0 && result.tokens_in === 0 && result.tokens_out === 0) {
    return null;
  }
  return result;
}

function collectTokens(obj: unknown, key: string): number[] {
  const values: number[] = [];
  function walk(value: unknown): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (key in record) {
        values.push(toNumber(record[key]));
      }
      for (const child of Object.values(record)) {
        walk(child);
      }
    } else if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
    }
  }
  walk(obj);
  return values;
}

function readUsageCodex(cliPath: string): Usage | null {
  if (!existsSync(cliPath)) {
    return null;
  }
  const lines = readFileSync(cliPath, 'utf8').split('\n');
  const inputs: number[] = [];
  const outputs: number[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      // `jq -s` rejects the entire input when any JSON value is malformed.
      return zeroUsage();
    }
    inputs.push(...collectTokens(data, 'input_tokens'));
    outputs.push(...collectTokens(data, 'output_tokens'));
  }
  return {
    cost_usd: 0,
    tokens_in: inputs.at(-1) ?? 0,
    tokens_out: outputs.at(-1) ?? 0,
  };
}

function readUsageOpencode(sessPath: string): Usage | null {
  if (!existsSync(sessPath)) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(sessPath, 'utf8'));
  } catch {
    return { cost_usd: 0, tokens_in: 0, tokens_out: 0 };
  }
  const obj = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  const tokens = typeof obj.tokens === 'object' && obj.tokens !== null
    ? obj.tokens as Record<string, unknown>
    : {};
  return {
    cost_usd: toNumber(obj.cost ?? 0),
    tokens_in: toNumber(tokens.input ?? 0),
    tokens_out: toNumber(tokens.output ?? 0),
  };
}

function usageLogPath(): string {
  return join(stateRoot(), 'agents', 'usage.jsonl');
}

function appendUsageLog(entry: Record<string, unknown>): void {
  const logPath = usageLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function sumUsageLogCost(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  const lines = readFileSync(logPath, 'utf8').split('\n');
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
    total += toNumber(obj.cost_usd ?? 0);
  }
  return total;
}

export function readVendorUsage(
  vendor: string,
  sessionsDir: string,
  agentRunId: string,
): Usage | null {
  switch (vendor) {
    case 'claude':
      return readUsageClaude(join(sessionsDir, `${agentRunId}.cli.json`));
    case 'codex':
      return readUsageCodex(join(sessionsDir, `${agentRunId}.cli.jsonl`));
    case 'opencode':
      return readUsageOpencode(join(sessionsDir, `${agentRunId}.session.json`));
    default:
      // The shell case statement has no default branch, so an unrecognised
      // vendor still reaches the common recording path with zeroed counters.
      return zeroUsage();
  }
}

export function recordUsage(
  runId: string,
  taskId: string,
  vendor: string,
  agentRunId: string,
): void {
  for (const [name, value] of [
    ['runId', runId],
    ['taskId', taskId],
    ['vendor', vendor],
    ['agentRunId', agentRunId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${name} is required`);
    }
  }

  const sessions = join(runDir(runId), 'sessions');
  const usage = readVendorUsage(vendor, sessions, agentRunId);
  if (!usage) {
    return;
  }

  appendUsageLog({
    time: now(),
    event: 'dispatch',
    run_id: runId,
    task_id: taskId,
    vendor,
    agent_run_id: agentRunId,
    cost_usd: usage.cost_usd,
    tokens_in: usage.tokens_in,
    tokens_out: usage.tokens_out,
  });

  ledgerAppend(
    runId,
    'agent_usage',
    'task_id', taskId,
    'vendor', vendor,
    'cost_usd', String(usage.cost_usd),
    'tokens_in', String(usage.tokens_in),
    'tokens_out', String(usage.tokens_out),
  );

  const runYaml = join(runDir(runId), 'run.yaml');
  const cap = existsSync(runYaml) ? yamlScalar(runYaml, 'manual_cap_usd') : '';
  if (cap) {
    const spent = sumUsageLogCost(usageLogPath());
    if (spent > Number(cap)) {
      ledgerAppend(
        runId,
        'budget_exceeded',
        'spent_usd', String(spent),
        'cap_usd', cap,
      );
      warn(`MANUAL CAP EXCEEDED: spent $${spent} > cap $${cap} (advisory)`);
    }
  }
}

export default {
  recordUsage,
  readVendorUsage,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskId, vendor, agentRunId] = args;
    if (!runId || !taskId || !vendor || !agentRunId) {
      die('usage: record-usage.sh <run_id> <task_id> <vendor> <agent_run_id>');
    }
    recordUsage(runId, taskId, vendor, agentRunId);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
