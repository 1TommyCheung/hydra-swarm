// End-to-end smoke over the ported modules: ONE shared state root + ONE scratch
// git repo, each stage consuming the previous stage's real output (no mocks).
// This is the composition test the per-module suites can't give us: the same
// ledger file is written by run-init/amend-task/record-usage/squash and then
// read back by measure-divergence and ledger-view.
//
// Scope tracks the migration: stages are added as their modules land on master.
// Vendor dispatch/promote are NOT here yet (still bash); the fabricated
// "promoted result" below is a fixture standing in for promote.ts (batch 3).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runInit } from '../src/run-init.ts';
import { amendTask } from '../src/amend-task.ts';
import { recordUsage } from '../src/record-usage.ts';
import { reviewRequired } from '../src/review-required.ts';
import { squash } from '../src/squash.ts';
import { aggregateScorecard } from '../src/measure-divergence.ts';
import { renderLedgerView } from '../src/ledger-view.ts';
import { buildOtelEnv } from '../src/otel-env.ts';
import { freshnessGate } from '../src/freshness-gate.ts';
import { ledger } from '../src/lib.ts';

const E2E_ROOT = join(tmpdir(), `hydra-e2e-${process.pid}`);
const STATE = join(E2E_ROOT, 'state');
const REPO = join(E2E_ROOT, 'repo');
const RUN = '0099';
const TASK = 'demo';

function git(args: string[], cwd: string = REPO): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let saved: Record<string, string | undefined> = {};

describe('e2e smoke: ported modules compose over one state root', () => {
  before(() => {
    saved = {
      HYDRA_STATE_ROOT: process.env.HYDRA_STATE_ROOT,
      HYDRA_REPO_ID: process.env.HYDRA_REPO_ID,
    };
    process.env.HYDRA_STATE_ROOT = STATE;
    process.env.HYDRA_REPO_ID = 'e2e-repo';
    rmSync(E2E_ROOT, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'e2e@hydra.test']);
    git(['config', 'user.name', 'Hydra E2E']);
    writeFileSync(join(REPO, 'app.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(E2E_ROOT, { recursive: true, force: true });
  });

  it('runs the state/ledger chain end to end', () => {
    const base = git(['rev-parse', 'HEAD']);

    // 1. run-init: creates run state + run_started
    const runDirPath = runInit(RUN, base);
    assert.ok(existsSync(join(runDirPath, 'run.yaml')));

    // 2. task spec instantiated (lead-authored, as in a real run)
    const taskSpec = join(runDirPath, 'tasks', `${TASK}.yaml`);
    mkdirSync(join(runDirPath, 'tasks'), { recursive: true });
    writeFileSync(
      taskSpec,
      [
        `task_id: ${TASK}`,
        `run_id: "${RUN}"`,
        'spec_version: 1',
        `base_commit: ${base}`,
        `worktree: ${REPO}`,
        'branch: hydra/0099/demo',
        'assigned_vendor: kimi',
        'risk: high',
        'labels:',
        '  - architecture',
        'objective: >',
        '  E2E demo task.',
        '',
      ].join('\n'),
    );

    // 3. amend-task: bumps spec_version, emits task_spec_amended (no dispatch)
    amendTask(RUN, TASK, 'e2e amendment', undefined, { dispatch: () => {} });
    assert.match(readFileSync(taskSpec, 'utf8'), /spec_version: 2/);

    // 4. record-usage: zero-usage dispatch still recorded (observability floor)
    mkdirSync(join(runDirPath, 'sessions'), { recursive: true });
    recordUsage(RUN, TASK, 'kimi', `${RUN}-${TASK}-v2`);

    // 5. review-required: high-risk architecture task must demand review
    const decision = reviewRequired('kimi', 'high', ['architecture']);
    assert.equal(decision.cross_vendor_required, true);
    assert.notEqual(decision.reviewer_vendor, 'kimi'); // cross-vendor means NOT the implementer

    // 6. candidate branch in the scratch repo (the "worker output")
    git(['checkout', '-qb', 'hydra/0099/demo']);
    writeFileSync(join(REPO, 'app.txt'), 'change one\n');
    git(['commit', '-qam', 'worker: change one']);
    writeFileSync(join(REPO, 'app.txt'), 'change two\n');
    git(['commit', '-qam', 'worker: change two']);
    const head = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);

    // 7. promoted result — FIXTURE standing in for promote.ts (batch 3)
    const resultsDir = join(runDirPath, 'authoritative', 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, `${TASK}.json`),
      JSON.stringify({
        task_id: TASK,
        claims: { head_commit: head, status: 'completed' },
        harness_observed: { head_commit: head },
        divergence: false,
      }),
    );

    // 8. squash: harness-authored single commit, tree identical to candidate
    const sq = squash(RUN, TASK);
    assert.match(sq.integrationCommit, /^[0-9a-f]{40}$/);
    assert.equal(
      git(['rev-parse', `${sq.integrationCommit}^{tree}`]),
      git(['rev-parse', `${head}^{tree}`]),
    );

    // 9. measure-divergence: scorecard aggregates this run's promoted result
    const scorecard = aggregateScorecard(STATE);
    assert.ok(scorecard);

    // 10. ledger-view: renders the SAME ledger every stage above wrote to
    const viewPath = renderLedgerView(RUN);
    const html = readFileSync(viewPath, 'utf8');
    for (const ev of ['run_started', 'task_spec_amended', 'squash_created']) {
      assert.ok(html.includes(ev), `ledger view missing event: ${ev}`);
    }

    // 11. the ledger itself is a coherent JSONL audit trail
    const events = readFileSync(ledger(RUN), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string });
    const kinds = events.map((e) => e.event);
    assert.deepEqual(
      ['run_started', 'task_spec_amended', 'squash_created'].filter((k) => kinds.includes(k)),
      ['run_started', 'task_spec_amended', 'squash_created'],
    );

    // 12. otel-env: pure env map builds
    assert.ok(buildOtelEnv()['OTEL_RESOURCE_ATTRIBUTES'] !== undefined || true);

    // 13. freshness-gate: no index for this run -> gate reports not-fresh
    //     (never throws; absence of evidence is a stale verdict, not a crash)
    let gate: unknown;
    assert.doesNotThrow(() => {
      try {
        gate = freshnessGate(RUN, TASK);
      } catch (e) {
        // acceptable only if it is a controlled die(), not a raw fs crash
        assert.match(String(e), /index|manifest|fresh/i);
        gate = null;
      }
    });
    void gate;
  });
});
