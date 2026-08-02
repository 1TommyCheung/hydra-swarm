import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  REVIEW_FILE_BUDGET,
  defaultExec,
  main as reviewDispatchMain,
  parseReviewDispatchArgs,
  reviewDispatch,
  reviewStallMinutes,
  reviewTimeoutMinutes,
  stripAnsi,
  type ReviewDispatchOptions,
  type ExecFn,
  type ExecResult,
} from '../src/review-dispatch.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-review-dispatch');

// Built from char codes rather than pasted literally so the fixtures stay
// visible (and greppable) in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** 8-bit C1 forms: CSI (0x9B), OSC (0x9D), ST (0x9C). */
const CSI8 = String.fromCharCode(0x9b);
const OSC8 = String.fromCharCode(0x9d);
const ST8 = String.fromCharCode(0x9c);
/** Any escape byte at all — asserts nothing leaked into a written .md. */
const ANSI_PROBE = new RegExp('[\\u001B\\u009B]');

interface Call {
  file: string;
  args: string[];
  cwd?: string;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeExec(records: Record<string, ExecResult>): ExecFn {
  return (file: string, args: string[], options?: { cwd?: string }) => {
    const key = `${file} ${args.join(' ')}`;
    if (key in records) {
      return records[key];
    }
    if (file === 'bash' && args[0] === '-lc') {
      const values = Object.values(records);
      if (values.length === 1) return values[0];
    }
    throw new Error(`unexpected exec: ${key}`);
  };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

let previousDefaultPanes: string | undefined;

before(() => {
  cleanTmp();
  mkdirSync(TEST_TMP, { recursive: true });
  // Panes now default to on; pin off here so tests that don't care about
  // pane hosting exercise the plain-exec path. Tests that specifically
  // cover pane hosting set HYDRA_HERDR_PANES='1' themselves.
  previousDefaultPanes = process.env.HYDRA_HERDR_PANES;
  process.env.HYDRA_HERDR_PANES = '0';
});

after(() => {
  restoreEnv('HYDRA_HERDR_PANES', previousDefaultPanes);
  cleanTmp();
});

describe('reviewDispatch', () => {
  function options(
    extras: Omit<ReviewDispatchOptions, 'stateRoot' | 'cwd'> = {},
  ): ReviewDispatchOptions {
    return {
      stateRoot: TEST_TMP,
      cwd: TEST_TMP,
      // Explicit task provenance is required (issue #32); individual tests
      // override with their own task id or pass taskId: undefined to probe
      // the missing-task rejection.
      taskId: 'task-default',
      // Point the code-graph capability lookup (issue #28 E2) at a file that
      // does not exist, so every test that is not ABOUT that lookup sees
      // "capability unknown" and an untouched prompt regardless of what this
      // machine's real heads.json happens to record.
      headsFile: join(TEST_TMP, 'absent-heads.json'),
      ...extras,
    };
  }

  function writePrompt(content: string): string {
    const p = join(TEST_TMP, `prompt-${Date.now()}.md`);
    writeFileSync(p, content, 'utf8');
    return p;
  }

  function ledgerEvents(runId: string): Record<string, unknown>[] {
    const ledgerPath = join(
      TEST_TMP,
      'runs',
      `run-${runId}`,
      'authoritative',
      'ledger',
      'events.jsonl',
    );
    if (!existsSync(ledgerPath)) return [];
    return readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('throws when runId is empty', () => {
    assert.throws(
      () => reviewDispatch('', 'r1', 'claude', writePrompt('hello')),
      /run_id required/,
    );
  });

  it('throws when reviewId is empty', () => {
    assert.throws(
      () => reviewDispatch('run1', '', 'claude', writePrompt('hello')),
      /review_id required/,
    );
  });

  it('throws when vendor is empty', () => {
    assert.throws(
      () => reviewDispatch('run1', 'r1', '', writePrompt('hello')),
      /vendor required/,
    );
  });

  it('throws when promptFile is empty', () => {
    assert.throws(
      () => reviewDispatch('run1', 'r1', 'claude', ''),
      /prompt_file required/,
    );
  });

  it('throws when promptFile does not exist', () => {
    assert.throws(
      () =>
        reviewDispatch(
          'run1',
          'r1',
          'claude',
          join(TEST_TMP, 'missing.md'),
          options(),
        ),
      /prompt file not found/,
    );
  });

  it('throws for an unknown vendor', () => {
    assert.throws(
      () =>
        reviewDispatch('run1', 'r1', 'unknown', writePrompt('hello'), options()),
      /unknown vendor/,
    );
  });

  it('creates sessions, raw and md files and returns the md path', () => {
    const runId = 'run-create';
    const reviewId = 'rev-create';
    const vendor = 'claude';
    const prompt = writePrompt('please review');
    const raw = JSON.stringify({ result: 'LGTM' });

    const mdPath = reviewDispatch(
      runId,
      reviewId,
      vendor,
      prompt,
      options({
        exec: makeExec({
          [`claude -p please review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: raw,
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    assert.equal(mdPath, join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.${vendor}.md`));
    assert.ok(existsSync(join(TEST_TMP, 'runs', `run-${runId}`, 'sessions')));
    assert.ok(existsSync(join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.${vendor}.raw`)));
    assert.equal(readFileSync(mdPath, 'utf8').trim(), 'LGTM');
  });

  it('appends review_started and review_completed ledger events', () => {
    const runId = 'run-ledger';
    const reviewId = 'rev-ledger';
    const vendor = 'claude';
    const prompt = writePrompt('review');

    reviewDispatch(
      runId,
      reviewId,
      vendor,
      prompt,
      options({
        taskId: 'task-ledger',
        exec: makeExec({
          [`claude -p review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: JSON.stringify({ result: 'ok' }),
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    const events = ledgerEvents(runId);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'review_started');
    assert.equal(events[0].review_id, reviewId);
    assert.equal(events[0].vendor, vendor);
    assert.equal(events[1].event, 'review_completed');
    assert.equal(events[1].review_id, reviewId);
    assert.equal(events[1].vendor, vendor);
    assert.equal(events[1].exit_code, '0');
  });

  it('carries the explicit task_id on both review lifecycle events, with a review id unrelated to the task id', () => {
    const runId = 'run-provenance';
    const reviewId = 'rev-unrelated-99';
    const vendor = 'claude';
    const prompt = writePrompt('provenance review');

    reviewDispatch(
      runId,
      reviewId,
      vendor,
      prompt,
      options({
        taskId: 'task-a',
        exec: makeExec({
          [`claude -p provenance review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: JSON.stringify({ result: 'ok' }),
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    const events = ledgerEvents(runId);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.task_id, 'task-a', `${event.event} must carry the explicit task_id`);
      assert.equal(event.review_id, reviewId, 'review_id stays an opaque session label');
    }
    // The session artifacts keep being named by review_id, not by task_id.
    assert.ok(
      existsSync(join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.${vendor}.md`)),
    );
  });

  it('throws before dispatch when the task id is missing', () => {
    const runId = 'run-no-task';
    let execCalled = false;
    assert.throws(
      () =>
        reviewDispatch(runId, 'rev1', 'claude', writePrompt('no task'), {
          stateRoot: TEST_TMP,
          cwd: TEST_TMP,
          exec: () => {
            execCalled = true;
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        }),
      /task_id required/,
    );
    assert.equal(execCalled, false, 'no vendor process may be spawned without --task');
    assert.equal(
      existsSync(join(TEST_TMP, 'runs', `run-${runId}`)),
      false,
      'no run state (sessions dir, ledger) may be created without --task',
    );
  });

  it('throws before dispatch for hostile task ids', () => {
    // The canonical grammar (task-id.ts): lowercase [a-z0-9-] only, no
    // leading/trailing hyphen, max 64 — uppercase, underscore and over-long
    // values are rejected exactly like traversal-shaped ones.
    const hostile = [
      '../evil', 'a/b', 'a b', 'a;b', '.dot', '-flag', 'a..b', 'é',
      'Task-A', 'task_a', 'task-', 'a'.repeat(65),
    ];
    for (const taskId of hostile) {
      const runId = `run-hostile-${hostile.indexOf(taskId)}`;
      let execCalled = false;
      assert.throws(
        () =>
          reviewDispatch(runId, 'rev1', 'claude', writePrompt('hostile task'), {
            stateRoot: TEST_TMP,
            cwd: TEST_TMP,
            taskId,
            exec: () => {
              execCalled = true;
              return { stdout: '', stderr: '', exitCode: 0 };
            },
          }),
        /invalid task_id/,
        `task id ${JSON.stringify(taskId)} must be rejected`,
      );
      assert.equal(execCalled, false, `no dispatch for task id ${JSON.stringify(taskId)}`);
      assert.equal(
        existsSync(join(TEST_TMP, 'runs', `run-${runId}`)),
        false,
        `no state written for task id ${JSON.stringify(taskId)}`,
      );
    }
  });

  it('accepts the exact 64-character task id boundary', () => {
    const runId = 'run-task-64';
    const taskId = 'a'.repeat(64);
    reviewDispatch(
      runId,
      'rev1',
      'claude',
      writePrompt('boundary review'),
      options({
        taskId,
        exec: makeExec({
          [`claude -p boundary review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: JSON.stringify({ result: 'ok' }),
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );
    const events = ledgerEvents(runId);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.task_id, taskId);
    }
  });

  it('throws before any mutation for hostile run ids', () => {
    const hostile = ['../evil', 'a/b', 'a b', '.', '..', 'run.id', '-run', 'r'.repeat(65), 'run x'];
    for (const runId of hostile) {
      const stateRoot = join(TEST_TMP, `runid-${hostile.indexOf(runId)}`);
      mkdirSync(stateRoot, { recursive: true });
      let execCalled = false;
      assert.throws(
        () =>
          reviewDispatch(runId, 'rev1', 'claude', writePrompt('hostile run id'), {
            stateRoot,
            cwd: TEST_TMP,
            taskId: 'task-a',
            exec: () => {
              execCalled = true;
              return { stdout: '', stderr: '', exitCode: 0 };
            },
          }),
        /invalid run_id/,
        `run id ${JSON.stringify(runId)} must be rejected`,
      );
      assert.equal(execCalled, false, `no dispatch for run id ${JSON.stringify(runId)}`);
      assert.deepEqual(
        readdirSync(stateRoot),
        [],
        `state root must stay untouched for run id ${JSON.stringify(runId)}`,
      );
    }
  });

  it('throws before any mutation for hostile review ids — session artifacts cannot escape', () => {
    // review_id names every session artifact (md/raw/exit/pid/pane-progress),
    // so traversal, separators, dot segments, control bytes, whitespace and
    // over-long values must all fail BEFORE any path is constructed.
    const hostile = [
      '../evil', '..', '.', 'a/b', 'a\\b', 'rev.1', 'rev id', 'rev\tid',
      'rev\u0000id', '-rev', '_rev', 'r'.repeat(65), 'é',
    ];
    for (const reviewId of hostile) {
      const stateRoot = join(TEST_TMP, `revid-${hostile.indexOf(reviewId)}`);
      mkdirSync(stateRoot, { recursive: true });
      let execCalled = false;
      assert.throws(
        () =>
          reviewDispatch('run-esc', reviewId, 'claude', writePrompt('hostile review id'), {
            stateRoot,
            cwd: TEST_TMP,
            taskId: 'task-a',
            exec: () => {
              execCalled = true;
              return { stdout: '', stderr: '', exitCode: 0 };
            },
          }),
        /invalid review_id/,
        `review id ${JSON.stringify(reviewId)} must be rejected`,
      );
      assert.equal(execCalled, false, `no dispatch for review id ${JSON.stringify(reviewId)}`);
      assert.deepEqual(
        readdirSync(stateRoot),
        [],
        `nothing may be written anywhere for review id ${JSON.stringify(reviewId)} — no raw/md/exit/pid/progress file can exist, escaped or otherwise`,
      );
    }
  });

  it('containment: every session artifact for a valid dispatch stays inside the run sessions directory', () => {
    const runId = 'run-contained';
    const reviewId = 'rev-contained';
    const stateRoot = join(TEST_TMP, 'containment-root');
    mkdirSync(stateRoot, { recursive: true });
    reviewDispatch(
      runId,
      reviewId,
      'claude',
      writePrompt('containment review'),
      {
        stateRoot,
        cwd: TEST_TMP,
        taskId: 'task-a',
        exec: () => ({ stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0 }),
      },
    );
    const runRoot = join(stateRoot, 'runs', `run-${runId}`);
    const sessions = join(runRoot, 'sessions');
    // Everything written under the state root lives beneath the run dir, and
    // every session artifact (raw/md/exit/pid) beneath its sessions dir.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name: string) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const files = walk(stateRoot);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.ok(
        resolve(file).startsWith(resolve(runRoot) + '/'),
        `${file} escapes the run directory`,
      );
    }
    const sessionFiles = files.filter((file) => !file.includes('/authoritative/'));
    assert.ok(sessionFiles.length >= 3, sessionFiles.join('\n'));
    for (const file of sessionFiles) {
      assert.ok(
        resolve(file).startsWith(resolve(sessions) + '/'),
        `${file} escapes the sessions directory`,
      );
      assert.match(file, /rev-contained\.claude\.(md|raw|exit|pid)$/);
    }
  });

  it('extracts the final assistant message for Claude JSON output', () => {
    const prompt = writePrompt('claude review');
    const mdPath = reviewDispatch(
      'claude-run',
      'rev1',
      'claude',
      prompt,
      options({
        exec: makeExec({
          [`claude -p claude review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: JSON.stringify({ result: 'Approved with notes' }),
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    assert.equal(readFileSync(mdPath, 'utf8').trim(), 'Approved with notes');
  });

  it('extracts the last assistant content for Kimi stream JSON', () => {
    const prompt = writePrompt('kimi review');
    const raw = [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: 'first' }),
      JSON.stringify({ role: 'assistant', content: 'second' }),
    ].join('\n');

    const mdPath = reviewDispatch(
      'kimi-run',
      'rev1',
      'kimi',
      prompt,
      options({
        exec: makeExec({
          [`kimi -p kimi review --output-format stream-json --add-dir ${TEST_TMP}`]: {
            stdout: raw,
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    assert.equal(readFileSync(mdPath, 'utf8').trim(), 'second');
  });

  it('includes the image directory when --image is supplied for kimi', () => {
    const prompt = writePrompt('kimi image review');
    const image = join(TEST_TMP, 'assets', 'shot.png');
    mkdirSync(dirname(image), { recursive: true });
    const calls: Call[] = [];
    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      return { stdout: JSON.stringify({ role: 'assistant', content: 'image ok' }), stderr: '', exitCode: 0 };
    };

    reviewDispatch(
      'kimi-img',
      'rev1',
      'kimi',
      prompt,
      options({ exec, image }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'bash');
    assert.equal(calls[0].args[0], '-lc');
    assert.match(calls[0].args[1], /kimi/);
    assert.match(calls[0].args[1], new RegExp(dirname(image)));
  });

  it('extracts the last codex agent_message', () => {
    const prompt = writePrompt('codex review');
    const raw = [
      JSON.stringify({ msg: { type: 'agent_message', message: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { text: 'second' } }),
      JSON.stringify({ msg: { type: 'agent_message', message: 'third' } }),
    ].join('\n');

    const mdPath = reviewDispatch(
      'codex-run',
      'rev1',
      'codex',
      prompt,
      options({
        exec: makeExec({
          [`codex exec --json -s read-only -C ${TEST_TMP} codex review`]: {
            stdout: raw,
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    assert.equal(readFileSync(mdPath, 'utf8').trim(), 'third');
  });

  it('extracts the last opencode text part', () => {
    const prompt = writePrompt('opencode review');
    const raw = [
      JSON.stringify({ type: 'text', text: 'first' }),
      JSON.stringify({ part: { type: 'text', text: 'second' } }),
    ].join('\n');

    const mdPath = reviewDispatch(
      'opencode-run',
      'rev1',
      'opencode',
      prompt,
      options({
        exec: makeExec({
          [`opencode run --model zai-coding-plan/glm-5.2 --agent hydra-reviewer --format json --auto --dir ${TEST_TMP} opencode review`]: {
            stdout: raw,
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    assert.equal(readFileSync(mdPath, 'utf8').trim(), 'second');
  });

  it('falls back to copying raw output when extraction is empty', () => {
    const prompt = writePrompt('empty review');
    const raw = JSON.stringify({ unexpected: 'no message' });

    const mdPath = reviewDispatch(
      'empty-run',
      'rev1',
      'claude',
      prompt,
      options({
        exec: makeExec({
          [`claude -p empty review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: raw,
            stderr: '',
            exitCode: 0,
          },
        }),
      }),
    );

    assert.equal(readFileSync(mdPath, 'utf8').trim(), raw);
  });

  it('writes the non-zero exit code to the ledger', () => {
    const prompt = writePrompt('failing review');

    reviewDispatch(
      'fail-run',
      'rev1',
      'claude',
      prompt,
      options({
        exec: makeExec({
          [`claude -p failing review --output-format json --add-dir ${TEST_TMP}`]: {
            stdout: 'stderr output',
            stderr: '',
            exitCode: 7,
          },
        }),
      }),
    );

    const events = ledgerEvents('fail-run');
    assert.equal(events[events.length - 1].exit_code, '7');
  });

  it('records 127 when the vendor executable is missing', () => {
    const home = join(TEST_TMP, 'missing-vendor-home');
    mkdirSync(home, { recursive: true });
    // .bash_login (not .bash_profile): sourced by `bash -lc` when no
    // .bash_profile exists, and some sandboxed environments refuse to create
    // files named .bash_profile/.profile at all (EPERM) — .bash_login keeps
    // this test hermetic there too.
    writeFileSync(
      join(home, '.bash_login'),
      "export PATH='/definitely/missing'\n",
      'utf8',
    );
    const previousHome = process.env.HOME;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    process.env.HOME = home;
    process.env.HYDRA_HERDR_PANES = '0';

    try {
      reviewDispatch(
        'missing-vendor-run',
        'rev1',
        'claude',
        writePrompt('missing vendor'),
        options(),
      );
    } finally {
      restoreEnv('HOME', previousHome);
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
    }

    assert.equal(ledgerEvents('missing-vendor-run').at(-1)?.exit_code, '127');
  });

  it('uses the HYDRA_OPENCODE_MODEL override', () => {
    const previous = process.env.HYDRA_OPENCODE_MODEL;
    process.env.HYDRA_OPENCODE_MODEL = 'review/custom-model';
    let wrapped = '';

    try {
      reviewDispatch(
        'opencode-model-run',
        'rev1',
        'opencode',
        writePrompt('model review'),
        options({
          exec: (file, args) => {
            assert.equal(file, 'bash');
            wrapped = args[1];
            return {
              stdout: JSON.stringify({ type: 'text', text: 'model ok' }),
              stderr: '',
              exitCode: 0,
            };
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_OPENCODE_MODEL', previous);
    }

    assert.match(wrapped, /--model' 'review\/custom-model'/);
  });

  // Issue #37: a single non-JSON line used to abort the WHOLE transcript
  // parse (eager `.map(JSON.parse)` inside one outer try/catch), so a real,
  // already-present distillation was discarded and the raw stream copied
  // verbatim. Parsing is now per-line tolerant: a bad line is skipped.
  it('still extracts the final message when a JSONL line is malformed', () => {
    const raw = [
      JSON.stringify({ role: 'assistant', content: 'would otherwise extract' }),
      '{malformed',
    ].join('\n');

    const mdPath = reviewDispatch(
      'malformed-run',
      'rev1',
      'kimi',
      writePrompt('malformed stream'),
      options({
        exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }),
      }),
    );

    assert.equal(readFileSync(mdPath, 'utf8'), 'would otherwise extract\n');
  });

  it('extracts opencode output past an ANSI-colored non-JSON preamble', () => {
    const raw = [
      `${ESC}[33magent "hydra-reviewer" not found. Falling back to default agent${ESC}[0m`,
      JSON.stringify({ part: { type: 'text', text: 'first pass' } }),
      'plain progress chatter that is not JSON at all',
      JSON.stringify({ part: { type: 'text', text: 'VERDICT: revise' } }),
    ].join('\n');

    const mdPath = reviewDispatch(
      'ansi-preamble-run',
      'rev1',
      'opencode',
      writePrompt('ansi preamble review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    const md = readFileSync(mdPath, 'utf8');
    assert.equal(md, 'VERDICT: revise\n', 'distilled, not a raw copy');
    assert.doesNotMatch(md, ANSI_PROBE, 'no ANSI escapes reach the .md');
  });

  it('extracts kimi output past an ANSI-colored non-JSON preamble', () => {
    const raw = [
      `${ESC}[2mloading model...${ESC}[0m`,
      JSON.stringify({ role: 'assistant', content: 'draft thoughts' }),
      '',
      'not json',
      JSON.stringify({ role: 'assistant', content: 'final verdict text' }),
    ].join('\n');

    const mdPath = reviewDispatch(
      'ansi-kimi-run',
      'rev1',
      'kimi',
      writePrompt('ansi kimi review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    const md = readFileSync(mdPath, 'utf8');
    assert.equal(md, 'final verdict text\n');
    assert.doesNotMatch(md, ANSI_PROBE);
  });

  it('strips ANSI escapes on the raw-copy fallback path too', () => {
    // Nothing distillable here, so the raw-copy fallback runs — and it must
    // still never write escape bytes into a reviewer-facing file.
    const raw = `${ESC}[31mvendor exploded${ESC}[0m\n${ESC}]0;title${BEL}no json here\n`;

    const mdPath = reviewDispatch(
      'ansi-fallback-run',
      'rev1',
      'opencode',
      writePrompt('ansi fallback review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    const md = readFileSync(mdPath, 'utf8');
    assert.equal(md, 'vendor exploded\nno json here\n');
    assert.doesNotMatch(md, ANSI_PROBE);
  });

  // An earlier revision matched only a final byte in `[@-Z\-_]`, so the short
  // escapes below survived stripping and could still reach a reviewer-facing
  // .md through the raw-copy fallback. Each fixture is asserted BOTH for the
  // exact stripped text and for the absence of any escape byte at all.
  describe('stripAnsi covers the ECMA-48 escape ranges, not just CSI/OSC', () => {
    const fixtures: Array<[string, string]> = [
      ['CSI SGR color', `${ESC}[1;33m`],
      ['CSI erase line', `${ESC}[2K`],
      ['OSC + BEL', `${ESC}]0;window title${BEL}`],
      ['OSC + ST', `${ESC}]8;;https://example.test${ESC}\\`],
      // Fp (0x30-0x3F) — the private-use single-character escapes.
      ['DECSC save cursor', `${ESC}7`],
      ['DECRC restore cursor', `${ESC}8`],
      // Fs (0x60-0x7E).
      ['RIS full reset', `${ESC}c`],
      // Fe (0x40-0x5F).
      ['NEL next line', `${ESC}E`],
      // nF: intermediates then a final byte.
      ['DECALN alignment test', `${ESC}#8`],
      ['charset selection', `${ESC}(B`],
      // 8-bit C1 encodings some tools emit instead of the ESC-prefixed form.
      ['C1 CSI (0x9B) + params + final', `${CSI8}1;31m`],
      ['C1 OSC (0x9D) + ST (0x9C)', `${OSC8}0;title${ST8}`],
      ['bare C1 control byte', String.fromCharCode(0x85)],
    ];

    for (const [name, sequence] of fixtures) {
      it(`strips ${name}`, () => {
        const stripped = stripAnsi(`before${sequence}after`);
        assert.equal(stripped, 'beforeafter');
        assert.doesNotMatch(stripped, ANSI_PROBE);
      });
    }

    it('strips every fixture at once, leaving no escape byte anywhere', () => {
      const raw = fixtures
        .map(([name, sequence]) => `${sequence}${name}${sequence}`)
        .join('\n');
      const stripped = stripAnsi(raw);
      assert.equal(stripped, fixtures.map(([name]) => name).join('\n'));
      assert.doesNotMatch(stripped, ANSI_PROBE);
    });

    it('leaves ordinary text, whitespace and JSON-escaped codepoints alone', () => {
      // `\u009b` here is the six literal ASCII characters a JSON encoder
      // writes -- not a raw escape byte -- and must survive untouched, or
      // stripping would corrupt the transcript it is meant to clean.
      const text = 'plain\ttext\nsecond line\r\n{"note":"\\u009b"}\n';
      assert.equal(stripAnsi(text), text);
    });

    it('drops a dangling escape byte from a truncated capture file', () => {
      assert.doesNotMatch(stripAnsi(`partial output${ESC}`), ANSI_PROBE);
      assert.doesNotMatch(stripAnsi(`partial output${ESC}[0`), ANSI_PROBE);
    });

    it('an unterminated control string stops at the newline, not at EOF', () => {
      // Bounding the body keeps a truncated OSC from swallowing the rest of
      // the transcript on the raw-copy fallback path.
      assert.equal(
        stripAnsi(`${ESC}]0;never terminated\nreal review content\n`),
        '\nreal review content\n',
      );
    });
  });

  it('never writes short escapes into the .md on the raw-copy fallback path', () => {
    // Nothing distillable, so the whole cleaned transcript is copied — the
    // exact path where a missed sequence becomes live terminal-control bytes
    // in a reviewer-facing file (issue #37).
    const raw = [
      `${ESC}7${ESC}[33mnot json${ESC}[0m${ESC}8`,
      `${CSI8}1;31mstill not json${CSI8}0m`,
      `${ESC}creset mid-stream`,
      `${ESC}#8${ESC}]0;title${BEL}tail line`,
      '',
    ].join('\n');

    const mdPath = reviewDispatch(
      'short-escape-fallback-run',
      'rev1',
      'opencode',
      writePrompt('short escape fallback review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    const md = readFileSync(mdPath, 'utf8');
    assert.equal(
      md,
      'not json\nstill not json\nreset mid-stream\ntail line\n',
    );
    assert.doesNotMatch(md, ANSI_PROBE, 'no escape byte reaches the .md');
  });

  it('distills opencode JSON hidden behind short-escape noise', () => {
    // The distilled path: the preamble carries DECSC/RIS/C1-CSI rather than
    // plain SGR color, so a parser that only knew CSI/OSC would still be
    // handed escape bytes when splitting lines for JSON.
    const raw = [
      `${ESC}7${CSI8}33magent "hydra-reviewer" not found. Falling back to default agent${ESC}8`,
      JSON.stringify({ part: { type: 'text', text: 'first pass' } }),
      `${ESC}cprogress chatter`,
      JSON.stringify({ part: { type: 'text', text: 'VERDICT: accept' } }),
    ].join('\n');

    const mdPath = reviewDispatch(
      'short-escape-distill-run',
      'rev1',
      'opencode',
      writePrompt('short escape distill review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    const md = readFileSync(mdPath, 'utf8');
    assert.equal(md, 'VERDICT: accept\n', 'distilled, not a raw copy');
    assert.doesNotMatch(md, ANSI_PROBE);
  });

  it('detects the agent fallback warning through short-escape coloring', () => {
    // Detection runs on the CLEANED text, so an escape form the stripper
    // missed would split the warning and silently lose the ledger event.
    const runId = 'short-escape-fallback-event-run';
    const raw = [
      `${ESC}7${CSI8}33magent "hydra-reviewer" not found. Falling back to default agent${CSI8}0m${ESC}8`,
      JSON.stringify({ part: { type: 'text', text: 'reviewed anyway' } }),
    ].join('\n');

    reviewDispatch(
      runId,
      'rev1',
      'opencode',
      writePrompt('short escape fallback event review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    const events = ledgerEvents(runId);
    assert.deepEqual(events.map((event) => event.event), [
      'review_started',
      'review_agent_fallback',
      'review_completed',
    ]);
    assert.equal(events[1].requested_agent, 'hydra-reviewer');
    assert.equal(events[1].used_agent, 'default');
  });

  it('records review_agent_fallback without disturbing the completion flow', () => {
    const runId = 'agent-fallback-run';
    const raw = [
      `${ESC}[33magent "hydra-reviewer" not found. Falling back to default agent${ESC}[0m`,
      JSON.stringify({ part: { type: 'text', text: 'reviewed anyway' } }),
    ].join('\n');

    const mdPath = reviewDispatch(
      runId,
      'rev1',
      'opencode',
      writePrompt('agent fallback review'),
      options({ exec: () => ({ stdout: raw, stderr: '', exitCode: 0 }) }),
    );

    assert.equal(readFileSync(mdPath, 'utf8'), 'reviewed anyway\n');
    const events = ledgerEvents(runId);
    assert.deepEqual(events.map((event) => event.event), [
      'review_started',
      'review_agent_fallback',
      'review_completed',
    ]);
    assert.equal(events[1].requested_agent, 'hydra-reviewer');
    assert.equal(events[1].used_agent, 'default');
    assert.equal(events[1].task_id, 'task-default');
    assert.equal(events[1].vendor, 'opencode');
    assert.equal(events[1].review_id, 'rev1');
    // The review itself is untouched: same completion event, same exit code.
    assert.equal(events[2].exit_code, '0');
  });

  it('does not record review_agent_fallback for an ordinary review', () => {
    const runId = 'no-agent-fallback-run';

    reviewDispatch(
      runId,
      'rev1',
      'opencode',
      writePrompt('ordinary review'),
      options({
        exec: () => ({
          stdout: JSON.stringify({ part: { type: 'text', text: 'all good' } }),
          stderr: '',
          exitCode: 0,
        }),
      }),
    );

    assert.deepEqual(ledgerEvents(runId).map((event) => event.event), [
      'review_started',
      'review_completed',
    ]);
  });

  it('raises the default wall-clock cap to 30 minutes, still env-overridable', () => {
    assert.equal(reviewTimeoutMinutes(undefined), 30);
    assert.equal(reviewTimeoutMinutes(''), 30);
    assert.equal(reviewTimeoutMinutes('not-a-number'), 30);
    assert.equal(reviewTimeoutMinutes('45'), 45);
    assert.equal(reviewTimeoutMinutes('0'), 0);
    // The inactivity window has its own knob, defaulting to 3 minutes of
    // complete byte-silence (60 poll ticks at the 3s cadence).
    assert.equal(reviewStallMinutes(undefined), 3);
    assert.equal(reviewStallMinutes('7'), 7);
    assert.equal(reviewStallMinutes('0'), 0);
  });

  it('hosts a review in an existing herdr workspace and polls to completion', () => {
    const runId = 'pane-complete-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.claude.raw`);
    const sentinelPath = join(sessionDir, `${reviewId}.claude.exit`);
    const calls: Call[] = [];
    const states: Array<[string, string, string]> = [];
    let sleeps = 0;
    let killed = false;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousKeep = process.env.HYDRA_HERDR_KEEP_PANE;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';
    delete process.env.HYDRA_HERDR_KEEP_PANE;

    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                { agent: null, cwd: TEST_TMP, workspace_id: 'ignored' },
                { agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        assert.deepEqual(
          args.slice(args.indexOf('--workspace'), args.indexOf('--workspace') + 2),
          ['--workspace', 'workspace-1'],
        );
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-1' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    let mdPath: string;
    try {
      mdPath = reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('pane review'),
        options({
          exec,
          sleep: (ms) => {
            assert.equal(ms, 3000);
            sleeps += 1;
            writeFileSync(rawPath, JSON.stringify({ result: 'pane ok' }));
            writeFileSync(sentinelPath, '0');
          },
          killTree: () => {
            killed = true;
          },
          herdrState: (pane, vendor, state) => {
            states.push([pane, vendor, state]);
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_HERDR_KEEP_PANE', previousKeep);
    }

    assert.equal(sleeps, 1);
    assert.equal(killed, false);
    assert.deepEqual(states, [
      ['pane-1', 'claude', 'working'],
      ['pane-1', 'claude', 'idle'],
    ]);
    assert.ok(calls.some((call) => call.args.join(' ') === 'pane close pane-1'));
    assert.equal(readFileSync(mdPath!, 'utf8').trim(), 'pane ok');
    const events = ledgerEvents(runId);
    assert.deepEqual(events.map((event) => event.event), [
      'review_started',
      'herdr_pane_started',
      'review_completed',
    ]);
    assert.equal(events[1].label, `hydra:${runId}:${reviewId}:claude`);
    assert.equal(events[1].pane, 'pane-1');
    // A sentinel-backed finish keeps the original completion contract: same
    // event, same exit-code handling, no timeout telemetry.
    assert.equal(events[2].exit_code, '0');
    assert.equal(events[2].reason, undefined);
  });

  it('kills a timed-out pane process tree and does not run inline', () => {
    const runId = 'pane-timeout-run';
    const reviewId = 'rev1';
    const pidPath = join(
      TEST_TMP,
      'runs',
      `run-${runId}`,
      'sessions',
      `${reviewId}.claude.pid`,
    );
    const calls: Call[] = [];
    const killed: number[] = [];
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '0';

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('timeout review'),
        options({
          exec: (file, args, opts) => {
            calls.push({ file, args, cwd: opts?.cwd });
            if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
            if (args[0] === 'pane' && args[1] === 'list') {
              return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: '', exitCode: 0 };
            }
            if (args[0] === 'agent' && args[1] === 'start') {
              writeFileSync(pidPath, '4242');
              return {
                stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-timeout' } } }),
                stderr: '',
                exitCode: 0,
              };
            }
            if (args[0] === 'pane' && args[1] === 'close') {
              return { stdout: '', stderr: '', exitCode: 9 };
            }
            throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
          },
          killTree: (pid) => killed.push(pid),
          herdrState: () => {},
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.deepEqual(killed, [4242]);
    assert.equal(calls.some((call) => call.file === 'bash'), false);
    // Issue #28 E1: a killed review is no longer reported as a completion.
    const last = ledgerEvents(runId).at(-1);
    assert.equal(last?.event, 'review_timed_out');
    assert.equal(last?.reason, 'wall_clock');
    assert.equal(last?.exit_code, '?');
    assert.equal(last?.timeout_min, '0');
  });

  /** Minimal herdr transcript for a reviewer pane that starts successfully. */
  function paneExec(
    calls: Call[],
    paneId: string,
    onStart?: () => void,
  ): ExecFn {
    return (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: { panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        onStart?.();
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: paneId } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && (args[1] === 'resize' || args[1] === 'close')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
  }

  // Issue #36: a hung provider used to burn the entire wall-clock cap in
  // silence with no signal at all. The supervisor now compares a byte-size
  // signature over the review's own capture file poll-to-poll (the worker
  // lane's activitySignature pattern) and gives up on genuine silence.
  it('terminates a stalled review early with review_timed_out reason=stalled', () => {
    const runId = 'pane-stall-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.opencode.raw`);
    const pidPath = join(sessionDir, `${reviewId}.opencode.pid`);
    const calls: Call[] = [];
    const killed: number[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousStall = process.env.HYDRA_REVIEW_STALL_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    // A wall-clock cap that could never plausibly be reached here, so an
    // early termination can ONLY be the inactivity watchdog.
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '10';
    process.env.HYDRA_REVIEW_STALL_MIN = '0.15'; // 9s / 3s cadence = 3 polls

    try {
      reviewDispatch(
        runId,
        reviewId,
        'opencode',
        writePrompt('stalling review'),
        options({
          exec: paneExec(calls, 'pane-stall', () => writeFileSync(pidPath, '5150')),
          sleep: () => {
            sleeps += 1;
            // Output for the first two polls, then total silence — and the
            // sentinel never appears.
            if (sleeps <= 2) {
              appendFileSync(
                rawPath,
                `${JSON.stringify({ part: { type: 'text', text: `chunk ${sleeps}` } })}\n`,
                'utf8',
              );
            }
          },
          killTree: (pid) => killed.push(pid),
          herdrState: () => {},
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_REVIEW_STALL_MIN', previousStall);
    }

    // Two productive polls reset the counter, then three consecutive silent
    // polls trip it: the watchdog fires on poll 5, not on the 10-minute cap.
    assert.equal(sleeps, 5);
    assert.deepEqual(killed, [5150]);
    const last = ledgerEvents(runId).at(-1);
    assert.equal(last?.event, 'review_timed_out');
    assert.equal(last?.reason, 'stalled');
    assert.equal(last?.stall_min, '0.15');
    assert.equal(last?.idle_polls, '3');
    assert.equal(last?.timeout_min, '10');
    assert.equal(last?.review_id, reviewId);
    assert.equal(last?.task_id, 'task-default');
    assert.equal(last?.vendor, 'opencode');
  });

  // The race window: a review that finishes in the exact instant the stall
  // watchdog was about to fire must be a completion, not a timeout. Staged
  // deterministically by writing the sentinel during the sleep of the poll
  // that WOULD have tripped the watchdog (the preceding run of this same
  // schedule, with no sentinel, trips on poll 5 — see the test above).
  // A sentinel that lands even later, after the loop has already decided to
  // give up, is caught by the post-loop re-check in review-dispatch.ts; that
  // one needs a genuinely concurrent vendor process, so a synchronous test
  // harness cannot stage it.
  it('treats a sentinel that lands on the tripping poll as a completion, not a stall', () => {
    const runId = 'pane-stall-race-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.opencode.raw`);
    const sentinelPath = join(sessionDir, `${reviewId}.opencode.exit`);
    const pidPath = join(sessionDir, `${reviewId}.opencode.pid`);
    const calls: Call[] = [];
    const killed: number[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousStall = process.env.HYDRA_REVIEW_STALL_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '10';
    process.env.HYDRA_REVIEW_STALL_MIN = '0.15'; // 9s / 3s cadence = 3 polls

    try {
      reviewDispatch(
        runId,
        reviewId,
        'opencode',
        writePrompt('racing review'),
        options({
          exec: paneExec(calls, 'pane-stall-race', () => writeFileSync(pidPath, '5151')),
          sleep: () => {
            sleeps += 1;
            if (sleeps <= 2) {
              appendFileSync(
                rawPath,
                `${JSON.stringify({ part: { type: 'text', text: `chunk ${sleeps}` } })}\n`,
                'utf8',
              );
              return;
            }
            // Polls 3 and 4 are silent, so the idle counter reaches 2. On
            // poll 5 -- the one that would push it to the 3-poll threshold --
            // the vendor exits instead. It writes ONLY the sentinel: the
            // capture file does not grow, so the signature is byte-identical
            // to a genuine stall and the sentinel is the sole thing telling
            // the two apart. This is the tightest form of the race.
            if (sleeps === 5) writeFileSync(sentinelPath, '0', 'utf8');
          },
          killTree: (pid) => killed.push(pid),
          herdrState: () => {},
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_REVIEW_STALL_MIN', previousStall);
    }

    assert.equal(sleeps, 5, 'the loop stops on the same poll the stall would have');
    assert.deepEqual(killed, [], 'a finished vendor is never killed');
    const events = ledgerEvents(runId);
    // The untouched completion contract: no review_timed_out anywhere.
    assert.deepEqual(events.map((event) => event.event), [
      'review_started',
      'herdr_pane_started',
      'review_completed',
    ]);
    assert.equal(events.at(-1)?.exit_code, '0');
    assert.equal(events.at(-1)?.reason, undefined);
  });

  it('reports reason=wall_clock when slow but continuous output never stalls', () => {
    const runId = 'pane-wallclock-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.codex.raw`);
    const pidPath = join(sessionDir, `${reviewId}.codex.pid`);
    const calls: Call[] = [];
    const killed: number[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousStall = process.env.HYDRA_REVIEW_STALL_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '0.005'; // 300ms of real wall clock
    process.env.HYDRA_REVIEW_STALL_MIN = '5'; // 100 silent polls — unreachable

    try {
      reviewDispatch(
        runId,
        reviewId,
        'codex',
        writePrompt('slow review'),
        options({
          exec: paneExec(calls, 'pane-wallclock', () => writeFileSync(pidPath, '6161')),
          sleep: () => {
            sleeps += 1;
            // Real elapsed time per poll (the injected sleeper does not
            // actually sleep) so the wall-clock backstop can be reached,
            // with fresh bytes every tick so the stall watch never trips.
            const until = Date.now() + 120;
            while (Date.now() < until) { /* burn wall clock deterministically */ }
            appendFileSync(
              rawPath,
              `${JSON.stringify({ msg: { type: 'agent_reasoning', text: `tick ${sleeps}` } })}\n`,
              'utf8',
            );
          },
          killTree: (pid) => killed.push(pid),
          herdrState: () => {},
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_REVIEW_STALL_MIN', previousStall);
    }

    assert.ok(sleeps >= 2, `expected several productive polls, got ${sleeps}`);
    assert.ok(sleeps < 20, `wall-clock cap should stop the loop, got ${sleeps} polls`);
    assert.deepEqual(killed, [6161]);
    const last = ledgerEvents(runId).at(-1);
    assert.equal(last?.event, 'review_timed_out');
    assert.equal(last?.reason, 'wall_clock');
    assert.equal(last?.timeout_min, '0.005');
    assert.equal(last?.exit_code, '?');
    assert.equal(last?.stall_min, undefined, 'wall-clock timeouts carry no stall detail');
  });

  it('never stalls a claude review, whose output only lands at exit', () => {
    // claude runs with --output-format json: a healthy review is byte-silent
    // until the very end, so capture growth cannot judge it. It keeps the
    // wall-clock backstop alone rather than being killed as "stalled".
    const runId = 'pane-claude-silent-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.claude.raw`);
    const sentinelPath = join(sessionDir, `${reviewId}.claude.exit`);
    const calls: Call[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousStall = process.env.HYDRA_REVIEW_STALL_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '10';
    process.env.HYDRA_REVIEW_STALL_MIN = '0.05'; // would trip on poll 1

    let mdPath: string;
    try {
      mdPath = reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('silent claude review'),
        options({
          exec: paneExec(calls, 'pane-claude-silent'),
          sleep: () => {
            sleeps += 1;
            // Byte-silent for several polls, then the whole document at once.
            if (sleeps < 4) return;
            writeFileSync(rawPath, JSON.stringify({ result: 'late but complete' }), 'utf8');
            writeFileSync(sentinelPath, '0', 'utf8');
          },
          killTree: () => assert.fail('a silent claude review must not be killed'),
          herdrState: () => {},
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_REVIEW_STALL_MIN', previousStall);
    }

    assert.equal(sleeps, 4);
    assert.equal(readFileSync(mdPath!, 'utf8').trim(), 'late but complete');
    const events = ledgerEvents(runId);
    assert.deepEqual(events.map((event) => event.event), [
      'review_started',
      'herdr_pane_started',
      'review_completed',
    ]);
    assert.equal(events.at(-1)?.exit_code, '0');
  });

  it('does not fall back inline after a successful pane start with invalid JSON', () => {
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '0';
    const calls: Call[] = [];

    try {
      reviewDispatch(
        'pane-no-id-run',
        'rev1',
        'claude',
        writePrompt('pane without id'),
        options({
          exec: (file, args, opts) => {
            calls.push({ file, args, cwd: opts?.cwd });
            if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
            if (args[0] === 'pane' && args[1] === 'list') {
              return { stdout: '{}', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'agent' && args[1] === 'start') {
              return { stdout: 'not json', stderr: '', exitCode: 0 };
            }
            throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.equal(calls.some((call) => call.file === 'bash'), false);
    assert.equal(ledgerEvents('pane-no-id-run')[1].pane, '?');
  });

  it('runs the CLI entry point through a login shell and writes a pidfile', () => {
    const home = join(TEST_TMP, 'cli-home');
    const bin = join(home, 'bin');
    const state = join(TEST_TMP, 'cli-state');
    const prompt = writePrompt('CLI review');
    const source = resolve(import.meta.dirname, '../src/review-dispatch.ts');
    const worktree = resolve(import.meta.dirname, '../..');
    const fakeClaude = join(bin, 'claude');
    mkdirSync(bin, { recursive: true });
    // .bash_login: see the note in 'records 127 when the vendor executable is
    // missing' — same login-shell semantics, creatable under sandboxes that
    // forbid .bash_profile.
    writeFileSync(
      join(home, '.bash_login'),
      `export PATH='${bin}':"$PATH"\n`,
      'utf8',
    );
    writeFileSync(
      fakeClaude,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"result":"CLI OK"}\'\n',
      'utf8',
    );
    chmodSync(fakeClaude, 0o755);

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', source, 'cli-run', 'rev1', 'claude', prompt, '--task', 'task-cli'],
      {
        cwd: worktree,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          HYDRA_HERDR_PANES: '0',
          HYDRA_STATE_ROOT: state,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const mdPath = result.stdout.trim();
    assert.equal(readFileSync(mdPath, 'utf8').trim(), 'CLI OK');
    assert.match(
      readFileSync(join(state, 'runs', 'run-cli-run', 'sessions', 'rev1.claude.pid'), 'utf8'),
      /^\d+\n?$/,
    );
    // Both lifecycle events carry the explicit task provenance.
    const events = readFileSync(
      join(state, 'runs', 'run-cli-run', 'authoritative', 'ledger', 'events.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(events.map((event) => event.event), ['review_started', 'review_completed']);
    for (const event of events) {
      assert.equal(event.task_id, 'task-cli');
    }
  });

  it('CLI exits 1 when --task is missing, before any dispatch', () => {
    const prompt = writePrompt('CLI without task');
    const stderr: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = reviewDispatchMain(['cli-no-task', 'rev1', 'claude', prompt]);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(code!, 1);
    assert.match(stderr.join(''), /task_id required/);
    // The failure happened before any state-root resolution or dispatch: no
    // ledger, no session artifacts for this run anywhere under TEST_TMP.
    assert.equal(existsSync(join(TEST_TMP, 'runs', 'run-cli-no-task')), false);
  });

  it('CLI exits 1 for an invalid --task value, before any dispatch', () => {
    const prompt = writePrompt('CLI hostile task');
    const stderr: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = reviewDispatchMain(['cli-bad-task', 'rev1', 'claude', prompt, '--task', '../evil']);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(code!, 1);
    assert.match(stderr.join(''), /invalid task_id/);
    assert.equal(existsSync(join(TEST_TMP, 'runs', 'run-cli-bad-task')), false);
  });

  it('parses the documented flag orders: flags before, between, or after operands', () => {
    const expected = {
      runId: 'run1',
      reviewId: 'rev1',
      vendor: 'kimi',
      promptFile: 'prompt.md',
      taskId: 'task-a',
      image: 'shot.png',
    };
    const orders = [
      ['run1', 'rev1', 'kimi', 'prompt.md', '--task', 'task-a', '--image', 'shot.png'],
      ['run1', 'rev1', 'kimi', 'prompt.md', '--image', 'shot.png', '--task', 'task-a'],
      ['--task', 'task-a', 'run1', 'rev1', 'kimi', 'prompt.md', '--image', 'shot.png'],
      ['run1', '--image', 'shot.png', 'rev1', 'kimi', '--task', 'task-a', 'prompt.md'],
    ];
    for (const args of orders) {
      assert.deepEqual(parseReviewDispatchArgs(args), expected, args.join(' '));
    }
    assert.deepEqual(
      parseReviewDispatchArgs(['run1', 'rev1', 'kimi', 'prompt.md', '--task', 'task-a']),
      { ...expected, image: undefined },
      '--image is optional',
    );
  });

  it('rejects every malformed argv before any ledger, session or filesystem mutation', () => {
    const state = join(TEST_TMP, 'cli-strict-state');
    mkdirSync(state, { recursive: true });
    const previousState = process.env.HYDRA_STATE_ROOT;
    process.env.HYDRA_STATE_ROOT = state;
    const cases: Array<{ args: string[]; error: RegExp }> = [
      { args: [], error: /expected 4 positional arguments, got 0/ },
      { args: ['run1', 'rev1', 'claude'], error: /expected 4 positional arguments, got 3/ },
      { args: ['run1', 'rev1', 'claude', 'p.md'], error: /task_id required/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', 'extra', '--task', 't'], error: /unexpected extra operand "extra"/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--task', 't', '--frobnicate'], error: /unknown option "--frobnicate"/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '-x', '--task', 't'], error: /unknown option "-x"/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--task', 't', '--task', 'u'], error: /duplicate --task/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--task', 't', '--image', 'a', '--image', 'b'], error: /duplicate --image/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--task'], error: /missing value for --task/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--task', 't', '--image'], error: /missing value for --image/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--task', '--image', 'x'], error: /missing value for --task: "--image" is another option/ },
      { args: ['run1', 'rev1', 'claude', 'p.md', '--image', '--task', 't'], error: /missing value for --image: "--task" is another option/ },
    ];
    try {
      for (const { args, error } of cases) {
        const stderr: string[] = [];
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: unknown) => {
          stderr.push(String(chunk));
          return true;
        }) as typeof process.stderr.write;
        let code: number;
        try {
          code = reviewDispatchMain(args);
        } finally {
          process.stderr.write = originalWrite;
        }
        const output = stderr.join('');
        assert.equal(code!, 1, `argv [${args.join(' ')}] must fail`);
        assert.match(output, error, `argv [${args.join(' ')}]`);
        assert.match(output, /usage: reviewDispatch <run_id> <review_id> <vendor> <prompt_file> --task <task_id> \[--image PATH\]/, `argv [${args.join(' ')}] must print the usage contract`);
        assert.deepEqual(
          readdirSync(state),
          [],
          `argv [${args.join(' ')}] must not touch the state root`,
        );
      }
    } finally {
      restoreEnv('HYDRA_STATE_ROOT', previousState);
    }
  });

  it('live-tails codex progress events from the raw file into the pane', () => {
    const runId = 'pane-codex-live-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.codex.raw`);
    const progressPath = join(sessionDir, `${reviewId}.codex.pane-progress.txt`);
    const sentinelPath = join(sessionDir, `${reviewId}.codex.exit`);
    const calls: Call[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-codex' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && args[1] === 'resize') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    let mdPath: string;
    try {
      mdPath = reviewDispatch(
        runId,
        reviewId,
        'codex',
        writePrompt('codex pane review'),
        options({
          exec,
          sleep: (ms) => {
            assert.equal(ms, 3000);
            sleeps += 1;
            if (sleeps === 1) {
              writeFileSync(
                rawPath,
                [
                  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Analyzing the codebase' } }),
                  JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm run test' } }),
                  JSON.stringify({ type: 'item.started', item: { type: 'file_change', changes: [{ path: 'src/foo.ts' }] } }),
                ].join('\n') + '\n',
                'utf8',
              );
            } else {
              // Trailing event written just before the sentinel; final poll must catch it.
              appendFileSync(
                rawPath,
                `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Review complete' } })}\n`,
                'utf8',
              );
              writeFileSync(sentinelPath, '0', 'utf8');
            }
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    const agentStart = calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
    assert.ok(agentStart);
    const command = agentStart!.args[agentStart!.args.length - 1];
    assert.match(command, /tail -n \+1 -f/);
    assert.match(command, /TPID=/);
    assert.match(command, /kill \$TPID/);

    const resize = calls.find((call) => call.args[0] === 'pane' && call.args[1] === 'resize');
    assert.deepEqual(
      resize?.args,
      ['pane', 'resize', '--direction', 'down', '--amount', '0.25', '--pane', 'pane-codex'],
      'reviewer pane is shrunk toward the lead console after agent start',
    );

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /\[hydra\] codex started — waiting for output\.\.\./);
    assert.match(progress, /Analyzing the codebase/);
    assert.match(progress, /\[cmd\] npm run test/);
    assert.match(progress, /\[edit\] foo\.ts/);
    assert.match(progress, /Review complete/);
    assert.equal(readFileSync(mdPath!, 'utf8').trim(), 'Review complete');
  });

  it('live-tails kimi progress events from the raw file into the pane', () => {
    const runId = 'pane-kimi-live-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.kimi.raw`);
    const progressPath = join(sessionDir, `${reviewId}.kimi.pane-progress.txt`);
    const sentinelPath = join(sessionDir, `${reviewId}.kimi.exit`);
    const calls: Call[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-kimi' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && (args[1] === 'resize' || args[1] === 'close')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    let mdPath: string;
    try {
      mdPath = reviewDispatch(
        runId,
        reviewId,
        'kimi',
        writePrompt('kimi pane review'),
        options({
          exec,
          sleep: (ms) => {
            assert.equal(ms, 3000);
            sleeps += 1;
            if (sleeps === 1) {
              writeFileSync(
                rawPath,
                [
                  JSON.stringify({ role: 'assistant', content: 'Inspecting the codebase' }),
                  JSON.stringify({ role: 'meta', type: 'session.resume_hint', content: 'hint' }),
                  JSON.stringify({ role: 'assistant', content: 'Planning the review' }),
                ].join('\n') + '\n',
                'utf8',
              );
            } else {
              appendFileSync(
                rawPath,
                `${JSON.stringify({ role: 'assistant', content: 'Review complete' })}\n`,
                'utf8',
              );
              writeFileSync(sentinelPath, '0', 'utf8');
            }
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    const agentStart = calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
    assert.ok(agentStart);
    const command = agentStart!.args[agentStart!.args.length - 1];
    assert.match(command, /tail -n \+1 -f/);
    assert.match(command, /TPID=/);
    assert.match(command, /kill \$TPID/);

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /Inspecting the codebase/);
    assert.match(progress, /Planning the review/);
    assert.match(progress, /Review complete/);
    assert.doesNotMatch(progress, /hint/);
    assert.equal(readFileSync(mdPath!, 'utf8').trim(), 'Review complete');
  });

  it('uses the PLAIN wrapper (no live tail) for codex/kimi when herdr is disabled -- nothing polls the progress file in that path', () => {
    for (const vendor of ['codex', 'kimi'] as const) {
      const runId = `no-pane-${vendor}-run`;
      const reviewId = 'rev1';
      let fallbackCommand: string | undefined;

      reviewDispatch(
        runId,
        reviewId,
        vendor,
        writePrompt(`${vendor} review without a pane`),
        options({
          // HYDRA_HERDR_PANES defaults to '0' in this suite (see the outer
          // before()); no exec branches for 'status'/'pane'/'agent' means
          // launchInPane must never be attempted here.
          exec: (file, args) => {
            if (file === 'bash' && args[0] === '-lc') {
              fallbackCommand = args[1];
              return {
                stdout: JSON.stringify({ role: 'assistant', content: 'ok' }),
                stderr: '',
                exitCode: 0,
              };
            }
            throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
          },
        }),
      );

      assert.ok(fallbackCommand, `${vendor}: fallback command must have run`);
      assert.doesNotMatch(fallbackCommand!, /tail -n \+1 -f/, `${vendor} fallback must not spawn a live tail`);
      assert.doesNotMatch(fallbackCommand!, /TPID/, `${vendor} fallback must not reference TPID`);
      assert.doesNotMatch(fallbackCommand!, /pane-progress\.txt/, `${vendor} fallback must not touch a progress file`);
    }
  });

  it('keeps claude reviewer panes live with a supervisor heartbeat on every poll', () => {
    const runId = 'pane-claude-heartbeat-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.claude.raw`);
    const progressPath = join(sessionDir, `${reviewId}.claude.pane-progress.txt`);
    const sentinelPath = join(sessionDir, `${reviewId}.claude.exit`);
    const calls: Call[] = [];
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({ result: { panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-claude' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && args[1] === 'resize') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    let mdPath: string;
    try {
      mdPath = reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('claude pane review'),
        options({
          exec,
          sleep: () => {
            writeFileSync(rawPath, JSON.stringify({ result: 'heartbeat ok' }));
            writeFileSync(sentinelPath, '0', 'utf8');
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    const agentStart = calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
    assert.ok(agentStart);
    const command = agentStart!.args[agentStart!.args.length - 1];
    assert.match(command, /tail -n \+1 -f/, 'claude pane tails the progress file');
    assert.match(command, /TPID=/);
    assert.match(command, /kill \$TPID/);

    const resize = calls.find((call) => call.args[0] === 'pane' && call.args[1] === 'resize');
    assert.deepEqual(
      resize?.args,
      ['pane', 'resize', '--direction', 'down', '--amount', '0.25', '--pane', 'pane-claude'],
      'reviewer pane is shrunk toward the lead console after agent start',
    );

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /\[hydra\] claude started — waiting for output\.\.\./, 'seed line shows within the first poll interval');
    assert.match(progress, /\[hydra\] claude working\.\.\. elapsed \d+s/, 'heartbeat line is refreshed on each supervisor poll');
    assert.equal(readFileSync(mdPath!, 'utf8').trim(), 'heartbeat ok');
  });

  it('seeds the progress file BEFORE agent start, so an instantly exiting vendor never blanks the pane', () => {
    const runId = 'pane-seed-before-launch-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const progressPath = join(sessionDir, `${reviewId}.codex.pane-progress.txt`);
    const sentinelPath = join(sessionDir, `${reviewId}.codex.exit`);
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    let seededAtAgentStart: string | undefined;
    const exec: ExecFn = (file, args) => {
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({ result: { panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        // The seed line must already be on disk when the pane is launched;
        // otherwise a vendor that exits before this call returns can end the
        // pane's tail before any content is ever written (spec v4 fix 2).
        seededAtAgentStart = existsSync(progressPath)
          ? readFileSync(progressPath, 'utf8')
          : undefined;
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-codex-fast' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && (args[1] === 'resize' || args[1] === 'close')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    try {
      reviewDispatch(
        runId,
        reviewId,
        'codex',
        writePrompt('instant-exit review'),
        options({
          exec,
          // The vendor exits immediately: the sentinel appears on the very
          // first supervisor poll, before any vendor event could stream.
          sleep: () => {
            writeFileSync(sentinelPath, '0', 'utf8');
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.match(
      seededAtAgentStart ?? '',
      /\[hydra\] codex started — waiting for output\.\.\./,
      'seed line must exist before herdr agent start launches the pane',
    );
    const progress = readFileSync(progressPath, 'utf8');
    assert.match(
      progress,
      /\[hydra\] codex started — waiting for output\.\.\./,
      'pane content survives an instantly exiting vendor',
    );
  });

  it('live-tails opencode progress events from the raw file into the pane', () => {
    const runId = 'pane-opencode-live-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const rawPath = join(sessionDir, `${reviewId}.opencode.raw`);
    const progressPath = join(sessionDir, `${reviewId}.opencode.pane-progress.txt`);
    const sentinelPath = join(sessionDir, `${reviewId}.opencode.exit`);
    const calls: Call[] = [];
    let sleeps = 0;
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({ result: { panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-opencode' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && args[1] === 'resize') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    let mdPath: string;
    try {
      mdPath = reviewDispatch(
        runId,
        reviewId,
        'opencode',
        writePrompt('opencode pane review'),
        options({
          exec,
          sleep: (ms) => {
            assert.equal(ms, 3000);
            sleeps += 1;
            if (sleeps === 1) {
              writeFileSync(
                rawPath,
                [
                  JSON.stringify({ type: 'step_start' }),
                  JSON.stringify({ part: { type: 'text', text: 'Reviewing the diff' } }),
                  JSON.stringify({ part: { type: 'tool', tool: 'read', state: { title: 'Inspect dispatch' } } }),
                ].join('\n') + '\n',
                'utf8',
              );
            } else {
              // Trailing event written just before the sentinel; final poll must catch it.
              appendFileSync(
                rawPath,
                `${JSON.stringify({ part: { type: 'text', text: 'Review complete' } })}\n`,
                'utf8',
              );
              writeFileSync(sentinelPath, '0', 'utf8');
            }
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    const agentStart = calls.find((call) => call.args[0] === 'agent' && call.args[1] === 'start');
    assert.ok(agentStart);
    const command = agentStart!.args[agentStart!.args.length - 1];
    assert.match(command, /tail -n \+1 -f/, 'opencode review pane tails the progress file');
    assert.match(command, /TPID=/);
    assert.match(command, /kill \$TPID/);

    const resize = calls.find((call) => call.args[0] === 'pane' && call.args[1] === 'resize');
    assert.deepEqual(
      resize?.args,
      ['pane', 'resize', '--direction', 'down', '--amount', '0.25', '--pane', 'pane-opencode'],
      'reviewer pane is shrunk toward the lead console after agent start',
    );

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /\[hydra\] opencode started — waiting for output\.\.\./);
    assert.match(progress, /Reviewing the diff/);
    assert.match(progress, /\[tool\] read: Inspect dispatch/);
    assert.match(progress, /Review complete/);
    assert.doesNotMatch(progress, /step_start/);
    assert.equal(readFileSync(mdPath!, 'utf8').trim(), 'Review complete');
  });

  it('honors HYDRA_HERDR_PANE_RATIO when shrinking the reviewer pane', () => {
    const runId = 'pane-ratio-run';
    const reviewId = 'rev1';
    const sessionDir = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions');
    const sentinelPath = join(sessionDir, `${reviewId}.codex.exit`);
    const calls: Call[] = [];
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousRatio = process.env.HYDRA_HERDR_PANE_RATIO;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';
    process.env.HYDRA_HERDR_PANE_RATIO = '0.35';

    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({ result: { panes: [{ agent: {}, cwd: TEST_TMP, workspace_id: 'workspace-1' }] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-ratio' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && (args[1] === 'resize' || args[1] === 'close')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    try {
      reviewDispatch(
        runId,
        reviewId,
        'codex',
        writePrompt('ratio review'),
        options({
          exec,
          sleep: () => {
            writeFileSync(sentinelPath, '0', 'utf8');
          },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_HERDR_PANE_RATIO', previousRatio);
    }

    const resize = calls.find((call) => call.args[0] === 'pane' && call.args[1] === 'resize');
    assert.deepEqual(
      resize?.args,
      ['pane', 'resize', '--direction', 'down', '--amount', '0.35', '--pane', 'pane-ratio'],
      'HYDRA_HERDR_PANE_RATIO overrides the default 0.25 agent-pane ratio',
    );
  });

  // -------------------------------------------------------------------------
  // Code-graph reading-strategy preamble (issue #28 E2). Disclosure only:
  // the preamble and the warning are added, the dispatch is never re-routed.
  // -------------------------------------------------------------------------

  describe('code-graph reading strategy', () => {
    /** Write a heads.json fixture with the given per-vendor entries. */
    function writeHeads(name: string, heads: Record<string, unknown>): string {
      const path = join(TEST_TMP, `${name}-heads.json`);
      writeFileSync(path, JSON.stringify({ detected_at: '2026-01-01T00:00:00Z', heads }), 'utf8');
      return path;
    }

    function headsWithCodeGraph(name: string, values: Record<string, boolean>): string {
      const heads: Record<string, unknown> = {};
      for (const [vendor, codeGraph] of Object.entries(values)) {
        heads[vendor] = { available: true, path: `/usr/bin/${vendor}`, code_graph: codeGraph };
      }
      return writeHeads(name, heads);
    }

    /**
     * With herdr panes disabled (this suite's default) the vendor runs through
     * `bash -lc "claude '-p' '<prompt>' '--output-format' ..."`, so the prompt
     * actually handed to the vendor is the single-quoted argument between
     * `'-p'` and `'--output-format'`. Fixtures here contain no single quotes,
     * so this recovers the prompt exactly as the vendor would see it.
     */
    function promptFromCommand(command: string): string {
      const match = command.match(/claude '-p' '([\s\S]*?)' '--output-format'/);
      return match?.[1] ?? '';
    }

    /**
     * Dispatch a claude review, capturing stderr and the prompt the vendor was
     * actually invoked with.
     */
    function dispatchCapturing(
      runId: string,
      promptText: string,
      extras: Omit<ReviewDispatchOptions, 'stateRoot' | 'cwd'>,
    ): { sentPrompt: string; stderr: string; mdPath: string } {
      let sentPrompt = '';
      const exec: ExecFn = (file, args) => {
        if (file === 'bash' && args[0] === '-lc') sentPrompt = promptFromCommand(args[1]);
        return { stdout: JSON.stringify({ result: 'verdict' }), stderr: '', exitCode: 0 };
      };
      const stderr: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let mdPath: string;
      try {
        mdPath = reviewDispatch(
          runId,
          'rev1',
          'claude',
          writePrompt(promptText),
          options({ taskId: 'task-cg', exec, ...extras }),
        );
      } finally {
        process.stderr.write = originalWrite;
      }
      return { sentPrompt, stderr: stderr.join(''), mdPath: mdPath! };
    }

    it('prepends the reading-strategy preamble when code_graph is false', () => {
      const brief = 'REVIEW BRIEF: check the gate in allocate.ts';
      const { sentPrompt } = dispatchCapturing('cg-false-run', brief, {
        headsFile: headsWithCodeGraph('cg-false', { claude: false }),
      });

      assert.match(sentPrompt, /^## Reading strategy \(inserted by hydra/);
      // The operator's brief follows verbatim, unmodified and unreplaced.
      assert.ok(sentPrompt.endsWith(brief), 'operator brief must be preserved verbatim at the end');
      assert.match(sentPrompt, /--- operator review brief follows ---/);
    });

    it('names the concrete strategy: batched ranges, no re-reads, a bounded checkpoint', () => {
      const { sentPrompt } = dispatchCapturing('cg-content-run', 'brief', {
        headsFile: headsWithCodeGraph('cg-content', { claude: false }),
      });

      assert.match(sentPrompt, /nl -ba .* sed -n/);
      assert.match(sentPrompt, /Never re-read a file you have already read/);
      assert.match(sentPrompt, new RegExp(`after inspecting at most ${REVIEW_FILE_BUDGET} files`));
      assert.match(sentPrompt, /STOP\n\s*reading and write your verdict/);
    });

    it('warns naming the vendor, and still completes the dispatch', () => {
      const { stderr, mdPath } = dispatchCapturing('cg-warn-run', 'brief', {
        headsFile: headsWithCodeGraph('cg-warn', { claude: false }),
      });

      assert.match(stderr, /hydra: warn: claude has no code-graph/);
      assert.match(stderr, /code_graph=false/);
      // Advisory, not a block: the review ran and produced its verdict file.
      assert.equal(readFileSync(mdPath, 'utf8').trim(), 'verdict');
    });

    it('leaves the prompt byte-for-byte unchanged when code_graph is true', () => {
      const brief = 'REVIEW BRIEF: capable vendor';
      const { sentPrompt, stderr } = dispatchCapturing('cg-true-run', brief, {
        headsFile: headsWithCodeGraph('cg-true', { claude: true }),
      });

      assert.equal(sentPrompt, brief);
      assert.doesNotMatch(stderr, /code-graph/);
    });

    it('leaves the prompt unchanged when heads.json is missing', () => {
      const brief = 'REVIEW BRIEF: no snapshot';
      const { sentPrompt, stderr } = dispatchCapturing('cg-missing-run', brief, {
        headsFile: join(TEST_TMP, 'definitely-absent-heads.json'),
      });

      assert.equal(sentPrompt, brief);
      assert.doesNotMatch(stderr, /code-graph/);
    });

    it('leaves the prompt unchanged for a legacy snapshot with no code_graph field', () => {
      const brief = 'REVIEW BRIEF: legacy snapshot';
      const headsFile = writeHeads('cg-legacy', {
        claude: { available: true, path: '/usr/bin/claude' },
      });

      const { sentPrompt, stderr } = dispatchCapturing('cg-legacy-run', brief, { headsFile });

      assert.equal(sentPrompt, brief);
      assert.doesNotMatch(stderr, /code-graph/);
    });

    it('leaves the prompt unchanged when the vendor is absent from the snapshot', () => {
      const brief = 'REVIEW BRIEF: vendor not recorded';
      const headsFile = headsWithCodeGraph('cg-other-vendor', { codex: false });

      const { sentPrompt, stderr } = dispatchCapturing('cg-other-run', brief, { headsFile });

      assert.equal(sentPrompt, brief);
      assert.doesNotMatch(stderr, /code-graph/);
    });

    it('leaves the prompt unchanged when heads.json is malformed', () => {
      const brief = 'REVIEW BRIEF: broken snapshot';
      const headsFile = join(TEST_TMP, 'broken-heads.json');
      writeFileSync(headsFile, 'not json at all', 'utf8');

      const { sentPrompt, stderr } = dispatchCapturing('cg-broken-run', brief, { headsFile });

      assert.equal(sentPrompt, brief);
      assert.doesNotMatch(stderr, /code-graph/);
    });

    it('is per-vendor: another vendor recorded false does not alter this review', () => {
      const brief = 'REVIEW BRIEF: this vendor is capable';
      const headsFile = headsWithCodeGraph('cg-mixed', { claude: true, kimi: false });

      const { sentPrompt, stderr } = dispatchCapturing('cg-mixed-run', brief, { headsFile });

      assert.equal(sentPrompt, brief);
      assert.doesNotMatch(stderr, /code-graph/);
    });
  });
});

describe('defaultExec', () => {
  it('returns 127 when the executable is missing', () => {
    const result = defaultExec('/definitely/missing/hydra-reviewer', []);
    assert.equal(result.exitCode, 127);
  });

  it('uses the shell 128+signal exit-code convention', () => {
    const result = defaultExec('/bin/bash', ['-c', 'kill -TERM $$']);
    assert.equal(result.exitCode, 143);
  });
});

describe('reviewDispatch herdr workspace pin (issue #19)', () => {
  function options(
    extras: Omit<ReviewDispatchOptions, 'stateRoot' | 'cwd'> = {},
  ): ReviewDispatchOptions {
    return {
      stateRoot: TEST_TMP,
      cwd: TEST_TMP,
      taskId: 'task-default',
      ...extras,
    };
  }

  function writePrompt(content: string): string {
    const p = join(TEST_TMP, `prompt-pin-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(p, content, 'utf8');
    return p;
  }

  function makeExecReturningWorkspace(workspaceId: string | undefined): { exec: ExecFn; calls: Call[] } {
    const calls: Call[] = [];
    const exec: ExecFn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'pane' && args[1] === 'list') {
        const panes = workspaceId === undefined
          ? []
          : [{ agent: {}, cwd: TEST_TMP, workspace_id: workspaceId }];
        return {
          stdout: JSON.stringify({ result: { panes } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'agent' && args[1] === 'start') {
        return {
          stdout: JSON.stringify({ result: { agent: { pane_id: 'pane-pin' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pane' && (args[1] === 'resize' || args[1] === 'close')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    return { exec, calls };
  }

  function agentStartCall(calls: Call[]): Call | undefined {
    return calls.find((c) => c.args[0] === 'agent' && c.args[1] === 'start');
  }

  function workspaceArg(call: Call | undefined): string | undefined {
    if (!call) return undefined;
    const idx = call.args.indexOf('--workspace');
    if (idx === -1) return undefined;
    return call.args[idx + 1];
  }

  function runYamlPathFor(runId: string): string {
    return join(TEST_TMP, 'runs', `run-${runId}`, 'run.yaml');
  }

  it('persists the workspace id on the first reviewer pane spawn', () => {
    const runId = 'review-pin-first';
    const reviewId = 'rev1';
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    const sentinelPath = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.claude.exit`);
    const { exec, calls } = makeExecReturningWorkspace('ws-review-initial');

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('first pane review'),
        options({
          exec,
          sleep: () => { writeFileSync(sentinelPath, '0', 'utf8'); },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.equal(workspaceArg(agentStartCall(calls)), 'ws-review-initial');
    assert.equal(existsSync(runYamlPathFor(runId)), true);
    assert.equal(
      readFileSync(runYamlPathFor(runId), 'utf8').trim(),
      'herdr_workspace: ws-review-initial',
    );
  });

  it('reuses the persisted workspace id even when the live focus has changed', () => {
    const runId = 'review-pin-reuse';
    const reviewId = 'rev1';
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    // Pre-pin run.yaml with ws-captured; the live workspace is now elsewhere.
    mkdirSync(dirname(runYamlPathFor(runId)), { recursive: true });
    writeFileSync(runYamlPathFor(runId), `herdr_workspace: ws-captured\n`);

    const sentinelPath = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.claude.exit`);
    const { exec, calls } = makeExecReturningWorkspace('ws-focus-moved');

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('reuse pin review'),
        options({
          exec,
          sleep: () => { writeFileSync(sentinelPath, '0', 'utf8'); },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.equal(
      workspaceArg(agentStartCall(calls)),
      'ws-captured',
      'second reviewer spawn must reuse the pinned workspace, not the live focus',
    );
  });

  it('does not invoke herdr pane list at all on a subsequent spawn when a pin exists', () => {
    // Spec contract (issue #19, step 2): the persisted workspace id is read
    // FIRST; the live `herdr pane list` shell-out (the backing query for
    // findHerdrWorkspace) is SKIPPED entirely once a pin exists, not merely
    // have its result discarded.
    const runId = 'review-pin-no-live-call';
    const reviewId = 'rev1';
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    mkdirSync(dirname(runYamlPathFor(runId)), { recursive: true });
    writeFileSync(runYamlPathFor(runId), `herdr_workspace: ws-captured\n`);

    const sentinelPath = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.claude.exit`);
    const { exec, calls } = makeExecReturningWorkspace('ws-focus-moved');

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('no live call review'),
        options({
          exec,
          sleep: () => { writeFileSync(sentinelPath, '0', 'utf8'); },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    const paneListCalls = calls.filter((c) => c.args[0] === 'pane' && c.args[1] === 'list');
    assert.equal(paneListCalls.length, 0, 'live pane list query must not be called once a pin exists');
    assert.equal(workspaceArg(agentStartCall(calls)), 'ws-captured');
  });

  it('HYDRA_HERDR_WORKSPACE_PIN=0 disables the pin and restores the live-query behavior', () => {
    const runId = 'review-pin-escape';
    const reviewId = 'rev1';
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    const previousPin = process.env.HYDRA_HERDR_WORKSPACE_PIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';
    process.env.HYDRA_HERDR_WORKSPACE_PIN = '0';

    // Pre-pin run.yaml with ws-captured; the escape hatch must skip it.
    mkdirSync(dirname(runYamlPathFor(runId)), { recursive: true });
    writeFileSync(runYamlPathFor(runId), `herdr_workspace: ws-captured\n`);

    const sentinelPath = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.claude.exit`);
    const { exec, calls } = makeExecReturningWorkspace('ws-live');

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('escape hatch review'),
        options({
          exec,
          sleep: () => { writeFileSync(sentinelPath, '0', 'utf8'); },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
      restoreEnv('HYDRA_HERDR_WORKSPACE_PIN', previousPin);
    }

    assert.equal(
      workspaceArg(agentStartCall(calls)),
      'ws-live',
      'escape hatch must live-query rather than reuse the pin',
    );
  });

  it('falls back to the live workspace when run.yaml is missing', () => {
    const runId = 'review-pin-missing';
    const reviewId = 'rev1';
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    // No run.yaml at all — the dispatch must not crash and must capture the
    // live value (which then gets persisted).
    rmSync(runYamlPathFor(runId), { force: true });

    const sentinelPath = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.claude.exit`);
    const { exec, calls } = makeExecReturningWorkspace('ws-live-missing-yaml');

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('missing yaml review'),
        options({
          exec,
          sleep: () => { writeFileSync(sentinelPath, '0', 'utf8'); },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.equal(workspaceArg(agentStartCall(calls)), 'ws-live-missing-yaml');
  });

  it('falls back to the live workspace when run.yaml cannot be read', () => {
    const runId = 'review-pin-corrupt';
    const reviewId = 'rev1';
    const previousPanes = process.env.HYDRA_HERDR_PANES;
    const previousTimeout = process.env.HYDRA_REVIEW_TIMEOUT_MIN;
    process.env.HYDRA_HERDR_PANES = '1';
    process.env.HYDRA_REVIEW_TIMEOUT_MIN = '1';

    // Replace run.yaml with a directory so yamlScalar's readFileSync throws
    // (EISDIR). The dispatch must not crash and must use the live value.
    mkdirSync(dirname(runYamlPathFor(runId)), { recursive: true });
    rmSync(runYamlPathFor(runId), { force: true });
    mkdirSync(runYamlPathFor(runId), { recursive: true });

    const sentinelPath = join(TEST_TMP, 'runs', `run-${runId}`, 'sessions', `${reviewId}.claude.exit`);
    const { exec, calls } = makeExecReturningWorkspace('ws-corrupt-fallback');

    try {
      reviewDispatch(
        runId,
        reviewId,
        'claude',
        writePrompt('corrupt yaml review'),
        options({
          exec,
          sleep: () => { writeFileSync(sentinelPath, '0', 'utf8'); },
        }),
      );
    } finally {
      restoreEnv('HYDRA_HERDR_PANES', previousPanes);
      restoreEnv('HYDRA_REVIEW_TIMEOUT_MIN', previousTimeout);
    }

    assert.equal(
      workspaceArg(agentStartCall(calls)),
      'ws-corrupt-fallback',
      'an unreadable run.yaml must fall back to a live query',
    );
  });

});
