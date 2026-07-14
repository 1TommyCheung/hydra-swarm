# Loop-thinking detector design (Kimi)

**Task:** #31 — async completion + hang detection (last remaining piece).

**Scope:** build-ready design brief for the loop-thinking detector. This document is grounded in the **current** implementation, not the pre-implementation speculative state of `docs/async-trigger-design-codex.md` and `docs/async-trigger-design-kimi.md`.

**Key files read for verification:**
- `kit/hydra-ts/src/dispatch.ts`
- `kit/hydra-ts/src/status.ts`
- `kit/hydra-ts/src/cancel-task.ts`
- `kit/hydra-ts/test/dispatch.test.ts`
- `kit/hydra-ts/test/status.test.ts`
- `kit/hydra-ts/test/cancel-task.test.ts`
- `kit/hydra/scripts/cancel-task.sh`
- `kit/hydra/scripts/status.sh`

## Grounding: what exists now

The harness already solves most of Task #31. The loop detector must fit into these exact mechanisms rather than reinvent them:

1. **`dispatch_instance_id` on every ledger event.** `dispatch.ts:1096-1106` creates a per-invocation random ID and includes it in `task_started` and every terminal event.
2. **Supervisor pidfile.** `dispatch.ts:1167-1171` publishes `sessions/supervisor/<agentRunId>.dispatch.pid` after the slot is acquired and removes it on completion.
3. **Pane worker liveness.** `dispatch.ts:957-998` already detects a pane worker that dies before writing its exit sentinel and records `agent_exited` with `reason: worker_disappeared`.
4. **Per-vendor raw capture files.** Codex/Kimi write `sessions/<agentRunId>.cli.jsonl`; OpenCode writes `sessions/<agentRunId>.events.jsonl`; all vendors write `sessions/<agentRunId>.stderr`. Claude currently writes only a final `sessions/<agentRunId>.cli.json` at exit.
5. **`status.ts` current-attempt scoping.** `status.ts:120-135` defines `currentAttemptEvents()`: scan backward for the newest `task_started` whose `agent_run_id` matches the current `agentRunId`, then take everything from that line. Any future one-shot diagnostic must reuse this exact algorithm.
6. **Safe cancellation.** `cancel-task.ts:264-456` provides `cancelTask(runId, taskId, options)` with injectable `processAlive`, `signalProcess`, `listProcesses`, and `sleep`. It validates dispatcher identity, sends SIGTERM, waits for a terminal ledger event, and escalates to SIGKILL only as a last resort. It never fabricates a ledger event.

## Goal

Add a detector that notices when a dispatch is **alive**, still **producing output**, but making **no real progress** — e.g., repeating the same failing tool call or reasoning in circles. It must reuse the existing cancellation machinery, avoid duplicating kill-tree logic, and be deterministically testable with the same injectable-clock/fake-fs patterns used by the existing test suite.

## Detection signals

The detector combines two orthogonal signals. Both must be true to raise a suspicion, and both must persist for an additional confirmation window before auto-cancellation.

### Signal A — capture growth without Git progress

**Data sources:**
- Capture byte counters for the raw streams the dispatcher already knows about:
  - Codex/Kimi: `sessions/<agentRunId>.cli.jsonl` + `sessions/<agentRunId>.stderr`
  - OpenCode: `sessions/<agentRunId>.events.jsonl` + `sessions/<agentRunId>.stderr`
  - Claude: `sessions/<agentRunId>.stderr` only while running (final `.cli.json` is unavailable until exit)
- Git worktree signature, computed from:
  - `git -C <worktree> rev-parse HEAD`
  - `git -C <worktree> status --porcelain=v1 --untracked-files=all`
  - `git -C <worktree> diff --no-ext-diff --binary HEAD --`

**Algorithm:**

```text
gitSignature = sha256(HEAD + "\0" + status + "\0" + diff)
captureBytes = sum(size of watched raw capture files)

if captureBytes > lastCaptureBytes + MIN_GROWTH_BYTES:
    captureIsGrowing = true

if gitSignature != lastGitSignature:
    gitProgress = true
    stagnationMs = 0

if captureIsGrowing and not gitProgress:
    stagnationMs += pollIntervalMs
else:
    stagnationMs = 0
```

**Thresholds:**
- `STAGNATION_WINDOW = 10 minutes`
- `MIN_GROWTH_BYTES = 512`

**Justification:** A healthy implementer eventually produces a commit, a staged change, or at least a changing dirty tree. If the vendor is streaming output (capture is growing) but the worktree signature has been frozen for 10 minutes, the agent is either reasoning in circles or retrying a failing operation. The 10-minute window is long enough to avoid false positives from legitimate multi-step reasoning (e.g., a long test run or analysis phase) but catches loops well before the default 45-minute `timeout_minutes` inactivity limit. The 512-byte floor filters tiny log noise while still catching a single repeated stderr line.

### Signal B — repetitive actionable fingerprints

**Data sources:** same raw capture files, parsed incrementally.

**Vendor-specific action fingerprints** (free-form assistant text is ignored because it changes even inside a loop):

- **Codex** (`dispatch.ts:588-630`):
  - `item.started` + `command_execution` → `cmd:<command[:200]>`
  - `item.started` + `file_change` → `edit:<sorted basenames>`
  - `item.started` + `mcp_tool_call` → `tool:<server>.<tool>`
- **Kimi** (`dispatch.ts:632-644`):
  - assistant message containing `tool_calls[].function` → `tool:<name>(<canonical args>)`
  - assistant message with text only → `say:<text[:200]>`
- **OpenCode** (`dispatch.ts:677-690`):
  - `part.type === 'tool'` → `tool:<tool>(<state.title>)`
  - `part.type === 'text'` → ignored
- **Claude:** no streaming JSONL while running; skip Signal B and rely on Signal A + stderr.

**Algorithm:**

```text
newFingerprints = extract fingerprints from complete new JSONL records since last offset
if every fingerprint in newFingerprints already exists in recentHistory:
    repetitionCount += 1
else:
    repetitionCount = 0
    recentHistory = last FINGERPRINT_LOOKBACK actionable fingerprints

if repetitionCount >= REPEAT_THRESHOLD within REPETITION_WINDOW:
    repetitiveLoop = true
```

**Thresholds:**
- `REPEAT_THRESHOLD = 6`
- `REPETITION_WINDOW = 10 minutes`
- `FINGERPRINT_LOOKBACK = 12`

**Justification:** A legitimate edit/test cycle may repeat a command 2-3 times, but 6 consecutive repeated actionable fingerprints with no Git progress strongly indicates a retry loop (e.g., the same failing test command or the same read call). The 10-minute window matches Signal A so the two signals align. Keeping the last 12 fingerprints catches alternating loops (A-B-A-B-A-B) as well as exact repeats.

## Where the detector runs

**Recommendation: integrate the detector into the existing `dispatch.ts` polling loop.**

The detector runs on every `pollIntervalMs` tick (default 2 seconds), after the existing activity/timeout checks. It applies to both `runWorkerPlain()` and `runWorkerInHerdrPane()`.

**Why not a separate one-shot script?**
- A one-shot script (mirroring `status.sh`) requires a human or external cron to run it. Loop detection is a safety feature; unattended background dispatches (`--background`) would keep looping until the hard cap fires.
- The dispatch loop already owns the `ExitRecorder`, the worker PID, the capture paths, and the ledger appender. Moving detection out would duplicate state discovery and widen race windows.

**Tradeoffs:**

| Approach | Pros | Cons |
|---|---|---|
| Integrated in dispatch loop | Automatic, low latency, reuses existing timing and context | Slightly more logic in `dispatch.ts` |
| One-shot `detect-loop.sh` | Simpler, manual control | Misses unattended background dispatches, duplicates `currentAttemptEvents`/pidfile logic |

The integrated detector is gated by `HYDRA_LOOP_DETECTOR=0` so it can be disabled for debugging or for tasks where false positives are expected.

## What happens on detection

Two-stage escalation:

### Stage 1 — suspicion

When both Signal A and Signal B are true for `STAGNATION_WINDOW`, append one nonterminal ledger event:

```json
{
  "time": "2026-07-14T10:10:00Z",
  "event": "agent_loop_suspected",
  "run_id": "0042",
  "task_id": "canvas-node-validation",
  "vendor": "kimi",
  "agent_run_id": "0042-canvas-node-validation-v1",
  "dispatch_instance_id": "8d2f...",
  "reason": "loop_thinking",
  "stagnant_sec": "600",
  "repetition_count": "6",
  "capture_bytes": "24576",
  "git_signature": "sha256:abc..."
}
```

`status.sh` / `status.ts` will surface this event in `ledger_events` so a human can intervene before auto-cancellation.

### Stage 2 — confirmation and auto-cancellation

If the same dominant action/failure remains present for an additional `CONFIRMATION_WINDOW = 5 minutes` (15 minutes total stagnation), cancel the task through the existing clean cancellation path.

**Cancellation path:** the integrated detector invokes the existing `ExitRecorder.cancel()` method directly (`dispatch.ts:330-345`). This is the same primitive that `cancelTask()` triggers via SIGTERM: it kills the worker tree, appends `agent_cancelled`, writes the exit sentinel, releases the slot, and closes the pane. We do **not** call `cancelTask()` or `cancel-task.sh` from inside the dispatcher, because that would mean the dispatch process signals itself.

**Why auto-cancel is safe enough without a human in the loop:**
- The decision requires **two independent signals** (capture growth + repetition) to be true simultaneously.
- Each signal must persist for a **long window** (10 minutes), and auto-cancel requires a **second confirmation window** (5 minutes).
- Any genuine progress — a Git signature change or a new non-repeating actionable event — resets both counters.
- A human can cancel at any time after the `agent_loop_suspected` event; the detector stops once a terminal event is recorded.
- The cancellation uses the proven `ExitRecorder.cancel()` path already used by SIGTERM handling; no new kill primitive is introduced.

## Concrete implementation sketch

### New module: `kit/hydra-ts/src/loop-detector.ts`

Pure logic, no side effects except reading files. Returns a decision object and an updated state object.

```typescript
export interface LoopDetectorOptions {
  worktree: string;
  sessionsDir: string;
  agentRunId: string;
  vendor: string;
  pollIntervalMs: number;
  // test injection points
  clock?: Clock;
  readFile?: (path: string) => Buffer | undefined;
  execGit?: (args: string[]) => string;
}

export interface LoopDetectorState {
  lastCaptureBytes: number;
  lastGitSignature: string;
  lastGitSampleMs: number;
  fingerprintHistory: string[];
  stagnationMs: number;
  repetitionCount: number;
  suspectedAtMs: number | null;
  captureOffsets: Record<string, number>;
}

export interface LoopDetectorResult {
  suspicion: 'none' | 'suspected' | 'confirmed';
  metrics: {
    stagnantSec: number;
    repetitionCount: number;
    captureBytes: number;
    gitSignature: string;
  };
}

export function createLoopDetectorState(): LoopDetectorState;

export function detectLoop(
  state: LoopDetectorState,
  nowMs: number,
  options: LoopDetectorOptions,
): { state: LoopDetectorState; result: LoopDetectorResult };
```

Responsibilities:
- Sample capture bytes incrementally.
- Sample Git signature every `GIT_SAMPLE_INTERVAL_MS = 30_000` (or every 15th poll tick, whichever is longer).
- Parse new complete JSONL records from raw capture files and extract vendor-specific fingerprints.
- Update stagnation/repetition counters.
- Return `suspected` once, then `confirmed` if conditions persist.

Constants:

```typescript
const STAGNATION_WINDOW_MS = 10 * 60 * 1000;
const CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;
const REPETITION_WINDOW_MS = 10 * 60 * 1000;
const REPEAT_THRESHOLD = 6;
const FINGERPRINT_LOOKBACK = 12;
const MIN_GROWTH_BYTES = 512;
const GIT_SAMPLE_INTERVAL_MS = 30_000;
```

### Modify `kit/hydra-ts/src/dispatch.ts`

1. Add `loopDetector?: LoopDetectorState` to `WorkerContext` (`dispatch.ts:271-300`).
2. Initialize state in `dispatch()` after `ctx` is built.
3. In both `runWorkerPlain()` and `runWorkerInHerdrPane()` polling loops, after the existing activity/timeout checks, call `detectLoop()`:

```typescript
if (ctx.env.HYDRA_LOOP_DETECTOR !== '0' && !recorder.isRecorded()) {
  const { state: nextState, result } = detectLoop(ctx.loopDetector!, ctx.clock.now(), {
    worktree: ctx.worktree,
    sessionsDir: ctx.sessionsDir,
    agentRunId: ctx.agentRunId,
    vendor: ctx.vendor,
    pollIntervalMs: ctx.pollIntervalMs,
    clock: ctx.clock,
  });
  ctx.loopDetector = nextState;

  if (result.suspicion === 'suspected') {
    ctx.appendLedger(ctx.runId, 'agent_loop_suspected',
      'task_id', ctx.taskId,
      'vendor', ctx.vendor,
      'agent_run_id', ctx.agentRunId,
      'reason', 'loop_thinking',
      'stagnant_sec', String(result.metrics.stagnantSec),
      'repetition_count', String(result.metrics.repetitionCount),
      'capture_bytes', String(result.metrics.captureBytes),
      'git_signature', result.metrics.gitSignature,
    );
  } else if (result.suspicion === 'confirmed') {
    ctx.appendLedger(ctx.runId, 'agent_loop_suspected',
      'task_id', ctx.taskId,
      'vendor', ctx.vendor,
      'agent_run_id', ctx.agentRunId,
      'reason', 'loop_thinking_confirmed',
      'stagnant_sec', String(result.metrics.stagnantSec),
      'repetition_count', String(result.metrics.repetitionCount),
    );
    recorder.cancel();
    return;
  }
}
```

### Event scoping

Because the detector only runs while dispatch is active for the current attempt, it naturally operates on the current attempt. If a one-shot diagnostic is added later, it must reuse `status.ts`'s `currentAttemptEvents()` exactly (`status.ts:120-135`).

### Graceful degradation for non-streaming vendors

- **Claude** has no streaming JSONL while running. Signal B is skipped; Signal A still works via stderr + Git.
- If capture files are missing, capture bytes are 0; stagnation only triggers if bytes grow, so missing files cannot false-positive.
- If Git commands fail, conservatively treat `gitSignature` as unchanged to avoid false positives.

## Testability with injectable clock / fake-fs

The existing test suite already provides the exact patterns to use:

- **`StepClock` / `GateClock`** (`dispatch.test.ts:181-215`) injected via `DispatchOptions.clock`.
- **`FakeChild` and `fakeSpawn`** (`dispatch.test.ts:114-159`) for process simulation.
- **Direct `writeFileSync` / `mkdirSync` in `tmpdir()`** for fake filesystem state.
- **Injectable `processAlive`, `signalProcess`, `listProcesses`, `sleep`** in `cancel-task.test.ts`.

The loop detector follows the same model:

1. **Injectable clock:** `LoopDetectorOptions.clock` mirrors `DispatchOptions.clock`. Tests advance time through `clock.sleep()` or `StepClock`.
2. **Injectable filesystem and Git:** `LoopDetectorOptions.readFile` and `LoopDetectorOptions.execGit` let tests supply file contents and Git outputs without real Git operations.
3. **Deterministic unit tests** in `kit/hydra-ts/test/loop-detector.test.ts`:
   - `stagnation resets on git signature change`
   - `stagnation detected when capture grows but git is frozen`
   - `repetition detected for codex command_execution`
   - `repetition resets on new action`
   - `confirmation escalates to confirmed after 15 minutes`
   - `terminal ledger event stops detector`
   - `claude degrades to signal A only`
   - `malformed JSONL is tolerated`
4. **Integration tests** in `kit/hydra-ts/test/dispatch.test.ts`:
   - A fake worker writes repeated Codex/Kimi events to `.cli.jsonl` without Git progress; verify the ledger ends with `agent_cancelled`.
   - A fake worker writes growing capture and commits to the worktree; verify the task completes normally.

## Files changed

- `docs/loop-detector-design-kimi.md` (this document)

## Implementation order for the follow-up build task

1. Add `kit/hydra-ts/src/loop-detector.ts` with pure detection logic and unit tests.
2. Wire the detector into the `dispatch.ts` polling loops behind `HYDRA_LOOP_DETECTOR`.
3. Add dispatch-level integration tests for confirmed loop cancellation and healthy-progress non-cancellation.
4. Update `status.ts` to display `agent_loop_suspected` events in `ledger_events`.
5. Run `npm run test:concurrent` and `npm run typecheck`.

## Risks and unresolved questions

- **False positives on long-running analysis tasks:** A task that legitimately streams tokens for 10+ minutes before the first edit could be flagged. Mitigation: the 10-minute window plus the requirement for repetitive fingerprints; a single long reasoning burst without repeated tool calls will not trigger Signal B.
- **Git sampling cost:** `git status` + `git diff` every 30 seconds is acceptable for most repos but could be slow on huge worktrees. Future optimization: set `GIT_OPTIONAL_LOCKS=0` and consider a longer interval.
- **Vendor capture format drift:** Codex/Kimi/OpenCode JSONL shapes may change. Fingerprint extractors must degrade gracefully (return no fingerprint rather than crash) on unknown shapes.
