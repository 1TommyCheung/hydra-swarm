# Follow-up adversarial review: loop-thinking detector fix

## Overall verdict: REJECT

The fix materially improves the detector, but it does not close all of the prior safety findings. Findings 1, 5, 6, and 8 are fixed. Findings 2, 3, 4, and 7 are only partially fixed. The exact “different action after suspicion” and “all repeated actions succeed” examples now stay safe, but Stage 2 can reuse an old episode after the underlying rule was temporarily inactive, Rule B can still auto-cancel after one stale transient failure followed by successful cycles, and untracked-file read/stat failures still produce a known Git sample. Those are unacceptable residual false-positive paths for autonomous cancellation.

The reported 686/686 full-suite result is acknowledged and was not re-run, as requested. This review is based on fresh source, diff, and test inspection of fix commit `b63ec49aeb9b50dfc28a8bcb5d7e43f690dfde20` against its parent.

## Finding 1 — evidence survives Git progress: FIXED

`resetRollingEvidence()` clears both action arrays, the meaningful-event and raw-byte floors, capture-growth state, and the Kimi correlation map (`kit/hydra-ts/src/loop-detector.ts:592-600`). Failure counts have no separate accumulator: they are derived from `recentActions` by `countMatchingFailures()` (`loop-detector.ts:545-562`), so clearing `recentActions` also clears failure evidence.

The actual Git-progress path is:

1. A successful changed fingerprint sets `lastGitSignature`, advances `lastGitChangeAt`, and sets `gitChangedThisTick` (`loop-detector.ts:792-795`).
2. If an episode exists, the tick calls `clearEpisode(..., 'git_progress', now)` and returns healthy (`loop-detector.ts:811-815`). `clearEpisode()` emits the clear, calls `resetRollingEvidence()`, and nulls the episode (`loop-detector.ts:631-648`), thereby also discarding the episode's fresh counters.
3. If no episode exists, the same Git-change branch still calls `resetRollingEvidence()` (`loop-detector.ts:816-817`). Thus progress cannot leave evidence waiting to seed a later episode.

The new test first reaches suspicion, changes the fingerprint, then supplies only a few post-progress failures plus diverse work and requires healthy (`kit/hydra-ts/test/loop-detector.test.ts:481-525`). This would fail under the rejected implementation because the pre-progress suffix and floors remained populated.

## Finding 2 — Stage 2 confirms on elapsed time alone: PARTIALLY FIXED

The exact reported scenario is fixed. An episode stores fresh counters initialized to zero (`kit/hydra-ts/src/loop-detector.ts:906-919`). Post-suspicion matching failures/cycle members increment those counters, while any newly observed non-member signature immediately clears the episode (`loop-detector.ts:873-889`). At five minutes, Rule A requires at least two fresh matching failures and Rule B requires at least two fresh cycle repetitions; otherwise the episode is cleared rather than confirmed (`loop-detector.ts:925-937`). Therefore, after suspicion, one different recognized action at minute five takes the `pattern_changed` clear at lines 878-880 and never reaches confirmation. With silence/no new signature, the fresh count remains zero and lines 934-936 clear it.

However, the confirmation window is still not a continuous qualifying window. When the active rule becomes false, the episode is cleared only if the current tick contains no signature matching the old action/cycle (`loop-detector.ts:891-899`). Matching **successes** are not qualifying Rule-A failure evidence, but they match the dominant action and therefore preserve `suspectedAt` and the accumulated fresh-failure count. `activeKind === null` then returns healthy without clearing the episode (`loop-detector.ts:902-904`). If failures later make Rule A active again, Stage 2 uses the original `suspectedAt` and can confirm immediately once the retained fresh count is at least two (`loop-detector.ts:922-937`), rather than beginning a new five-minute confirmation window at reactivation.

Concrete trace: suspect on 12 failures; append enough successful runs of the same command to push matching failures below six, so Rule A becomes inactive but the episode survives because every new hash still matches; wait beyond five minutes; append enough failures in one tick to restore six failures in the 12-action suffix. The old episode is active again, its old clock has elapsed, and it can confirm immediately. The different-action regression test at `loop-detector.test.ts:527-552` genuinely covers the original exact example, but it does not cover this same-signature/non-qualifying interval.

## Finding 3 — Rule B can auto-cancel healthy repeated successes: PARTIALLY FIXED

The exact all-success scenario is fixed. Cycle detection now reports whether any member record has a `failureHash` (`kit/hydra-ts/src/loop-detector.ts:564-583`), and Rule B requires `cycle.hasFailure` before Stage 1 (`loop-detector.ts:844-851`). A repeated passing test command, or a passing period-2/3/4 cycle, cannot reach suspicion or confirmation with no failure signal. The new test runs a large passing cycle beyond both the 15-minute Rule-B window and the confirmation delay and asserts that neither loop event appears (`kit/hydra-ts/test/loop-detector.test.ts:554-581`); this genuinely crosses the old dangerous boundary.

The predicate is nevertheless too weak for safe cancellation. `hasFailure` is existential over the entire repeated suffix (`loop-detector.ts:579-582`), not a repeated or current failure requirement. The positive Rule-B test itself constructs 30 alternating events with only event zero failed and events 1-29 successful, yet expects suspicion (`loop-detector.test.ts:442-457`). During Stage 2, Rule B increments `freshMatchingActions` for every matching cycle member regardless of success/failure (`loop-detector.ts:886-888`) and confirms after two fresh repetitions (`loop-detector.ts:928-933`). Thus one transient old failure followed by 29 successful cycle events can start Stage 1, and four more successful events for a period-2 cycle can satisfy fresh confirmation and auto-cancel while that old failure remains in the 100-record suffix. This is still the prior class of healthy repeated work reaching cancellation, only narrowed from zero failures to one stale failure.

## Finding 4 — Git sampling not fully fail-open: PARTIALLY FIXED

Both specifically requested command/recovery changes are fixed:

- `listUntrackedFiles()` no longer catches `ls-files`; the exception reaches `sampleGitSignature()`'s outer catch, which marks the whole sample `{ signature: '', unknown: true }` (`kit/hydra-ts/src/loop-detector.ts:472-475`, `497-525`). Detection returns healthy while `gitUnknown` is true (`loop-detector.ts:820-823`).
- On recovery, both the no-prior-baseline path and same-signature path set `lastGitChangeAt = now` when `wasUnknown` is true (`loop-detector.ts:781-801`). A fresh 10- or 15-minute known window is therefore required.

The new test throws specifically from `ls-files`, verifies unknown/healthy, recovers after 30 seconds and remains healthy, then advances a fresh ten minutes before expecting suspicion (`kit/hydra-ts/test/loop-detector.test.ts:583-629`). It genuinely tests command failure and recovery-clock reset.

The prior finding also identified untracked-file stat/read failure. That part is unchanged: `hashUntrackedFile()` converts stat failure to the literal `missing` and read failure to `unreadable` (`kit/hydra-ts/src/loop-detector.ts:477-494`), after which `sampleGitSignature()` still returns `unknown: false` (`loop-detector.ts:510-522`). If the initial baseline repeatedly cannot inspect an untracked file, same-path rewrites can remain hidden behind a stable marker and detection remains enabled. No new test injects an untracked-file stat/read failure. The Git sampler is therefore not fully fail-open.

## Finding 5 — no current-attempt/dispatch identity check before emitting: FIXED

Production dispatch now supplies a ledger reader to every detector tick (`kit/hydra-ts/src/dispatch.ts:551-569`, `1140-1157`, `1219-1224`). `isCurrentAttemptValid()` filters to the detector's task, calls the shared `currentAttemptEvents()` helper, verifies both `agent_run_id` and `dispatch_instance_id`, and rejects any later `task_started` (`kit/hydra-ts/src/loop-detector.ts:608-629`). Both Stage 1 and Stage 2 invoke this check immediately before emitting their respective loop events (`loop-detector.ts:938-941`, `972-977`). Ledger-read failure returns false (`loop-detector.ts:609-615`), which is fail-open for cancellation.

In the stale-dispatch scenario, A's old `task_started` is selected for A, but B's later `task_started` exists after it, so line 628 rejects A. For a duplicate same-version dispatch, the shared helper scans backward to B's newer same-`agent_run_id` boundary (`kit/hydra-ts/src/current-attempt.ts:21-36`), and A then fails the dispatch-instance comparison at `loop-detector.ts:624`.

The detector test places B's boundary after A's and proves A cannot emit suspicion (`kit/hydra-ts/test/loop-detector.test.ts:631-679`). The status test separately proves an in-order old suspicion before B's boundary is not surfaced for B (`kit/hydra-ts/test/status.test.ts:160-184`). The detector test exercises the important prevention boundary; it does not exercise duplicate same-version dispatches or Stage-2 revalidation, but both use the same helper path.

## Finding 6 — invocation IDs pollute logical signatures: FIXED

Codex MCP hashes now use only server/tool, excluding item/call IDs in both start and completion records (`kit/hydra-ts/src/loop-detector.ts:202-205`, `223-232`). OpenCode hashes use tool/title and exclude `part.id` (`loop-detector.ts:309-342`). Kimi hashes name/arguments while storing `tc.id` separately as `correlationId` (`loop-detector.ts:262-275`); tool outcomes carry the correlation ID and failure marker without inventing a logical hash (`loop-detector.ts:287-303`). The tick maps correlation ID to logical hash and derives the outcome failure hash from that logical action (`loop-detector.ts:732-750`).

For 12 Kimi calls with IDs `call-0` through `call-11`, all starts now have one logical hash, and all outcomes resolve back to it. The test supplies 12 distinct IDs, asserts suspicion, and verifies all 12 failures are counted (`kit/hydra-ts/test/loop-detector.test.ts:681-705`). This directly fails under the rejected ID-bearing/synthetic-outcome implementation and is genuine coverage of the original scenario. Direct different-ID equality assertions for Codex and OpenCode are still absent, although their source-level normalization is clear.

## Finding 7 — safety-focused tests stop before dangerous boundaries: PARTIALLY FIXED

All six required tests are present, and each is more than a superficial happy path:

| Required test | Assessment | Evidence |
| --- | --- | --- |
| Git-progress evidence reset | Genuine | Reaches Stage 1, changes Git, then proves sparse post-progress failures cannot reuse the old suffix/floors (`loop-detector.test.ts:481-525`). |
| Stage 2 requires fresh evidence | Genuine for the exact prior scenario | Reaches Stage 1, advances five minutes, appends a different action, and requires clear/no confirm (`loop-detector.test.ts:527-552`). It misses inactive-rule intervals containing same-signature successes. |
| Rule B cannot fire on success | Genuine for zero failures | Crosses 15 minutes and another 20 minutes with a large successful cycle and requires no suspicion/confirmation (`loop-detector.test.ts:554-581`). It misses one stale failure followed by successes. |
| Git failure suppresses detection with fresh recovery baseline | Genuine for command failure | Makes `ls-files` throw, checks unknown suppression, checks immediate recovery remains healthy, and requires a fresh ten-minute window (`loop-detector.test.ts:583-629`). It misses untracked stat/read failure. |
| Stale attempt cannot appear active | Genuine for a newer-version boundary | Places a newer `task_started` before A's tick and proves A emits no loop event (`loop-detector.test.ts:631-679`); the status boundary test is at `status.test.ts:160-184`. Duplicate same-version and Stage-2 cases are not explicit. |
| Invocation IDs stripped from matching | Genuine for Kimi | Uses 12 unique IDs for one logical call and verifies a dominant 12-failure action (`loop-detector.test.ts:681-705`). Codex/OpenCode different-ID variants are not explicit. |

The main destructive integration path also now appends fresh failures through confirmation before asserting suspected, confirmed, kill, and final cancellation (`kit/hydra-ts/test/dispatch.test.ts:1440-1468`). However, because the suite encodes the weak “one failure anywhere” Rule-B predicate (`loop-detector.test.ts:442-457`) and omits the remaining Git-read and stale-episode variants, Finding 7 is only partially fixed.

## Finding 8 — TypeScript `env` option mismatch: FIXED

`ExecFileSyncLike` now includes `env?: NodeJS.ProcessEnv` in its options type (`kit/hydra-ts/src/dispatch.ts:28-32`), matching `runGit()`'s call with `env` (`kit/hydra-ts/src/loop-detector.ts:458-469`) and the test's access to `options?.env` (`kit/hydra-ts/test/loop-detector.test.ts:281-295`). The prior excess-property/unknown-property mismatch is resolved.

## Regression check

- **Cancellation placement remains sound.** Detector-driven cancellation still occurs only when the tick returns `confirmed` (`kit/hydra-ts/src/dispatch.ts:551-572`). Suspicion returns without calling `recorder.cancel()`.
- **Tick exception containment remains sound.** The entire detector call and verdict handling remain inside a catch that warns and returns false (`dispatch.ts:554-579`), preserving worker monitoring/cleanup.
- **Claude/non-streaming vendors remain excluded from both stages.** The detector returns healthy before capture/Git work for vendors outside the streaming allow-list (`kit/hydra-ts/src/loop-detector.ts:117-118`, `699-702`), with unit and dispatch coverage at `loop-detector.test.ts:460-469` and `dispatch.test.ts:1523-1540`.
- **Shared current-attempt behavior was not weakened by this fix.** The fix commit does not modify `current-attempt.ts`, `status.ts`, or `cancel-task.ts` production code. The helper retains its backward scan/slice semantics (`kit/hydra-ts/src/current-attempt.ts:21-36`); status and cancellation still consume it (`kit/hydra-ts/src/status.ts:373-401`, `kit/hydra-ts/src/cancel-task.ts:101-126`).

## Newly introduced issues

### New issue A — correlation map is unbounded until an unrelated reset

- **Severity:** low
- **Evidence:** Every Kimi tool start inserts its invocation ID into `correlationIdToHash` (`kit/hydra-ts/src/loop-detector.ts:735-738`). Successful and failed outcomes do not delete the entry after lookup (`loop-detector.ts:739-750`). The map is cleared only by `resetRollingEvidence()` (`loop-detector.ts:592-600`), which depends on capture reset, Git progress, or episode clear rather than normal outcome completion.
- **Impact:** A long-running Kimi attempt with unique per-call IDs and no Git/capture reset grows this map without the 100-record bound applied to action history. This is a resource-retention regression introduced by the correlation fix. Delete a correlation entry after consuming its outcome and/or impose a fixed bound.

### New issue B — any pattern clear now erases all rolling evidence

- **Severity:** low (false-negative bias)
- **Evidence:** `clearEpisode()` now always calls `resetRollingEvidence()` (`kit/hydra-ts/src/loop-detector.ts:631-648`), and every nonmatching post-suspicion signature invokes `clearEpisode(..., 'pattern_changed', ...)` (`loop-detector.ts:873-880`). Before this fix, pattern change cleared only the episode; the shared evidence reset was introduced by this commit.
- **Impact:** One anomalous action in an otherwise genuine loop erases action history and both output floors. If the agent immediately resumes looping, it must rebuild the suffix/floors before suspicion can recur. The Git stagnation clock is not reset, so this delays rather than permanently disables detection, but periodic one-off actions can repeatedly erase evidence and produce a false negative. This is conservative for autonomous cancellation and is not the reason for rejection, but it should be an explicit design choice rather than an accidental consequence of sharing the Git-progress reset helper.

## Required remediation before acceptance

1. End an episode whenever its underlying rule becomes inactive, or reset `suspectedAt` and fresh counters when it reactivates, so Stage 2 always observes a genuinely continuous new confirmation window.
2. Make Rule B require repeated/current failure evidence, including fresh failure evidence during Stage 2; successful cycle members alone must not satisfy confirmation after one stale failure.
3. Treat any required untracked-file stat/read failure as making the whole Git sample unknown and add a recovery-baseline test for that path.
4. Add regressions for the three cases above. Bound or consume the new correlation map, and decide/document whether pattern-change clearing should reset all floors.
