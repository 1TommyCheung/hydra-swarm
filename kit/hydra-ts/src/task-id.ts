// ---------------------------------------------------------------------------
// Canonical identifier grammars (issue #32).
//
// This module is the single source of truth for every id that ends up inside
// a filesystem path in the review provenance lane. review-store.ts,
// review-dispatch.ts and run-log.ts all import from here — none of them may
// define (or re-export) a divergent validator of their own, so the store,
// the dispatcher and the reader can never disagree about which ids are legal.
// ---------------------------------------------------------------------------

/**
 * Canonical task-id grammar: 1-64 characters of lowercase [a-z0-9-], starting
 * and ending on [a-z0-9] (no leading/trailing hyphen). No dots (so no `..`
 * traversal), no separators, no whitespace, no uppercase, no underscore.
 * The length bound is enforced separately so the regex stays linear.
 */
export const TASK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Documented upper bound on a task id's length. */
export const TASK_ID_MAX_LENGTH = 64;

/** Human-readable statement of the grammar, for error messages and docs. */
export const TASK_ID_GRAMMAR =
  `1-${TASK_ID_MAX_LENGTH} characters of [a-z0-9-] with no leading/trailing hyphen`;

/** True when a value is a canonical task id (safe as a single path segment). */
export function isTaskId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= TASK_ID_MAX_LENGTH
    && TASK_ID_PATTERN.test(value)
  );
}

/**
 * Assert the canonical task-id grammar, throwing the shared rejection message
 * on failure. `label` names the offending field in the message (defaults to
 * `taskId`, the review-store spelling).
 */
export function assertTaskId(value: string, label = 'taskId'): string {
  if (!isTaskId(value)) {
    throw new Error(
      `${label}: invalid task identifier ${JSON.stringify(value)} — expected ${TASK_ID_GRAMMAR}`,
    );
  }
  return value;
}

/**
 * Safe-id grammar for run ids and review ids: a single bounded path segment —
 * alphanumeric start, then up to 63 more alphanumerics, underscore or hyphen.
 * No dots (so no `.`/`..` segments and no extension spoofing), no path
 * separators, no whitespace, no control bytes, and a hard 64-character bound.
 * review_id is the documented grammar for session artifact names
 * (`sessions/<review_id>.<vendor>.{md,raw,exit,pid,pane-progress.txt}`), so
 * an id that passes cannot escape the run's sessions directory.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Documented upper bound on a run/review id's length. */
export const SAFE_ID_MAX_LENGTH = 64;

/** True when an id is safe to embed in a filesystem path. */
export function isSafeId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}

export default {
  TASK_ID_PATTERN,
  TASK_ID_MAX_LENGTH,
  TASK_ID_GRAMMAR,
  isTaskId,
  assertTaskId,
  SAFE_ID_PATTERN,
  SAFE_ID_MAX_LENGTH,
  isSafeId,
};
