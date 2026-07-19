import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyUsageLimitLine,
  createUsageDetectorState,
  usageDetectorTick,
} from '../src/usage-detector.ts';

const TEST_TMP = mkdtempSync(join(tmpdir(), 'hydra-usage-detector-'));
let sequence = 0;

// The incident line captured verbatim from a genuinely rate-limited
// `opencode run --print-logs --log-level DEBUG` invocation (run 0055 spec).
const INCIDENT_LINE = 'timestamp=2026-07-19T18:32:04.123Z level=ERROR run=6f8a1c2d message="stream error" '
  + 'providerID=zai-coding-plan modelID=glm-5.2 session.id=ses_9f2 small=false agent=build mode=primary '
  + 'error.error="AI_APICallError: Usage limit reached for 5 hour. Your limit will reset at 2026-07-19 18:37:11"';

function streamErrorLine(errorText: string): string {
  return `timestamp=2026-07-19T18:32:04.123Z level=ERROR run=6f8a1c2d message="stream error" `
    + `providerID=zai-coding-plan modelID=glm-5.2 session.id=ses_9f2 small=false agent=build mode=primary `
    + `error.error="${errorText}"`;
}

function sessionsDir(): { dir: string; agentRunId: string; capturePath: string } {
  sequence += 1;
  const dir = join(TEST_TMP, `sessions-${sequence}`);
  mkdirSync(dir, { recursive: true });
  const agentRunId = `run-${sequence}-task-a-v1`;
  return { dir, agentRunId, capturePath: join(dir, `${agentRunId}.stderr`) };
}

describe('classifyUsageLimitLine', () => {
  it('classifies the real captured incident line as an exact usage_window match', () => {
    const match = classifyUsageLimitLine(INCIDENT_LINE, 'opencode');
    assert.ok(match);
    assert.equal(match.vendor, 'opencode');
    assert.equal(match.provider, 'zai-coding-plan');
    assert.equal(match.model, 'glm-5.2');
    assert.equal(match.limitKind, 'usage_window');
    assert.equal(match.source, 'stderr');
    assert.equal(match.confidence, 'exact');
    assert.equal(match.retryable, true);
    assert.ok(match.rawError.includes('Usage limit reached for 5 hour'));
    // The raw string has no zone designator; the CLI logs in host-local time,
    // so the retry_at must equal the local-time parse converted to UTC.
    assert.equal(match.retryAt, new Date('2026-07-19T18:37:11').toISOString());
    assert.match(match.retryAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('never matches the same phrase in untrusted, assistant-authored content', () => {
    const untrusted = [
      // Assistant chat text echoed as an opencode stdout JSON event.
      '{"type":"text","part":{"text":"The provider said: Usage limit reached for 5 hour. Your limit will reset at 2026-07-19 18:37:11"}}',
      // The bare phrase on its own (e.g. file contents or tool output).
      'Usage limit reached for 5 hour. Your limit will reset at 2026-07-19 18:37:11',
      // Chat-like prose quoting the phrase.
      'assistant: I hit "usage limit reached" so I stopped the task',
      // The phrase in a non-ERROR log record.
      'timestamp=2026-07-19T18:32:04.123Z level=INFO message="Usage limit reached for 5 hour"',
      // level=ERROR but the phrase sits in the message field, not error.error.
      'timestamp=2026-07-19T18:32:04.123Z level=ERROR message="Usage limit reached for 5 hour"',
      // Trusted shape, but the stream error is not a limit error at all.
      streamErrorLine('AI_APICallError: invalid API key provided'),
      streamErrorLine('AI_APICallError: connection reset by peer'),
      // Structured shape missing the message field entirely.
      'timestamp=2026-07-19T18:32:04.123Z level=ERROR error.error="AI_APICallError: Usage limit reached for 5 hour"',
    ];
    for (const line of untrusted) {
      assert.equal(classifyUsageLimitLine(line, 'opencode'), null, `should not match: ${line}`);
    }
  });

  it('classifies rate-limit phrasing as rate_limit', () => {
    for (const text of ['AI_APICallError: Rate limit exceeded', 'AI_APICallError: 429 Too Many Requests']) {
      const match = classifyUsageLimitLine(streamErrorLine(text), 'opencode');
      assert.ok(match);
      assert.equal(match.limitKind, 'rate_limit');
      assert.equal(match.confidence, 'exact');
      assert.equal(match.retryable, true);
    }
  });

  it('classifies quota phrasing as quota_exhausted', () => {
    const match = classifyUsageLimitLine(
      streamErrorLine('AI_APICallError: quota exceeded for this billing period'),
      'opencode',
    );
    assert.ok(match);
    assert.equal(match.limitKind, 'quota_exhausted');
    assert.equal(match.retryable, false);
  });

  it('rejects a structured-looking line missing AI_APICallError', () => {
    // Every other trusted marker is present and the error.error text carries
    // genuine limit phrasing, but without the vendor SDK's own error class the
    // line must not classify at any confidence level.
    const candidates = [
      streamErrorLine('Usage limit reached for 5 hour. Your limit will reset at 2026-07-19 18:37:11'),
      streamErrorLine('Rate limit exceeded'),
      streamErrorLine('429 Too Many Requests'),
      streamErrorLine('quota exceeded for this billing period'),
    ];
    for (const line of candidates) {
      assert.ok(!line.includes('AI_APICallError'), `fixture must lack the SDK class marker: ${line}`);
      assert.equal(classifyUsageLimitLine(line, 'opencode'), null, `must not classify: ${line}`);
    }
  });

  it('rejects an invalid calendar date instead of fabricating a retry_at', () => {
    // JS's Date constructor silently normalizes impossible calendar values
    // (2026-02-30 -> 2026-03-02), so these must yield no retryAt at all while
    // the line itself still classifies on its limit phrasing.
    for (const bad of [
      '2026-02-30 12:00:00',
      '2026-04-31 12:00:00',
      '2026-07-19 24:00:00',
      '2026-07-19 12:60:00',
      '2026-07-19 12:00:60',
    ]) {
      const match = classifyUsageLimitLine(
        streamErrorLine(`AI_APICallError: Usage limit reached for 5 hour. Your limit will reset at ${bad}`),
        'opencode',
      );
      assert.ok(match, `line still classifies: ${bad}`);
      assert.equal(match.limitKind, 'usage_window');
      assert.equal('retryAt' in match, false, `no fabricated retryAt for: ${bad}`);
    }
    // A valid leap-year date (2028 is a leap year) must still parse.
    const leap = classifyUsageLimitLine(
      streamErrorLine('AI_APICallError: Usage limit reached for 5 hour. Your limit will reset at 2028-02-29 12:00:00'),
      'opencode',
    );
    assert.equal(leap?.retryAt, new Date('2028-02-29T12:00:00').toISOString());
  });

  it('omits retryAt when the reset timestamp is missing or unparseable', () => {
    const noReset = classifyUsageLimitLine(streamErrorLine('AI_APICallError: Usage limit reached for 5 hour'), 'opencode');
    assert.ok(noReset);
    assert.equal('retryAt' in noReset, false);

    for (const text of [
      'AI_APICallError: Usage limit reached. Your limit will reset at soon',
      'AI_APICallError: Usage limit reached. Your limit will reset at 2026-13-45 99:99:99',
    ]) {
      const match = classifyUsageLimitLine(streamErrorLine(text), 'opencode');
      assert.ok(match, `should still match: ${text}`);
      assert.equal('retryAt' in match, false, `retryAt must be omitted: ${text}`);
    }
  });

  it('honors an explicit zone designator on the reset timestamp', () => {
    const match = classifyUsageLimitLine(
      streamErrorLine('AI_APICallError: Usage limit reached. Your limit will reset at 2026-07-19T18:37:11Z'),
      'opencode',
    );
    assert.ok(match);
    assert.equal(match.retryAt, '2026-07-19T18:37:11.000Z');
  });

  it('returns null for non-opencode vendors', () => {
    for (const vendor of ['claude', 'codex', 'kimi']) {
      assert.equal(classifyUsageLimitLine(INCIDENT_LINE, vendor), null);
    }
  });
});

describe('usageDetectorTick', () => {
  it('returns no match when the capture file does not exist yet, then matches once it appears', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    const state = createUsageDetectorState();
    const options = { vendor: 'opencode', sessionsDir: dir, agentRunId };

    assert.equal(usageDetectorTick(state, options).match, null);
    assert.equal(state.matched, false);

    writeFileSync(capturePath, `${INCIDENT_LINE}\n`, 'utf8');
    const { match } = usageDetectorTick(state, options);
    assert.ok(match);
    assert.equal(match.limitKind, 'usage_window');
    assert.equal(state.matched, true);
  });

  it('handles multiple new lines arriving in a single read', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    const state = createUsageDetectorState();
    const noise = [
      'timestamp=2026-07-19T18:30:00.000Z level=ERROR run=6f8a1c2d message="some other error" error.error="AI_APICallError: connection reset by peer"',
      'plain noise that mentions usage limit reached without any structure',
    ];
    writeFileSync(capturePath, `${noise.join('\n')}\n${INCIDENT_LINE}\n`, 'utf8');

    const { match } = usageDetectorTick(state, { vendor: 'opencode', sessionsDir: dir, agentRunId });
    assert.ok(match);
    assert.equal(match.limitKind, 'usage_window');
  });

  it('reads only bytes appended since the previous tick', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    const state = createUsageDetectorState();
    const options = { vendor: 'opencode', sessionsDir: dir, agentRunId };

    writeFileSync(capturePath, 'noise line one\nnoise line two\n', 'utf8');
    assert.equal(usageDetectorTick(state, options).match, null);
    const offsetAfterNoise = state.offset;

    appendFileSync(capturePath, `${INCIDENT_LINE}\n`, 'utf8');
    const { match } = usageDetectorTick(state, options);
    assert.ok(match);
    assert.ok(state.offset > offsetAfterNoise);
  });

  it('does not consume a partial line until its newline arrives', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    const state = createUsageDetectorState();
    const options = { vendor: 'opencode', sessionsDir: dir, agentRunId };

    writeFileSync(capturePath, INCIDENT_LINE, 'utf8');
    assert.equal(usageDetectorTick(state, options).match, null);

    appendFileSync(capturePath, '\n', 'utf8');
    assert.ok(usageDetectorTick(state, options).match);
  });

  it('never re-fires once a match has been recorded', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    const state = createUsageDetectorState();
    const options = { vendor: 'opencode', sessionsDir: dir, agentRunId };

    writeFileSync(capturePath, `${INCIDENT_LINE}\n`, 'utf8');
    assert.ok(usageDetectorTick(state, options).match);

    appendFileSync(capturePath, `${INCIDENT_LINE}\n`, 'utf8');
    assert.equal(usageDetectorTick(state, options).match, null);
  });

  it('is disabled entirely by HYDRA_USAGE_DETECTOR=0', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    writeFileSync(capturePath, `${INCIDENT_LINE}\n`, 'utf8');
    const state = createUsageDetectorState();

    const { match } = usageDetectorTick(state, {
      vendor: 'opencode',
      sessionsDir: dir,
      agentRunId,
      env: { HYDRA_USAGE_DETECTOR: '0' },
    });
    assert.equal(match, null);
    assert.equal(state.enabled, false);
  });

  it('is a no-op for non-opencode vendors even with the incident text present', () => {
    const { dir, agentRunId, capturePath } = sessionsDir();
    writeFileSync(capturePath, `${INCIDENT_LINE}\n`, 'utf8');
    const state = createUsageDetectorState();

    const { match } = usageDetectorTick(state, { vendor: 'codex', sessionsDir: dir, agentRunId });
    assert.equal(match, null);
    assert.equal(state.enabled, false);
  });
});
