import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  main,
  promote,
  type PromoteOptions,
} from '../src/promote.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-promote');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  mkdirSync(p, { recursive: true });
  return p;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function worktreeEntriesOutsideTestTmp(): string[] {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const entries: string[] = [];

  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === TEST_TMP) continue;
      entries.push(relative(top, path));
      if (entry.isDirectory()) visit(path);
    }
  }

  visit(top);
  return entries.sort();
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
}

function commitFile(dir: string, filename: string, content: string): string {
  const fullPath = join(dir, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  execFileSync('git', ['-C', dir, 'add', filename], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', `add ${filename}`], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function modifyFile(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf8');
}

function stageAll(dir: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8', stdio: 'ignore' });
}

function commit(dir: string, message: string): string {
  execFileSync('git', ['-C', dir, 'commit', '-m', message], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function readJsonl(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

interface Fixture {
  runId: string;
  taskId: string;
  stateRoot: string;
  worktree: string;
  base: string;
  head: string;
  branch: string;
  taskSpec: string;
  drop: string;
  schema: string;
  verifyPolicy: string;
  writable: string[];
}

function makeFixture(overrides: Partial<Fixture> = {}): Fixture {
  const runId = overrides.runId ?? uniqueName('run');
  const taskId = overrides.taskId ?? 'task-ts';
  const dir = makeTempDir('fixture');
  const stateRoot = join(dir, 'state');
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  initGitRepo(worktree);

  const branch = 'hydra/test-branch';
  execFileSync('git', ['-C', worktree, 'checkout', '-b', branch], {
    encoding: 'utf8',
    stdio: 'ignore',
  });

  const base = commitFile(worktree, 'src/app.ts', 'base');
  modifyFile(worktree, 'src/app.ts', 'changed');
  stageAll(worktree);
  const head = commit(worktree, 'modify app');

  const rDir = join(stateRoot, 'runs', `run-${runId}`);
  const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);
  mkdirSync(dirname(taskSpec), { recursive: true });
  writeFileSync(
    taskSpec,
    `task_id: ${taskId}
run_id: ${runId}
spec_version: 1
worktree: ${worktree}
branch: ${branch}
base_commit: ${base}
writable_paths:
  - src/**
`,
    'utf8',
  );

  const drop = join(dir, 'inbox_result.json');
  writeFileSync(
    drop,
    JSON.stringify({
      task_id: taskId,
      run_id: runId,
      spec_version: 1,
      vendor: 'claude',
      status: 'completed',
      branch,
      base_commit: base,
      head_commit: head,
      summary: 'test result',
      files_changed: ['src/app.ts'],
      verification_claims: [{ command: 'test pass', status: 'passed' }],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    }),
    'utf8',
  );

  const schema = join(dir, 'result.schema.json');
  writeFileSync(schema, JSON.stringify({
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": [
      "task_id", "run_id", "spec_version", "vendor", "status", "branch",
      "base_commit", "head_commit", "files_changed", "verification_claims"
    ],
    "properties": {
      "task_id": { "type": "string" },
      "run_id": { "type": "string" },
      "spec_version": { "type": "integer" },
      "vendor": { "type": "string", "enum": ["claude", "codex", "opencode", "kimi"] },
      "status": { "type": "string", "enum": ["completed", "blocked", "failed"] },
      "branch": { "type": "string" },
      "base_commit": { "type": "string" },
      "head_commit": { "type": "string" },
      "files_changed": { "type": "array", "items": { "type": "string" } },
      "verification_claims": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["command", "status"],
          "properties": {
            "command": { "type": "string" },
            "status": { "type": "string", "enum": ["passed", "failed", "timed_out", "skipped"] }
          }
        }
      }
    }
  }), 'utf8');

  const verifyPolicy = join(dir, 'verification.yaml');
  writeFileSync(
    verifyPolicy,
    `commands:
  - test pass
`,
    'utf8',
  );

  return {
    runId,
    taskId,
    stateRoot,
    worktree,
    base,
    head,
    branch,
    taskSpec,
    drop,
    schema,
    verifyPolicy,
    writable: ['src/**'],
    ...overrides,
  };
}

function baseOptions(fixture: Fixture): PromoteOptions {
  return {
    cwd: process.cwd(),
    stateRoot: fixture.stateRoot,
    schema: fixture.schema,
    verifyPolicy: fixture.verifyPolicy,
    audit: () => ({ clean: true, violations: [] }),
    verify: async (_worktree, _policy, out) => {
      const observed = [{ command: 'test pass', status: 'passed' as const }];
      assert.ok(out);
      writeFileSync(out, `${JSON.stringify(observed)}\n`, 'utf8');
      return observed;
    },
  };
}

function assertRejected(error: unknown, reason: string): void {
  assert.ok(error instanceof Error, 'expected an Error');
  assert.match(error.message, new RegExp(reason));
  assert.equal((error as { code?: number }).code, 5);
}

function ledgerPath(stateRoot: string, runId: string): string {
  return join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
}

describe('promote', () => {
  const savedStateRoot = process.env.HYDRA_STATE_ROOT;
  const initialOutsideEntries = worktreeEntriesOutsideTestTmp();

  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });
  after(() => {
    cleanTmp();
    if (savedStateRoot === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = savedStateRoot;
    }
  });

  it('throws on missing arguments', async () => {
    for (const args of [
      ['', 'task', 'drop.json'],
      ['run', '', 'drop.json'],
      ['run', 'task', ''],
    ]) {
      await assert.rejects(
        promote(args[0], args[1], args[2]),
        (error: any) => error?.code === 2 && /usage/.test(error.message),
      );
    }

    assert.equal(await main([]), 2);
  });

  it('throws when drop, task spec, or schema is missing', async () => {
    const f = makeFixture();
    const missingDrop = join(f.stateRoot, 'missing.json');
    await assert.rejects(
      promote(f.runId, f.taskId, missingDrop, baseOptions(f)),
      /inbox drop not found/,
    );
  });

  it('rejects an invalid JSON drop', async () => {
    const f = makeFixture();
    writeFileSync(f.drop, '{ not json', 'utf8');
    await assert.rejects(
      promote(f.runId, f.taskId, f.drop, baseOptions(f)),
      /schema_invalid|inbox drop is not valid JSON/,
    );
  });

  it('rejects schema_invalid when required fields are missing', async () => {
    const f = makeFixture();
    writeFileSync(f.drop, JSON.stringify({ task_id: f.taskId }), 'utf8');

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'schema_invalid');
    }
  });

  it('rejects stale_spec when claimed spec_version differs', async () => {
    const f = makeFixture();
    writeFileSync(
      f.drop,
      JSON.stringify({
        task_id: f.taskId,
        run_id: f.runId,
        spec_version: 0,
        vendor: 'claude',
        status: 'completed',
        branch: f.branch,
        base_commit: f.base,
        head_commit: f.head,
        files_changed: ['src/app.ts'],
        verification_claims: [],
      }),
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'stale_spec');
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.event === 'result_rejected' && ev.reason === 'stale_spec'));
  });

  it('rejects not_completed when status is not completed', async () => {
    const f = makeFixture();
    writeFileSync(
      f.drop,
      JSON.stringify({
        task_id: f.taskId,
        run_id: f.runId,
        spec_version: 1,
        vendor: 'claude',
        status: 'blocked',
        branch: f.branch,
        base_commit: f.base,
        head_commit: f.head,
        files_changed: ['src/app.ts'],
        verification_claims: [],
      }),
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'not_completed');
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.event === 'result_rejected' && ev.reason === 'not_completed'));
  });

  it('rejects git_evidence when worktree is missing', async () => {
    const f = makeFixture();
    const badWorktree = join(f.stateRoot, 'no-such-worktree');
    writeFileSync(
      f.taskSpec,
      `task_id: ${f.taskId}
run_id: ${f.runId}
spec_version: 1
worktree: ${badWorktree}
branch: ${f.branch}
base_commit: ${f.base}
writable_paths:
  - src/**
`,
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }
  });

  it('rejects git_evidence when worktree is not a git repo', async () => {
    const f = makeFixture();
    const badWorktree = mkdtempSync(join(tmpdir(), 'hydra-promote-not-git-'));
    try {
      writeFileSync(
        f.taskSpec,
        `task_id: ${f.taskId}
run_id: ${f.runId}
spec_version: 1
worktree: ${badWorktree}
branch: ${f.branch}
base_commit: ${f.base}
writable_paths:
  - src/**
`,
        'utf8',
      );

      await assert.rejects(
        promote(f.runId, f.taskId, f.drop, baseOptions(f)),
        (error: any) => error?.reason === 'git_evidence'
          && /not a git worktree/.test(error.message),
      );
    } finally {
      rmSync(badWorktree, { recursive: true, force: true });
    }
  });

  it('rejects git_evidence when claimed head does not exist', async () => {
    const f = makeFixture();
    writeFileSync(
      f.drop,
      JSON.stringify({
        task_id: f.taskId,
        run_id: f.runId,
        spec_version: 1,
        vendor: 'claude',
        status: 'completed',
        branch: f.branch,
        base_commit: f.base,
        head_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        files_changed: ['src/app.ts'],
        verification_claims: [],
      }),
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }
  });

  it('rejects git_evidence when base does not exist', async () => {
    const f = makeFixture();
    const badBase = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    writeFileSync(
      f.taskSpec,
      `task_id: ${f.taskId}
run_id: ${f.runId}
spec_version: 1
worktree: ${f.worktree}
branch: ${f.branch}
base_commit: ${badBase}
writable_paths:
  - src/**
`,
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }
  });

  it('rejects git_evidence when head does not descend from base', async () => {
    const f = makeFixture();
    // Create a divergent branch not containing base.
    execFileSync('git', ['-C', f.worktree, 'checkout', '--orphan', 'orphan'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    writeFileSync(join(f.worktree, 'orphan.ts'), 'x', 'utf8');
    stageAll(f.worktree);
    const orphanHead = commit(f.worktree, 'orphan commit');

    writeFileSync(
      f.drop,
      JSON.stringify({
        task_id: f.taskId,
        run_id: f.runId,
        spec_version: 1,
        vendor: 'claude',
        status: 'completed',
        branch: 'orphan',
        base_commit: f.base,
        head_commit: orphanHead,
        files_changed: ['orphan.ts'],
        verification_claims: [],
      }),
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }
  });

  it('rejects git_evidence when branch does not exist', async () => {
    const f = makeFixture();
    writeFileSync(
      f.taskSpec,
      `task_id: ${f.taskId}
run_id: ${f.runId}
spec_version: 1
worktree: ${f.worktree}
branch: no-such-branch
base_commit: ${f.base}
writable_paths:
  - src/**
`,
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.reason === 'git_evidence' && /branch does not exist/.test(ev.detail)));
  });

  it('rejects git_evidence when branch head does not match claimed head', async () => {
    const f = makeFixture();
    // Add another commit so branch head differs from claimed head.
    modifyFile(f.worktree, 'src/app.ts', 'more changes');
    stageAll(f.worktree);
    commit(f.worktree, 'second commit');

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    const rejection = events.find((ev) => ev.event === 'result_rejected');
    assert.equal(rejection?.task_id, f.taskId);
    assert.equal(rejection?.reason, 'git_evidence');
    assert.match(rejection?.detail ?? '', /head .* != claimed head/);
  });

  it('rejects git_evidence when worktree has uncommitted tracked changes', async () => {
    const f = makeFixture();
    modifyFile(f.worktree, 'src/app.ts', 'uncommitted');

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'git_evidence');
    }
  });

  it('rejects no_commit when head equals base', async () => {
    const f = makeFixture();
    const emptyBranch = 'hydra/empty-at-base';
    execFileSync('git', ['-C', f.worktree, 'branch', emptyBranch, f.base], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    writeFileSync(
      f.taskSpec,
      `task_id: ${f.taskId}
run_id: ${f.runId}
spec_version: 1
worktree: ${f.worktree}
branch: ${emptyBranch}
base_commit: ${f.base}
writable_paths:
  - src/**
`,
      'utf8',
    );
    writeFileSync(
      f.drop,
      JSON.stringify({
        task_id: f.taskId,
        run_id: f.runId,
        spec_version: 1,
        vendor: 'claude',
        status: 'completed',
        branch: emptyBranch,
        base_commit: f.base,
        head_commit: f.base,
        files_changed: [],
        verification_claims: [],
      }),
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'no_commit');
    }
  });

  it('rejects no_commit when diff is empty', async () => {
    const f = makeFixture();
    const emptyBranch = 'hydra/empty-diff';
    execFileSync('git', ['-C', f.worktree, 'checkout', '-b', emptyBranch, f.base], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.worktree, 'commit', '--allow-empty', '-m', 'empty candidate'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    const emptyHead = execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      f.taskSpec,
      `task_id: ${f.taskId}
run_id: ${f.runId}
spec_version: 1
worktree: ${f.worktree}
branch: ${emptyBranch}
base_commit: ${f.base}
writable_paths:
  - src/**
`,
      'utf8',
    );
    writeFileSync(
      f.drop,
      JSON.stringify({
        task_id: f.taskId,
        run_id: f.runId,
        spec_version: 1,
        vendor: 'claude',
        status: 'completed',
        branch: emptyBranch,
        base_commit: f.base,
        head_commit: emptyHead,
        files_changed: [],
        verification_claims: [],
      }),
      'utf8',
    );

    try {
      await promote(f.runId, f.taskId, f.drop, baseOptions(f));
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'no_commit');
    }
  });

  it('rejects ownership_violation when audit fails', async () => {
    const f = makeFixture();
    const options: PromoteOptions = {
      ...baseOptions(f),
      audit: () => ({ clean: false, violations: ['changed outside writable_paths: secret.txt'] }),
    };

    try {
      await promote(f.runId, f.taskId, f.drop, options);
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'ownership_violation');
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.event === 'result_rejected' && ev.reason === 'ownership_violation'));
  });

  it('rejects verification_failed when verify does not pass', async () => {
    const f = makeFixture();
    const options: PromoteOptions = {
      ...baseOptions(f),
      verify: async (_worktree, _policy, out) => {
        const observed = [{ command: 'test pass', status: 'failed' as const }];
        assert.ok(out);
        writeFileSync(out, `${JSON.stringify(observed)}\n`, 'utf8');
        return observed;
      },
    };

    try {
      await promote(f.runId, f.taskId, f.drop, options);
      assert.fail('expected rejection');
    } catch (e) {
      assertRejected(e, 'verification_failed');
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.event === 'result_rejected' && ev.reason === 'verification_failed'));
    assert.ok(events.some((ev) => ev.event === 'verification_executed' && ev.status === 'failed'));
  });

  it('promotes a valid drop and records result_promoted', async () => {
    const f = makeFixture();
    const options = baseOptions(f);
    const result = await promote(f.runId, f.taskId, f.drop, options);

    assert.equal(existsSync(result.promoted), true);
    const promoted = JSON.parse(readFileSync(result.promoted, 'utf8'));
    assert.equal(promoted.claims.task_id, f.taskId);
    assert.equal(promoted.claims.head_commit, f.head);
    assert.deepEqual(promoted.harness_observed.verification, [
      { command: 'test pass', status: 'passed' },
    ]);
    assert.equal(promoted.divergence, false);
    assert.match(promoted.promoted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.event === 'result_dropped'));
    assert.ok(events.some((ev) => ev.event === 'verification_executed' && ev.status === 'passed'));
    const promotedEvent = events.find((ev) => ev.event === 'result_promoted');
    assert.ok(promotedEvent);
    assert.equal(promotedEvent.head, f.head);
    assert.equal(promotedEvent.divergence, 'false');
  });

  it('preserves CLI exit codes and prints the promoted path to stdout', async () => {
    const promotedFixture = makeFixture();
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      assert.equal(
        await main(
          [promotedFixture.runId, promotedFixture.taskId, promotedFixture.drop],
          baseOptions(promotedFixture),
        ),
        0,
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(writes.join(''), `${join(
      promotedFixture.stateRoot,
      'runs',
      `run-${promotedFixture.runId}`,
      'authoritative',
      'results',
      `${promotedFixture.taskId}.json`,
    )}\n`);

    const rejectedFixture = makeFixture();
    assert.equal(
      await main(
        [rejectedFixture.runId, rejectedFixture.taskId, rejectedFixture.drop],
        {
          ...baseOptions(rejectedFixture),
          audit: () => ({ clean: false, violations: ['test rejection'] }),
        },
      ),
      5,
    );
  });

  it('detects divergence between claims and harness observation', async () => {
    const f = makeFixture();
    const claims = JSON.parse(readFileSync(f.drop, 'utf8'));
    claims.verification_claims = [{ command: 'test pass', status: 'failed' }];
    writeFileSync(f.drop, JSON.stringify(claims), 'utf8');
    const options: PromoteOptions = {
      ...baseOptions(f),
    };

    const result = await promote(f.runId, f.taskId, f.drop, options);
    const promoted = JSON.parse(readFileSync(result.promoted, 'utf8'));
    assert.equal(promoted.divergence, true);

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    const promotedEvent = events.find((ev) => ev.event === 'result_promoted');
    assert.ok(promotedEvent);
    assert.equal(promotedEvent.divergence, 'true');
  });

  it('appends result_dropped ledger event on entry', async () => {
    const f = makeFixture();
    try {
      await promote(f.runId, f.taskId, f.drop, {
        ...baseOptions(f),
        audit: () => ({ clean: false, violations: ['fail'] }),
      });
    } catch {
      // expected
    }

    const events = readJsonl(ledgerPath(f.stateRoot, f.runId));
    assert.ok(events.some((ev) => ev.event === 'result_dropped'));
  });

  it('uses injected git exec for git evidence checks', async () => {
    const f = makeFixture();
    let gitCalled = false;
    const exec = (command: string, args: string[], options?: { encoding?: string; stdio?: any }) => {
      if (command === 'git') gitCalled = true;
      return execFileSync(command, args, options);
    };

    await promote(f.runId, f.taskId, f.drop, {
      ...baseOptions(f),
      exec,
    });

    assert.equal(gitCalled, true);
  });

  it('passes writable paths to the audit function', async () => {
    const f = makeFixture();
    let capturedWritable: string[] | undefined;
    const options: PromoteOptions = {
      ...baseOptions(f),
      audit: (_wt, _base, _head, writable) => {
        capturedWritable = writable;
        return { clean: true, violations: [] };
      },
    };

    await promote(f.runId, f.taskId, f.drop, options);
    assert.deepEqual(capturedWritable, ['src/**']);
  });

  it('writes observed verification results to the run directory', async () => {
    const f = makeFixture();
    await promote(f.runId, f.taskId, f.drop, baseOptions(f));

    const observed = join(
      f.stateRoot,
      'runs',
      `run-${f.runId}`,
      'authoritative',
      'verification',
      `${f.taskId}.json`,
    );
    assert.equal(existsSync(observed), true);
    assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), [
      { command: 'test pass', status: 'passed' },
    ]);
  });

  it('does not leak directories or files outside TEST_TMP (regression)', () => {
    assert.equal(process.env.HYDRA_STATE_ROOT, TEST_TMP);

    const initialSet = new Set(initialOutsideEntries);
    const leaked = worktreeEntriesOutsideTestTmp()
      .filter((entry) => !initialSet.has(entry));

    assert.deepEqual(leaked, [], `unexpected paths leaked outside TEST_TMP:\n${leaked.join('\n')}`);
  });
});
