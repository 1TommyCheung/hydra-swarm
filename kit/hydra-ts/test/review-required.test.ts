import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewRequired } from '../src/review-required.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-review-required');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`;
}

function writePolicy(content: string): string {
  const p = join(TEST_TMP, uniqueName('review-policy'));
  writeFileSync(p, content, 'utf8');
  return p;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

before(() => mkdirSync(TEST_TMP, { recursive: true }));
after(cleanTmp);

describe('reviewRequired', () => {
  const basePolicy = `review_policy:
  cross_vendor_required_when:
    risk_at_least: high
    labels_any:
      - architecture
      - security
      - migration
      - public_api
  cross_vendor_pairing:
    claude: codex
    codex: claude
    opencode: codex
  default: single_vendor_ok
`;

  it('requires review when risk is at the threshold', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'high', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, true);
    assert.equal(decision.reviewer_vendor, 'codex');
    assert.match(decision.reason, /risk 'high' >= 'high'/);
  });

  it('requires review when risk exceeds the threshold', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('codex', 'critical', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, true);
    assert.equal(decision.reviewer_vendor, 'claude');
    assert.match(decision.reason, /risk 'critical' >= 'high'/);
  });

  it('does not require review when risk is below the threshold', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'medium', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, false);
    assert.equal(decision.reviewer_vendor, 'any');
    assert.match(decision.reason, /no trigger matched/);
  });

  it('requires review when a label matches a trigger label', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'medium', ['docs', 'security'], {
      policyFile: policy,
    });
    assert.equal(decision.cross_vendor_required, true);
    assert.equal(decision.reviewer_vendor, 'codex');
    assert.match(decision.reason, /label 'security' triggers cross-vendor review/);
  });

  it('matches trigger labels exactly', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'low', ['public-api'], {
      policyFile: policy,
    });
    assert.equal(decision.cross_vendor_required, false);
    assert.match(decision.reason, /no trigger matched/);
  });

  it('falls back to any-other-vendor when implementer has no pairing', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('unknown-vendor', 'high', [], {
      policyFile: policy,
    });
    assert.equal(decision.cross_vendor_required, true);
    assert.equal(decision.reviewer_vendor, 'any-other-vendor');
  });

  it('defaults risk threshold to high when policy omits it', () => {
    const policy = writePolicy(`review_policy:
  cross_vendor_required_when:
    labels_any:
      - security
  cross_vendor_pairing:
    claude: codex
`);
    const decision = reviewRequired('claude', 'medium', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, false);
    const highDecision = reviewRequired('claude', 'high', [], { policyFile: policy });
    assert.equal(highDecision.cross_vendor_required, true);
    assert.match(highDecision.reason, /risk 'high' >= 'high'/);
  });

  it('honours a custom risk threshold', () => {
    const policy = writePolicy(`review_policy:
  cross_vendor_required_when:
    risk_at_least: medium
    labels_any: []
  cross_vendor_pairing:
    claude: codex
`);
    const decision = reviewRequired('claude', 'medium', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, true);
    assert.match(decision.reason, /risk 'medium' >= 'medium'/);
  });

  it('treats unknown risk as low rank', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'unknown', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, false);
    assert.match(decision.reason, /no trigger matched/);
  });

  it('labels can trigger review regardless of risk level', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'low', ['migration'], {
      policyFile: policy,
    });
    assert.equal(decision.cross_vendor_required, true);
    assert.match(decision.reason, /label 'migration' triggers cross-vendor review/);
  });

  it('works with empty labels', () => {
    const policy = writePolicy(basePolicy);
    const decision = reviewRequired('claude', 'low', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, false);
    assert.equal(decision.reviewer_vendor, 'any');
  });

  it('resolves the default policy relative to the source file, not cwd', () => {
    // Running from a non-git directory would fail repoRoot()-based resolution,
    // proving the default policy is reached self-relative from the source file.
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'review-required.ts'),
        'claude',
        'low',
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.cross_vendor_required, false);
    assert.equal(decision.reviewer_vendor, 'any');
  });
});
