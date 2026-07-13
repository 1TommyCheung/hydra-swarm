import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, repoRoot, yamlList, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Risk-triggered cross-vendor review decision.
// ---------------------------------------------------------------------------

export interface ReviewDecision {
  cross_vendor_required: boolean;
  reviewer_vendor: string;
  reason: string;
}

export interface ReviewOptions {
  /** Path to the review policy YAML file. Defaults to the repo policy. */
  policyFile?: string;
}

function rank(risk: string): number {
  switch (risk) {
    case 'low':
      return 0;
    case 'medium':
      return 1;
    case 'high':
      return 2;
    case 'critical':
      return 3;
    default:
      return 0;
  }
}

/**
 * Decide whether cross-vendor review is required for a candidate.
 *
 * Mirrors hydra/scripts/review-required.sh: reads the review policy, compares
 * the supplied risk against the configured threshold, then checks labels for
 * any configured trigger label. If required, the reviewer vendor is read from
 * the policy's cross-vendor pairing table, falling back to 'any-other-vendor'.
 *
 * @param implementer - The vendor implementing the change (e.g. 'claude').
 * @param risk - The assessed risk level (low|medium|high|critical).
 * @param labels - Labels attached to the candidate.
 * @param options - Optional overrides, including the policy file path.
 * @returns The review decision object.
 */
export function reviewRequired(
  implementer: string,
  risk: string,
  labels: string[] = [],
  options: ReviewOptions = {},
): ReviewDecision {
  const policy =
    options.policyFile ?? join(repoRoot(), 'hydra', 'policies', 'review-policy.yaml');

  let riskAtLeast = yamlScalar(policy, '    risk_at_least');
  if (!riskAtLeast) riskAtLeast = 'high';

  const triggerLabels = yamlList(policy, '    labels_any');

  let required = false;
  let reason = 'no trigger matched (single-vendor review permitted)';

  if (rank(risk) >= rank(riskAtLeast)) {
    required = true;
    reason = `risk '${risk}' >= '${riskAtLeast}'`;
  } else {
    for (const label of labels) {
      if (triggerLabels.includes(label)) {
        required = true;
        reason = `label '${label}' triggers cross-vendor review`;
        break;
      }
    }
  }

  let reviewerVendor = 'any';
  if (required) {
    reviewerVendor = yamlScalar(policy, `    ${implementer}`);
    if (!reviewerVendor) reviewerVendor = 'any-other-vendor';
  }

  return {
    cross_vendor_required: required,
    reviewer_vendor: reviewerVendor,
    reason,
  };
}

export default {
  reviewRequired,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [implementer, risk, ...labels] = args;
    if (!implementer) {
      die('usage: review-required.sh <implementer_vendor> <risk> [label...]');
    }
    if (!risk) die('risk required (low|medium|high|critical)');
    process.stdout.write(`${JSON.stringify(reviewRequired(implementer, risk, labels))}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
