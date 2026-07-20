import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { recordUsage, readVendorUsage } from '../src/record-usage.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-record-usage');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupStateRoot(): string {
  const stateRoot = join(TEST_TMP, `state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.HYDRA_STATE_ROOT = stateRoot;
  return stateRoot;
}

function createRun(stateRoot: string, runId: string, cap?: number | string): void {
  const runDir = join(stateRoot, 'runs', `run-${runId}`);
  mkdirSync(join(runDir, 'sessions'), { recursive: true });
  mkdirSync(join(runDir, 'authoritative', 'ledger'), { recursive: true });
  if (cap !== undefined) {
    writeFileSync(join(runDir, 'run.yaml'), `manual_cap_usd: ${cap}\n`, 'utf8');
  }
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe('readVendorUsage', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('returns null when the vendor session file is missing', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    assert.equal(readVendorUsage('claude', sessions, 'no-such'), null);
    assert.equal(readVendorUsage('codex', sessions, 'no-such'), null);
    assert.equal(readVendorUsage('opencode', sessions, 'no-such'), null);
  });

  it('parses claude cli.json', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'abc.cli.json'),
      JSON.stringify({
        total_cost_usd: 0.0123,
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      'utf8',
    );
    assert.deepEqual(readVendorUsage('claude', sessions, 'abc'), {
      cost_usd: 0.0123,
      tokens_in: 10,
      tokens_out: 20,
    });
  });

  it('falls back to cost_usd for claude', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'abc.cli.json'),
      JSON.stringify({
        cost_usd: 0.0456,
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
      'utf8',
    );
    assert.deepEqual(readVendorUsage('claude', sessions, 'abc'), {
      cost_usd: 0.0456,
      tokens_in: 5,
      tokens_out: 6,
    });
  });

  it('omits zero-token zero-cost structured Claude non-runs', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'abc.cli.json'), JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
      result: 'API Error: Usage credits required ...', total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    assert.equal(readVendorUsage('claude', sessions, 'abc'), null);
  });

  it('takes the last token_count values from codex cli.jsonl', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const lines = [
      JSON.stringify({ token_count: { input_tokens: 1, output_tokens: 2 } }),
      JSON.stringify({ token_count: { input_tokens: 3, output_tokens: 4 } }),
      JSON.stringify({ token_count: { input_tokens: 5, output_tokens: 6 } }),
    ];
    writeFileSync(join(sessions, 'abc.cli.jsonl'), lines.join('\n') + '\n', 'utf8');
    assert.deepEqual(readVendorUsage('codex', sessions, 'abc'), {
      cost_usd: 0,
      tokens_in: 5,
      tokens_out: 6,
    });
  });

  it('returns all zeros when any codex JSONL line is malformed', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'abc.cli.jsonl'),
      `${JSON.stringify({ input_tokens: 10, output_tokens: 20 })}\nnot-json\n`,
      'utf8',
    );
    assert.deepEqual(readVendorUsage('codex', sessions, 'abc'), {
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
    });
  });

  it('parses CRLF-delimited codex cli.jsonl', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'abc.cli.jsonl'),
      `${JSON.stringify({ input_tokens: 1, output_tokens: 2 })}\r\n${JSON.stringify({ input_tokens: 3, output_tokens: 4 })}\r\n`,
      'utf8',
    );
    assert.deepEqual(readVendorUsage('codex', sessions, 'abc'), {
      cost_usd: 0,
      tokens_in: 3,
      tokens_out: 4,
    });
  });

  it('returns zero usage for an unknown vendor', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    assert.deepEqual(readVendorUsage('other', sessions, 'abc'), {
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
    });
  });

  it('parses opencode session.json', () => {
    const stateRoot = setupStateRoot();
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'abc.session.json'),
      JSON.stringify({
        cost: 0.0789,
        tokens: { input: 7, output: 8 },
      }),
      'utf8',
    );
    assert.deepEqual(readVendorUsage('opencode', sessions, 'abc'), {
      cost_usd: 0.0789,
      tokens_in: 7,
      tokens_out: 8,
    });
  });
});

describe('recordUsage', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('records a claude dispatch to usage.jsonl and the ledger', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'r1');
    const sessions = join(stateRoot, 'runs', 'run-r1', 'sessions');
    writeFileSync(
      join(sessions, 'agent-1.cli.json'),
      JSON.stringify({
        total_cost_usd: 0.001,
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
      'utf8',
    );

    recordUsage('r1', 'task-a', 'claude', 'agent-1');

    const usageLog = readJsonl(join(stateRoot, 'agents', 'usage.jsonl'));
    assert.equal(usageLog.length, 1);
    assert.equal(usageLog[0].event, 'dispatch');
    assert.equal(usageLog[0].run_id, 'r1');
    assert.equal(usageLog[0].task_id, 'task-a');
    assert.equal(usageLog[0].vendor, 'claude');
    assert.equal(usageLog[0].agent_run_id, 'agent-1');
    assert.equal(usageLog[0].cost_usd, 0.001);
    assert.equal(usageLog[0].tokens_in, 100);
    assert.equal(usageLog[0].tokens_out, 200);
    assert.match(String(usageLog[0].time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const ledger = readJsonl(join(stateRoot, 'runs', 'run-r1', 'authoritative', 'ledger', 'events.jsonl'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'agent_usage');
    assert.equal(ledger[0].run_id, 'r1');
    assert.equal(ledger[0].task_id, 'task-a');
    assert.equal(ledger[0].vendor, 'claude');
    assert.equal(ledger[0].cost_usd, '0.001');
    assert.equal(ledger[0].tokens_in, '100');
    assert.equal(ledger[0].tokens_out, '200');
  });

  it('does nothing when the vendor session file is missing', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'r2');
    recordUsage('r2', 'task-b', 'claude', 'missing-agent');
    assert.equal(existsSync(join(stateRoot, 'agents', 'usage.jsonl')), false);
    assert.equal(
      existsSync(join(stateRoot, 'runs', 'run-r2', 'authoritative', 'ledger', 'events.jsonl')),
      false,
    );
  });

  it('does not write agent_usage for a zero-token zero-cost Claude non-run', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'non-run');
    const sessions = join(stateRoot, 'runs', 'run-non-run', 'sessions');
    writeFileSync(join(sessions, 'agent-1.cli.json'), JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
      result: 'API Error: Usage credits required ...', total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }));

    recordUsage('non-run', 'task-a', 'claude', 'agent-1');

    assert.equal(existsSync(join(stateRoot, 'agents', 'usage.jsonl')), false);
    assert.deepEqual(readJsonl(join(
      stateRoot, 'runs', 'run-non-run', 'authoritative', 'ledger', 'events.jsonl',
    )), []);
  });

  it('records a zero-cost dispatch for an unknown vendor', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'unknown');

    recordUsage('unknown', 'task-unknown', 'other', 'agent-unknown');

    const usageLog = readJsonl(join(stateRoot, 'agents', 'usage.jsonl'));
    assert.equal(usageLog.length, 1);
    assert.equal(usageLog[0].vendor, 'other');
    assert.equal(usageLog[0].cost_usd, 0);
    assert.equal(usageLog[0].tokens_in, 0);
    assert.equal(usageLog[0].tokens_out, 0);

    const ledger = readJsonl(join(
      stateRoot,
      'runs',
      'run-unknown',
      'authoritative',
      'ledger',
      'events.jsonl',
    ));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'agent_usage');
  });

  it('rejects missing or empty required arguments before writing', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'args');

    assert.throws(
      () => recordUsage(undefined as unknown as string, 'task', 'claude', 'agent'),
      /runId is required/,
    );
    assert.throws(() => recordUsage('args', '', 'claude', 'agent'), /taskId is required/);
    assert.throws(() => recordUsage('args', 'task', '', 'agent'), /vendor is required/);
    assert.throws(() => recordUsage('args', 'task', 'claude', ''), /agentRunId is required/);
    assert.equal(existsSync(join(stateRoot, 'agents', 'usage.jsonl')), false);
  });

  it('emits a budget_exceeded event when the cap is exceeded', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'r3', 0.05);
    const sessions = join(stateRoot, 'runs', 'run-r3', 'sessions');
    writeFileSync(
      join(sessions, 'agent-1.cli.json'),
      JSON.stringify({ total_cost_usd: 0.04, usage: { input_tokens: 1, output_tokens: 1 } }),
      'utf8',
    );
    writeFileSync(
      join(sessions, 'agent-2.cli.json'),
      JSON.stringify({ total_cost_usd: 0.03, usage: { input_tokens: 1, output_tokens: 1 } }),
      'utf8',
    );

    recordUsage('r3', 'task-c', 'claude', 'agent-1');
    recordUsage('r3', 'task-c', 'claude', 'agent-2');

    const ledger = readJsonl(join(stateRoot, 'runs', 'run-r3', 'authoritative', 'ledger', 'events.jsonl'));
    assert.equal(ledger.length, 3);
    assert.equal(ledger[0].event, 'agent_usage');
    assert.equal(ledger[1].event, 'agent_usage');
    assert.equal(ledger[2].event, 'budget_exceeded');
    assert.equal(ledger[2].spent_usd, '0.07');
    assert.equal(ledger[2].cap_usd, '0.05');
  });

  it('does not emit budget_exceeded when under the cap', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'r4', 1.0);
    const sessions = join(stateRoot, 'runs', 'run-r4', 'sessions');
    writeFileSync(
      join(sessions, 'agent-1.cli.json'),
      JSON.stringify({ total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 } }),
      'utf8',
    );

    recordUsage('r4', 'task-d', 'claude', 'agent-1');

    const ledger = readJsonl(join(stateRoot, 'runs', 'run-r4', 'authoritative', 'ledger', 'events.jsonl'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'agent_usage');
  });

  it('handles a pre-existing empty usage.jsonl during the cap check', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'empty-log', 0);
    mkdirSync(join(stateRoot, 'agents'), { recursive: true });
    writeFileSync(join(stateRoot, 'agents', 'usage.jsonl'), '', 'utf8');
    writeFileSync(
      join(stateRoot, 'runs', 'run-empty-log', 'sessions', 'agent.cli.jsonl'),
      '',
      'utf8',
    );

    recordUsage('empty-log', 'task-empty', 'codex', 'agent');

    const usageLog = readJsonl(join(stateRoot, 'agents', 'usage.jsonl'));
    assert.equal(usageLog.length, 1);
    assert.equal(usageLog[0].cost_usd, 0);
    const ledger = readJsonl(join(
      stateRoot,
      'runs',
      'run-empty-log',
      'authoritative',
      'ledger',
      'events.jsonl',
    ));
    assert.deepEqual(ledger.map((entry) => entry.event), ['agent_usage']);
  });

  it('honours a quoted YAML cap value', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'quoted-cap', '"0.05"');
    writeFileSync(
      join(stateRoot, 'runs', 'run-quoted-cap', 'sessions', 'agent.cli.json'),
      JSON.stringify({ total_cost_usd: 0.06 }),
      'utf8',
    );

    recordUsage('quoted-cap', 'task-quoted', 'claude', 'agent');

    const ledger = readJsonl(join(
      stateRoot,
      'runs',
      'run-quoted-cap',
      'authoritative',
      'ledger',
      'events.jsonl',
    ));
    assert.deepEqual(ledger.map((entry) => entry.event), ['agent_usage', 'budget_exceeded']);
    assert.equal(ledger[1].cap_usd, '0.05');
  });

  it('does not exceed the cap when spent equals the cap', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'equal-cap', 0.05);
    writeFileSync(
      join(stateRoot, 'runs', 'run-equal-cap', 'sessions', 'agent.cli.json'),
      JSON.stringify({ total_cost_usd: 0.05 }),
      'utf8',
    );

    recordUsage('equal-cap', 'task-equal', 'claude', 'agent');

    const ledger = readJsonl(join(
      stateRoot,
      'runs',
      'run-equal-cap',
      'authoritative',
      'ledger',
      'events.jsonl',
    ));
    assert.deepEqual(ledger.map((entry) => entry.event), ['agent_usage']);
  });

  it('sums the shared usage log across runs for cap enforcement', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'prior');
    createRun(stateRoot, 'current', 0.05);
    writeFileSync(
      join(stateRoot, 'runs', 'run-prior', 'sessions', 'agent.cli.json'),
      JSON.stringify({ total_cost_usd: 0.04 }),
      'utf8',
    );
    writeFileSync(
      join(stateRoot, 'runs', 'run-current', 'sessions', 'agent.cli.json'),
      JSON.stringify({ total_cost_usd: 0.02 }),
      'utf8',
    );

    recordUsage('prior', 'task-prior', 'claude', 'agent');
    recordUsage('current', 'task-current', 'claude', 'agent');

    const ledger = readJsonl(join(
      stateRoot,
      'runs',
      'run-current',
      'authoritative',
      'ledger',
      'events.jsonl',
    ));
    assert.deepEqual(ledger.map((entry) => entry.event), ['agent_usage', 'budget_exceeded']);
    assert.equal(ledger[1].spent_usd, '0.06');
  });

  it('matches awk by not treating a non-numeric cap as numeric zero', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'text-cap', 'abc');
    writeFileSync(
      join(stateRoot, 'runs', 'run-text-cap', 'sessions', 'agent.cli.json'),
      JSON.stringify({ total_cost_usd: 1 }),
      'utf8',
    );

    recordUsage('text-cap', 'task-text', 'claude', 'agent');

    const ledger = readJsonl(join(
      stateRoot,
      'runs',
      'run-text-cap',
      'authoritative',
      'ledger',
      'events.jsonl',
    ));
    assert.deepEqual(ledger.map((entry) => entry.event), ['agent_usage']);
  });

  it('treats numeric strings as numbers', () => {
    const stateRoot = setupStateRoot();
    createRun(stateRoot, 'r5');
    const sessions = join(stateRoot, 'runs', 'run-r5', 'sessions');
    writeFileSync(
      join(sessions, 'agent-1.session.json'),
      JSON.stringify({ cost: '0.5', tokens: { input: '42', output: '99' } }),
      'utf8',
    );

    recordUsage('r5', 'task-e', 'opencode', 'agent-1');

    const usageLog = readJsonl(join(stateRoot, 'agents', 'usage.jsonl'));
    assert.equal(usageLog[0].cost_usd, 0.5);
    assert.equal(usageLog[0].tokens_in, 42);
    assert.equal(usageLog[0].tokens_out, 99);
  });
});
