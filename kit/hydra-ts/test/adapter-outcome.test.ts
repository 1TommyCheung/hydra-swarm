import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyClaudeOutcome } from '../src/adapter-outcome.ts';

const quotaEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  result: 'API Error: Usage credits required ...',
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
};

describe('classifyClaudeOutcome', () => {
  it('does not trust subtype success over vendor-owned error fields', () => {
    const outcome = classifyClaudeOutcome(JSON.stringify(quotaEnvelope));
    assert.equal(outcome?.kind, 'usage_limited');
    if (outcome?.kind !== 'usage_limited') return;
    assert.equal(outcome.details.vendor, 'claude');
    assert.equal(outcome.details.limitKind, 'rate_limit');
    assert.equal(outcome.details.source, 'structured_event');
    assert.equal(outcome.details.confidence, 'exact');
  });

  it('classifies structured non-quota API errors as terminal failures', () => {
    for (const envelope of [
      { ...quotaEnvelope, api_error_status: 500, result: 'API Error: Internal server error' },
      { ...quotaEnvelope, api_error_status: 401, result: 'API Error: Authentication failed' },
      { ...quotaEnvelope, api_error_status: 400, result: 'API Error: Context rejected' },
    ]) {
      assert.equal(classifyClaudeOutcome(JSON.stringify(envelope))?.kind, 'terminal_failure');
    }
  });

  it('only considers quota markers after a vendor-owned structured error gate', () => {
    const assistantText = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'API Error: Usage credits required and HTTP 429 quota exhausted',
    };
    assert.equal(classifyClaudeOutcome(JSON.stringify(assistantText))?.kind, 'success');
  });

  it('preserves genuine success and leaves legacy envelopes unavailable', () => {
    assert.equal(classifyClaudeOutcome(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'done',
    }))?.kind, 'success');
    assert.equal(classifyClaudeOutcome(JSON.stringify({ session_id: 'legacy-test' })), null);
  });

  it('fails conservatively on malformed Claude JSON', () => {
    assert.equal(classifyClaudeOutcome('{not json')?.kind, 'terminal_failure');
  });
});
