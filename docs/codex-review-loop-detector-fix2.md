# Third adversarial review: loop-thinking detector

## Overall verdict: ACCEPT

All four residuals from round 2 are **FIXED**. The new implementation closes the stale Stage-2 clock path, requires repeated failure evidence for Rule B and fresh failed cycle members for confirmation, and makes untracked-file inspection failures fail open through the whole-sample `gitUnknown` path. The three added tests reproduce the exact residual traces rather than merely testing nearby behavior.

The two low-severity cleanups are also present. Previously accepted findings 1, 5, 6, and 8 remain fixed; cancellation placement, exception containment, Claude exclusion, and shared current-attempt behavior were not weakened. I found no new correctness or autonomous-cancellation safety issue introduced by commit `5e43c21406bfeb4e72e55c8f2203916c63872848`.

The independently reported 689/689 full-suite result is acknowledged and was not re-run, as requested. This review is based on fresh source, commit-diff, call-site, and test inspection.

## Residual 1 — Stage 2 continuity: FIXED

The state machine now derives `activeKind` from the rules on every tick and requires an existing episode's kind and dominant pattern to remain active (`kit/hydra-ts/src/loop-detector.ts:869-889`). If the rule becomes inactive for any reason, including matching successes pushing failures out of Rule A's suffix, `episodeStillActive` is false; the detector calls `clearEpisode(..., 'pattern_changed', now)` and returns healthy (`kit/hydra-ts/src/loop-detector.ts:891-894`). `clearEpisode()` resets all rolling evidence and nulls the episode (`kit/hydra-ts/src/loop-detector.ts:639-655`). A later reactivation therefore creates a new episode with `suspectedAt: now` and zero fresh counters (`kit/hydra-ts/src/loop-detector.ts:919-932`), so it cannot reuse the old confirmation clock.

The exact round-2 trace is covered at `kit/hydra-ts/test/loop-detector.test.ts:708-751`:

1. Twelve matching failures plus the output floor create suspicion (`:713-721`).
2. Twenty successful runs of the same command make Rule A inactive and must return `cleared: true` (`:723-730`).
3. Time advances six minutes beyond the old confirmation window, then fresh failures reactivate only Stage 1 (`:732-742`).
4. Two more matching failures one millisecond later still cannot confirm from the discarded timestamp (`:744-751`).

This closes the stale-`suspectedAt` immediate-confirmation path.

## Residual 2 — Rule B failure recency and Stage-2 evidence: FIXED

Rule B no longer uses an existential `hasFailure`. Cycle detection counts failed members in the currently detected repeated suffix (`kit/hydra-ts/src/loop-detector.ts:564-583`), and Stage 1 requires at least two such failures (`kit/hydra-ts/src/loop-detector.ts:860-867`). Thus one stale transient failure followed by otherwise successful repetitions cannot even create an episode.

For an existing Rule-B episode, the fresh counter increments only when a newly stamped member both belongs to the cycle and has a `failureHash` (`kit/hydra-ts/src/loop-detector.ts:896-911`). Confirmation derives repetitions solely from that failed-member count and requires two fresh failed-cycle repetitions (`kit/hydra-ts/src/loop-detector.ts:938-946`). Successful matching repetitions no longer contribute.

The exact round-2 trace appears at `kit/hydra-ts/test/loop-detector.test.ts:754-783`: one failure at the start of a 40-event alternating cycle followed by successes remains healthy, and another 30 successful repetitions after twenty minutes produce neither suspicion nor confirmation. The positive Rule-B fixture was also tightened to contain repeated failures rather than a single transient one (`kit/hydra-ts/test/loop-detector.test.ts:442-458`).

The current 100-record cap still defines the detector's recent evidence horizon (`kit/hydra-ts/src/loop-detector.ts:770-775`), but the destructive Stage-2 decision additionally requires fresh post-suspicion failures. The round-2 successful-repetition cancellation path is gone.

## Residual 3 — Untracked-file fail-open: FIXED

`hashUntrackedFile()` no longer substitutes stable `missing` or `unreadable` literals. An absent stat result throws, an undefined read result throws, and thrown injected filesystem errors also propagate naturally (`kit/hydra-ts/src/loop-detector.ts:478-493`). Both calls execute inside `sampleGitSignature()`'s outer `try`; any such failure returns `{ signature: '', unknown: true }` for the whole Git sample (`kit/hydra-ts/src/loop-detector.ts:496-525`). The tick suppresses detection while `gitUnknown` is true (`kit/hydra-ts/src/loop-detector.ts:836-839`).

Recovery remains fail open: whether recovery establishes the first baseline or observes the previous signature again, `wasUnknown` resets `lastGitChangeAt` to the recovery time (`kit/hydra-ts/src/loop-detector.ts:797-817`). Unknown-period time cannot satisfy the stagnation threshold.

The regression at `kit/hydra-ts/test/loop-detector.test.ts:785-827` injects an unreadable listed untracked file, verifies `gitUnknown === true` and a healthy verdict, restores reads, verifies immediate recovery is still healthy, and advances a complete fresh ten-minute window before allowing suspicion. This mirrors the Git-command-failure recovery test at `kit/hydra-ts/test/loop-detector.test.ts:584-630`. The test directly exercises the read-failure branch; the adjacent stat-failure branch has the same explicit throw-to-outer-catch path at source level.

## Residual 4 — regression coverage: FIXED

The three new tests are genuine reproductions of the residuals:

| Residual | Evidence | Why it is sufficient |
| --- | --- | --- |
| Stale Stage-2 clock after inactive successes | `kit/hydra-ts/test/loop-detector.test.ts:708-751` | Reaches suspicion, deactivates with same-signature successes, crosses the old window, reactivates, and proves no immediate confirmation. |
| One stale Rule-B failure plus successful cycles | `kit/hydra-ts/test/loop-detector.test.ts:754-783` | Crosses both Stage-1 and Stage-2 time boundaries and asserts neither loop event is emitted. |
| Untracked inspection failure and recovery baseline | `kit/hydra-ts/test/loop-detector.test.ts:785-827` | Forces the per-file read failure, asserts whole-sample unknown suppression, recovers, and requires a fresh stagnation window. |

These tests target the exact round-2 counterexamples and would fail against the prior implementation.

## Low-severity cleanups

### 5. Kimi correlation-ID retention: CONFIRMED

Every insertion now enforces a maximum map size of 100 by evicting the oldest key (`kit/hydra-ts/src/loop-detector.ts:743-751`), and a correlated outcome consumes its entry (`kit/hydra-ts/src/loop-detector.ts:753-765`). Capture/evidence resets still clear the map as an additional guard (`kit/hydra-ts/src/loop-detector.ts:592-600`). A long attempt with unique IDs can no longer grow the map without bound.

### 6. Intentional all-evidence reset on pattern clear: CONFIRMED

The `clearEpisode()` documentation explicitly states that resetting action history, output floors, capture-growth state, and the Kimi map is an intentional conservative, false-negative-biased choice for auto-cancellation (`kit/hydra-ts/src/loop-detector.ts:631-637`). The episode-update comment explains that an inactive rule ends the episode to force a continuous confirmation window (`kit/hydra-ts/src/loop-detector.ts:881-884`), and both pattern-change call sites route through that documented helper (`kit/hydra-ts/src/loop-detector.ts:891-903`). The behavior is therefore explicit rather than an accidental side effect.

## Previously accepted findings and regression checks

- **Finding 1 remains fixed — Git progress clears historical evidence.** `resetRollingEvidence()` clears action, output-floor, capture, and correlation state (`kit/hydra-ts/src/loop-detector.ts:592-600`); the Git-change branch applies it whether or not an episode exists (`kit/hydra-ts/src/loop-detector.ts:824-834`).
- **Finding 5 remains fixed — current attempt and dispatch are revalidated.** The detector checks the latest task boundary plus both agent-run and dispatch identities (`kit/hydra-ts/src/loop-detector.ts:602-628`) immediately before Stage-2 and Stage-1 emission (`kit/hydra-ts/src/loop-detector.ts:951-954`, `:985-990`). Dispatch supplies the live ledger reader (`kit/hydra-ts/src/dispatch.ts:551-569`, `:1140-1157`, `:1221-1224`).
- **Finding 6 remains fixed — correlation IDs are not logical signatures.** Codex MCP hashes exclude call IDs (`kit/hydra-ts/src/loop-detector.ts:203-205`, `:224-232`); Kimi separates logical call hashes from correlation IDs and resolves failures back to the logical action (`kit/hydra-ts/src/loop-detector.ts:263-303`, `:740-767`). The new bounding/consumption cleanup does not change that matching behavior.
- **Finding 8 remains fixed — Git execution accepts `env`.** `ExecFileSyncLike` still declares `env?: NodeJS.ProcessEnv` (`kit/hydra-ts/src/dispatch.ts:28-32`).
- **Cancellation placement remains sound.** Detector-driven cancellation occurs only for `result.verdict === 'confirmed'`; suspicion returns without cancelling (`kit/hydra-ts/src/dispatch.ts:551-574`).
- **Exception containment remains sound.** The detector tick and verdict handling remain inside a fail-open catch that warns and returns without cancellation (`kit/hydra-ts/src/dispatch.ts:554-579`).
- **Claude and other non-streaming vendors remain excluded.** The allow-list contains only Codex, Kimi, and OpenCode, and the detector returns healthy before capture or Git work for every other vendor (`kit/hydra-ts/src/loop-detector.ts:118-119`, `:707-710`). Unit and dispatch coverage remain at `kit/hydra-ts/test/loop-detector.test.ts:461-469` and `kit/hydra-ts/test/dispatch.test.ts:1523-1540`.
- **Shared current-attempt behavior remains unchanged.** This commit does not modify `current-attempt.ts`, `status.ts`, or `cancel-task.ts`. The helper retains its newest-matching-boundary scan and slice behavior (`kit/hydra-ts/src/current-attempt.ts:21-36`), with status and cancellation still consuming it (`kit/hydra-ts/src/status.ts:373-401`, `kit/hydra-ts/src/cancel-task.ts:101-126`).

## Newly introduced issues

None identified. The new changes are conservative on the autonomous-cancellation boundary: they can delay or suppress cancellation when evidence is ambiguous, but they do not add a new route for healthy activity to reach `recorder.cancel()`.
