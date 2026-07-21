import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const TEST_TMP = join(tmpdir(), `hydra-status-sh-${process.pid}`);
const STATUS_SH = join(import.meta.dirname, '../../hydra/scripts/status.sh');

/**
 * Launcher-routing coverage for the `status` wrapper. The shell-adapter/bash
 * body lane was retired in run 0045 (docs/bash-lane-retirement-plan.md); these
 * cases verify the wrapper routes to the TypeScript implementation (`ts`,
 * the default) and to a pinned compiled binary (`bin`) with the documented
 * argv and BUN_BE_BUN hygiene. The retired-`bash` and unrecognized-value
 * rejections are exercised at the dispatch layer in dispatch.test.ts.
 */

interface Fixture {
  runId: string;
  stateRoot: string;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fixture(id: string): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const taskSpecPath = join(runDir, 'tasks', 'task-a.yaml');
  const ledgerPath = join(runDir, 'authoritative', 'ledger', 'events.jsonl');
  const worktree = join(TEST_TMP, id, 'worktree');

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(taskSpecPath, [
    'task_id: task-a',
    `run_id: ${id}`,
    'assigned_vendor: claude',
    `worktree: ${worktree}`,
    'timeout_minutes: 45',
    'spec_version: 1',
    `branch: hydra/${id}/task-a`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));
  const agentRunId = `${id}-task-a-v1`;
  writeFileSync(ledgerPath, [
    `${JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: id, task_id: 'task-a', vendor: 'claude', agent_run_id: agentRunId })}\n`,
    `${JSON.stringify({ time: '2024-01-01T00:01:00Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'claude', exit_code: '0' })}\n`,
  ].join(''));

  return { runId: id, stateRoot };
}

interface StatusJson {
  state: string;
  agent_run_id: string;
  ledger_events: Array<Record<string, unknown>>;
}

/**
 * Launcher-parity comparison that excludes only the wall-clock-derived
 * `elapsed_seconds` field. The two routes are spawned sequentially, so their
 * observations of "now" can straddle a one-second boundary; comparing the
 * complete JSON strings then fails on a one-second elapsed_seconds difference
 * even though both routes are byte-identical in every other field.
 *
 * The clock field is NOT ignored: each value must be a finite, non-negative
 * number, and the pair may differ by no more than `maxClockDeltaSeconds` —
 * the real interval between the two sequential observations. Every other
 * field is strict deep-equality checked, so a route that diverges anywhere
 * else still fails.
 */
function assertLauncherParity(
  tsStdout: string,
  unsetStdout: string,
  maxClockDeltaSeconds: number,
): void {
  const tsJson = JSON.parse(tsStdout) as Record<string, unknown>;
  const unsetJson = JSON.parse(unsetStdout) as Record<string, unknown>;

  const elapsedValues: number[] = [];
  for (const [label, doc] of [['ts', tsJson], ['unset', unsetJson]] as const) {
    const elapsed = doc.elapsed_seconds;
    if (typeof elapsed !== 'number') {
      assert.fail(`${label} route: elapsed_seconds must be a number, got ${String(elapsed)}`);
    }
    assert.equal(Number.isFinite(elapsed), true, `${label} route: elapsed_seconds must be finite`);
    assert.ok(elapsed >= 0, `${label} route: elapsed_seconds must be non-negative, got ${elapsed}`);
    elapsedValues.push(elapsed);
  }
  const clockDelta = Math.abs(elapsedValues[0] - elapsedValues[1]);
  assert.ok(
    clockDelta <= maxClockDeltaSeconds,
    `elapsed_seconds differs by ${clockDelta}s, beyond the sequential observation interval of ${maxClockDeltaSeconds}s`,
  );

  const stripClock = (doc: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...doc };
    delete copy.elapsed_seconds;
    return copy;
  };
  assert.deepEqual(
    stripClock(unsetJson),
    stripClock(tsJson),
    'unset HYDRA_HARNESS must route identically to ts in every non-clock field',
  );
}

describe('status.sh launcher routing', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('routes the default/ts path to the TypeScript implementation and reports ledger state', () => {
    const f = fixture(uniqueRunId('ts'));

    // unset HYDRA_HARNESS == ts (the default). The wrapper must exec
    // node --experimental-strip-types cli.ts status, producing real JSON.
    const result = spawnSync(
      'bash',
      [STATUS_SH, f.runId, 'task-a', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HYDRA_HARNESS: 'ts',
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_REPO_ID: `test-${f.runId}`,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `ts route exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    const json = JSON.parse(result.stdout) as StatusJson;
    assert.equal(json.state, 'completed');
    assert.equal(json.agent_run_id, `${f.runId}-task-a-v1`);
    assert.deepEqual(
      json.ledger_events.map(({ event }) => event),
      ['task_started', 'agent_exited'],
    );
  });

  it('routes the bin path to a pinned HYDRA_BIN with the status subcommand and original argv', () => {
    const f = fixture(uniqueRunId('bin'));
    const record = join(TEST_TMP, f.runId, 'fake-bin.record');
    const fakeBin = join(TEST_TMP, f.runId, 'fake-hydra-cli');
    mkdirSync(dirname(fakeBin), { recursive: true });
    // The fake binary records the argv it received and whether BUN_BE_BUN
    // survived into its environment, then exits 0. The wrapper execs it via
    // `env -u BUN_BE_BUN <HYDRA_BIN> status "$@"`.
    writeFileSync(fakeBin, [
      '#!/usr/bin/env bash',
      '{',
      '  printf \'argv:\';',
      '  for a in "$@"; do printf \' %s\' "$a"; done',
      '  printf \'\\n\'',
      '  if [ -n "${BUN_BE_BUN+x}" ]; then printf \'BUN_BE_BUN=set\\n\';',
      '  else printf \'BUN_BE_BUN=unset\\n\'; fi',
      '} >"$HYDRA_FAKE_BIN_RECORD"',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(fakeBin, 0o755);

    const result = spawnSync(
      'bash',
      [STATUS_SH, f.runId, 'task-a', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          // bin selects the compiled-binary launcher path.
          HYDRA_HARNESS: 'bin',
          // The pinned absolute, regular, executable rollback artifact.
          HYDRA_BIN: fakeBin,
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_REPO_ID: `test-${f.runId}`,
          HYDRA_FAKE_BIN_RECORD: record,
          // BUN_BE_BUN must be stripped at the exec boundary even if present.
          BUN_BE_BUN: '1',
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `bin route exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.equal(existsSync(record), true, 'the pinned binary must actually be exec\'d');
    const captured = readFileSync(record, 'utf8');
    assert.equal(captured.includes(`argv: status ${f.runId} task-a --json`), true, `bin argv mismatch: ${captured}`);
    assert.equal(captured.includes('BUN_BE_BUN=unset'), true, `BUN_BE_BUN must be stripped at the bin exec: ${captured}`);
  });

  it('treats an unset HYDRA_HARNESS identically to ts (the source default)', () => {
    const f = fixture(uniqueRunId('unset'));
    const tsEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HYDRA_HARNESS: 'ts',
      HYDRA_STATE_ROOT: f.stateRoot,
      HYDRA_REPO_ID: `test-${f.runId}`,
    };
    // A genuinely-unset HYDRA_HARNESS: drop any value inherited from the
    // parent shell so the wrapper sees the default-ts branch regardless of
    // the environment running this suite.
    const unsetEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HYDRA_STATE_ROOT: f.stateRoot,
      HYDRA_REPO_ID: `test-${f.runId}`,
    };
    delete unsetEnv.HYDRA_HARNESS;
    // Time both spawns: each route derives elapsed_seconds from its own
    // observation of the wall clock, so their values may legitimately differ
    // by the interval between the two observations (plus one second of
    // floor() quantization) — but by no more.
    const startMs = Date.now();
    const explicit = spawnSync('bash', [STATUS_SH, f.runId, 'task-a', '--json'], { encoding: 'utf8', env: tsEnv });
    const unset = spawnSync('bash', [STATUS_SH, f.runId, 'task-a', '--json'], { encoding: 'utf8', env: unsetEnv });
    const maxClockDeltaSeconds = Math.ceil((Date.now() - startMs) / 1000) + 1;
    assert.equal(unset.status, 0, `unset route failed: ${unset.stderr}`);
    assert.equal(explicit.status, 0, `ts route failed: ${explicit.stderr}`);
    assertLauncherParity(explicit.stdout, unset.stdout, maxClockDeltaSeconds);
  });

  it('parity normalization cannot hide differences outside the clock field', () => {
    const base = {
      state: 'completed',
      agent_run_id: 'run-x-task-a-v1',
      vendor: 'claude',
      elapsed_seconds: 100,
      timeout_minutes: 45,
      ledger_events: [{ event: 'task_started' }, { event: 'agent_exited' }],
    };
    const baseOut = JSON.stringify(base);

    // In-bound clock drift with otherwise identical documents passes.
    assert.doesNotThrow(() => assertLauncherParity(
      baseOut,
      JSON.stringify({ ...base, elapsed_seconds: 101 }),
      2,
    ));

    // A difference in any non-clock field still fails the parity check.
    assert.throws(
      () => assertLauncherParity(baseOut, JSON.stringify({ ...base, state: 'failed' }), 2),
      /non-clock field/,
    );

    // Clock drift beyond the sequential observation interval still fails.
    assert.throws(
      () => assertLauncherParity(baseOut, JSON.stringify({ ...base, elapsed_seconds: 200 }), 2),
      /elapsed_seconds differs by/,
    );

    // A route that stops reporting elapsed_seconds altogether still fails.
    const missing: Record<string, unknown> = { ...base };
    delete missing.elapsed_seconds;
    assert.throws(
      () => assertLauncherParity(baseOut, JSON.stringify(missing), 2),
      /elapsed_seconds must be a number/,
    );
  });
});
