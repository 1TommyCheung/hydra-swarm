import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  defaultExec,
  reviewDispatch,
  type ReviewDispatchOptions,
  type ExecFn,
  type ExecResult,
} from '../src/review-dispatch.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-review-dispatch');

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
    writeFileSync(
      join(home, '.bash_profile'),
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

  it('copies the whole raw stream when any JSONL line is malformed', () => {
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

    assert.equal(readFileSync(mdPath, 'utf8'), raw);
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
    assert.equal(ledgerEvents(runId).at(-1)?.exit_code, '?');
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
    writeFileSync(
      join(home, '.bash_profile'),
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
      ['--experimental-strip-types', source, 'cli-run', 'rev1', 'claude', prompt],
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
