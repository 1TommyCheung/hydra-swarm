import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  computeSignal,
  countFlows,
  graphImpact,
  GraphImpactError,
  stripAnsi,
} from '../src/graph-impact.ts';
import { runDir } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-graph-impact');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupRun(
  runId: string,
  taskId: string,
  overrides: { baseCommit?: string; worktree?: string } = {},
): { runId: string; taskId: string } {
  const rDir = runDir(runId);
  const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);
  const worktree = overrides.worktree ?? join(TEST_TMP, uniqueName('worktree'));
  mkdirSync(dirname(taskSpec), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(
    taskSpec,
    `worktree: ${worktree}\nbase_commit: ${overrides.baseCommit ?? 'base123'}\n`,
    'utf8',
  );
  return { runId, taskId };
}

function writeFreshnessGate(exitCode: number): string {
  const path = join(TEST_TMP, `freshness-gate-${uniqueName('gate')}.sh`);
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return path;
}

function writeGitnexus(
  output: string,
  exitCode = 0,
  stderrOutput = '',
): string {
  const path = join(TEST_TMP, `gitnexus-${uniqueName('cli')}`);
  const outputPath = join(TEST_TMP, `gitnexus-output-${uniqueName('out')}.txt`);
  const stderrPath = join(TEST_TMP, `gitnexus-stderr-${uniqueName('err')}.txt`);
  writeFileSync(outputPath, output, 'utf8');
  writeFileSync(stderrPath, stderrOutput, 'utf8');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\ncat ${outputPath}\ncat ${stderrPath} >&2\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return path;
}

function ledgerEvents(runId: string): Array<Record<string, unknown>> {
  const ledgerPath = join(runDir(runId), 'authoritative', 'ledger', 'events.jsonl');
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('graphImpact helpers', () => {
  it('strips ANSI escape codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
    assert.equal(stripAnsi('no ansi'), 'no ansi');
  });

  it('counts flow-related lines case-insensitively', () => {
    assert.equal(countFlows('one flow\ntwo FLOW\nthree'), 2);
    assert.equal(countFlows('process\naffected\ncaller'), 3);
    assert.equal(countFlows('nothing here'), 0);
  });

  it('counts header lines that contain keywords', () => {
    assert.equal(
      countFlows(
        '# Graph impact (RISK INPUT — advisory, never blocking) — task\n## Changed symbols & affected execution flows',
      ),
      1,
    );
  });

  it('computes signal thresholds', () => {
    assert.equal(computeSignal(0), 'low');
    assert.equal(computeSignal(4), 'low');
    assert.equal(computeSignal(5), 'medium');
    assert.equal(computeSignal(14), 'medium');
    assert.equal(computeSignal(15), 'high');
  });
});

describe('graphImpact', () => {
  let originalStateRoot: string | undefined;

  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    originalStateRoot = process.env.HYDRA_STATE_ROOT;
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });
  after(() => {
    cleanTmp();
    if (originalStateRoot === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = originalStateRoot;
    }
  });

  it('throws when task spec is missing', () => {
    const gitnexus = writeGitnexus('');
    assert.throws(
      () =>
        graphImpact(uniqueName('run'), uniqueName('task'), {
          gitnexusPath: gitnexus,
        }),
      /hydra: error: task spec not found/,
    );
  });

  it('validates a custom gitnexus command', () => {
    assert.throws(
      () =>
        graphImpact(uniqueName('run'), uniqueName('task'), {
          gitnexusPath: join(TEST_TMP, 'nonexistent-gitnexus'),
        }),
      /hydra: error: gitnexus CLI not found/,
    );
  });

  it('omits evidence and exits 8 when freshness gate fails', () => {
    const { runId, taskId } = setupRun(uniqueName('run'), uniqueName('task'));
    const gate = writeFreshnessGate(8);
    const gitnexus = writeGitnexus('');
    assert.throws(
      () =>
        graphImpact(runId, taskId, {
          freshnessGatePath: gate,
          gitnexusPath: gitnexus,
        }),
      (err: unknown) =>
        err instanceof GraphImpactError && err.exitCode === 8,
    );

    const events = ledgerEvents(runId);
    const staleEvent = events.find((e) => e.status === 'stale_omitted');
    assert.ok(staleEvent, 'expected stale_omitted ledger event');
    assert.equal(staleEvent.advisory, 'true');
    assert.equal(staleEvent.task_id, taskId);
  });

  it('generates a report with gitnexus output and advisory signal', () => {
    const { runId, taskId } = setupRun(uniqueName('run'), uniqueName('task'));
    const gate = writeFreshnessGate(0);
    const gitnexus = writeGitnexus(
      'changed flow A\naffected caller B\nprocess C',
    );
    const reportPath = graphImpact(runId, taskId, {
      freshnessGatePath: gate,
      gitnexusPath: gitnexus,
    });

    assert.ok(existsSync(reportPath));
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Graph impact/);
    assert.match(report, /changed flow A/);
    assert.match(report, /affected caller B/);
    assert.match(report, /process C/);
    assert.ok(report.endsWith('\n'), 'expected report to end with a newline');

    const events = ledgerEvents(runId);
    const okEvent = events.find((e) => e.status === 'ok');
    assert.ok(okEvent, 'expected ok ledger event');
    assert.equal(okEvent.signal, 'low');
    assert.equal(okEvent.advisory, 'true');
    assert.equal(okEvent.task_id, taskId);
  });

  it('includes gitnexus stderr in the report', () => {
    const { runId, taskId } = setupRun(uniqueName('run'), uniqueName('task'));
    const gate = writeFreshnessGate(0);
    const gitnexus = writeGitnexus('stdout flow\n', 0, 'stderr diagnostic\n');
    const reportPath = graphImpact(runId, taskId, {
      freshnessGatePath: gate,
      gitnexusPath: gitnexus,
    });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /stdout flow/);
    assert.match(report, /stderr diagnostic/);
  });

  it('uses fallback output when gitnexus fails', () => {
    const { runId, taskId } = setupRun(uniqueName('run'), uniqueName('task'));
    const gate = writeFreshnessGate(0);
    const gitnexus = writeGitnexus('irrelevant', 1);
    const reportPath = graphImpact(runId, taskId, {
      freshnessGatePath: gate,
      gitnexusPath: gitnexus,
    });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /irrelevant/);
    assert.match(report, /detect-changes produced no output/);
  });

  it('limits output to 80 lines', () => {
    const { runId, taskId } = setupRun(uniqueName('run'), uniqueName('task'));
    const gate = writeFreshnessGate(0);
    const longOutput = Array.from(
      { length: 100 },
      (_, i) => `line ${i} flow`,
    ).join('\n');
    const gitnexus = writeGitnexus(longOutput);
    const reportPath = graphImpact(runId, taskId, {
      freshnessGatePath: gate,
      gitnexusPath: gitnexus,
    });
    const report = readFileSync(reportPath, 'utf8');
    const match = report.match(/```\n([\s\S]*?)\n```/);
    assert.ok(match, 'expected code block in report');
    const codeBlock = match[1];
    assert.equal(codeBlock.split('\n').length, 80);
  });

  it('strips ANSI codes from gitnexus output', () => {
    const { runId, taskId } = setupRun(uniqueName('run'), uniqueName('task'));
    const gate = writeFreshnessGate(0);
    const gitnexus = writeGitnexus('\x1b[31mred flow\x1b[0m');
    const reportPath = graphImpact(runId, taskId, {
      freshnessGatePath: gate,
      gitnexusPath: gitnexus,
    });
    const report = readFileSync(reportPath, 'utf8');
    assert.doesNotMatch(report, /\x1b\[/);
    assert.match(report, /red flow/);
  });

  it('computes medium and high signals based on flow count', () => {
    const mediumRun = setupRun(uniqueName('run'), uniqueName('task'));
    const mediumGitnexus = writeGitnexus(
      Array.from({ length: 5 }, (_, i) => `flow ${i}`).join('\n'),
    );
    graphImpact(mediumRun.runId, mediumRun.taskId, {
      freshnessGatePath: writeFreshnessGate(0),
      gitnexusPath: mediumGitnexus,
    });
    let events = ledgerEvents(mediumRun.runId);
    assert.equal(events.find((e) => e.status === 'ok')?.signal, 'medium');

    const highRun = setupRun(uniqueName('run'), uniqueName('task'));
    const highGitnexus = writeGitnexus(
      Array.from({ length: 15 }, (_, i) => `affected ${i}`).join('\n'),
    );
    graphImpact(highRun.runId, highRun.taskId, {
      freshnessGatePath: writeFreshnessGate(0),
      gitnexusPath: highGitnexus,
    });
    events = ledgerEvents(highRun.runId);
    assert.equal(events.find((e) => e.status === 'ok')?.signal, 'high');
  });
});
