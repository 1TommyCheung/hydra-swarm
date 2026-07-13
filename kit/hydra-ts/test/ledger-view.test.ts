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
import { renderLedgerView } from '../src/ledger-view.ts';
import { authDir, ledger, runDir } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-ledger-view');
const ORIGINAL_STATE_ROOT = process.env.HYDRA_STATE_ROOT;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface RunFixture {
  runId: string;
  ledgerPath: string;
  runYamlPath: string;
}

function setupRun(runId: string, baseCommit: string, ledgerLines: string[]): RunFixture {
  const root = runDir(runId);
  const ledgerPath = ledger(runId);
  const runYamlPath = join(root, 'run.yaml');

  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(runYamlPath, `base_commit: ${baseCommit}\n`, 'utf8');
  writeFileSync(
    ledgerPath,
    ledgerLines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join(''),
    'utf8',
  );

  return { runId, ledgerPath, runYamlPath };
}

describe('renderLedgerView', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });

  after(() => {
    cleanTmp();
    if (ORIGINAL_STATE_ROOT === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = ORIGINAL_STATE_ROOT;
    }
  });

  it('renders an authoritative ledger view with counts and rows', () => {
    const runId = uniqueRunId('happy');
    setupRun(runId, 'abc123', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
      JSON.stringify({
        time: '2024-01-01T00:01:00Z',
        event: 'result_promoted',
        run_id: runId,
        summary: 'all good',
      }),
    ]);

    const out = renderLedgerView(runId);

    assert.equal(out, join(authDir(runId), 'ledger-view.html'));
    assert.ok(existsSync(out));

    const html = readFileSync(out, 'utf8');
    assert.match(html, new RegExp(`<title>Hydra-Swarm run ${runId} — authoritative ledger</title>`));
    assert.match(html, new RegExp(`<h1>Hydra-Swarm — run ${runId}</h1>`));
    assert.match(html, /base abc123/);
    assert.match(html, /<b>2<\/b>events/);
    assert.match(html, /<b>1<\/b>promoted/);
    assert.match(html, /<b>0<\/b>rejected/);
    assert.match(html, /<tr class="ev-run_started">/);
    assert.match(html, /<tr class="ev-result_promoted">/);
    assert.match(html, /summary=all good/);
  });

  it('throws when the ledger is missing', () => {
    const runId = uniqueRunId('no-ledger');
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(join(runDir(runId), 'run.yaml'), 'base_commit: abc123\n', 'utf8');

    assert.throws(() => renderLedgerView(runId), /no ledger for run/);
  });

  it('writes to a custom output path when provided', () => {
    const runId = uniqueRunId('custom-out');
    setupRun(runId, 'def456', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
    ]);

    const customOut = join(TEST_TMP, `custom-${runId}.html`);
    const out = renderLedgerView(runId, customOut);

    assert.equal(out, customOut);
    assert.ok(existsSync(customOut));
  });

  it('HTML-escapes detail values', () => {
    const runId = uniqueRunId('escape');
    setupRun(runId, 'abc123', [
      JSON.stringify({
        time: '2024-01-01T00:00:00Z',
        event: 'review_verdict',
        run_id: runId,
        note: 'a <b>bold</b> "quote" & more',
      }),
    ]);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.doesNotMatch(html, /a <b>bold<\/b>/);
    assert.match(html, /note=a &lt;b&gt;bold&lt;\/b&gt; &quot;quote&quot; &amp; more/);
  });

  it('renders non-string detail values with jq interpolation semantics', () => {
    const runId = uniqueRunId('detail-types');
    setupRun(runId, 'abc123', [
      JSON.stringify({
        time: '2024-01-01T00:00:00Z',
        event: 'result_promoted',
        run_id: runId,
        files_changed: ['src/a.ts', 'src/b.ts'],
        review: { approved: true, score: 2 },
        risks: null,
        complete: false,
      }),
    ]);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /files_changed=\[&quot;src\/a\.ts&quot;,&quot;src\/b\.ts&quot;\]/);
    assert.match(html, /review=\{&quot;approved&quot;:true,&quot;score&quot;:2\}/);
    assert.match(html, /risks=null/);
    assert.match(html, /complete=false/);
  });

  it('leaves event and time raw like the jq row template', () => {
    const runId = uniqueRunId('raw-row');
    setupRun(runId, 'abc123', [
      JSON.stringify({
        time: '<time-marker>',
        event: '<event-marker>',
        run_id: runId,
        detail: '<escaped-marker>',
      }),
    ]);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /<tr class="ev-<event-marker>"><td class="t"><time-marker><\/td><td class="e"><event-marker><\/td>/);
    assert.match(html, /detail=&lt;escaped-marker&gt;/);
  });

  it('counts promoted and rejected events from ledger lines', () => {
    const runId = uniqueRunId('counts');
    setupRun(runId, 'abc123', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
      JSON.stringify({ time: '2024-01-01T00:01:00Z', event: 'result_promoted', run_id: runId }),
      JSON.stringify({ time: '2024-01-01T00:02:00Z', event: 'result_promoted', run_id: runId }),
      JSON.stringify({ time: '2024-01-01T00:03:00Z', event: 'result_rejected', run_id: runId }),
    ]);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /<b>4<\/b>events/);
    assert.match(html, /<b>2<\/b>promoted/);
    assert.match(html, /<b>1<\/b>rejected/);
  });

  it('renders an empty base when base_commit is empty', () => {
    const runId = uniqueRunId('empty-base');
    setupRun(runId, '', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
    ]);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /base  · rendered/);
  });

  it('renders an empty base when base_commit is absent', () => {
    const runId = uniqueRunId('absent-base');
    const fixture = setupRun(runId, 'unused', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
    ]);
    writeFileSync(fixture.runYamlPath, 'run_id: something-else\n', 'utf8');

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /base  · rendered/);
  });

  it('defaults base_commit to ? when run.yaml is missing', () => {
    const runId = uniqueRunId('missing-run-yaml');
    const fixture = setupRun(runId, 'unused', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
    ]);
    rmSync(fixture.runYamlPath);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /base \?/);
  });

  it('logs the rendered view and prints its output path', () => {
    const runId = uniqueRunId('output');
    setupRun(runId, 'abc123', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId }),
    ]);
    let stdout = '';
    let stderr = '';
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    let out: string;
    try {
      out = renderLedgerView(runId);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    assert.equal(stdout, `${out}\n`);
    assert.equal(stderr, `hydra: authoritative ledger view -> ${out} (1 events)\n`);
  });

  it('renders an empty ledger with zero counts', () => {
    const runId = uniqueRunId('empty');
    setupRun(runId, 'abc123', []);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /<b>0<\/b>events/);
    assert.match(html, /<b>0<\/b>promoted/);
    assert.match(html, /<b>0<\/b>rejected/);
    assert.match(html, /<table><\/table>/);
  });

  it('includes CSS event classes for known event types', () => {
    const runId = uniqueRunId('classes');
    setupRun(runId, 'abc123', [
      JSON.stringify({ time: '2024-01-01T00:00:00Z', event: 'result_rejected', run_id: runId }),
      JSON.stringify({ time: '2024-01-01T00:01:00Z', event: 'task_spec_amended', run_id: runId }),
    ]);

    const out = renderLedgerView(runId);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /<tr class="ev-result_rejected">/);
    assert.match(html, /<tr class="ev-task_spec_amended">/);
  });
});
