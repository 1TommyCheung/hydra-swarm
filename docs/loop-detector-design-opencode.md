# Loop-Thinking Detector — Build-Ready Design

**Ticket:** #31 (last remaining piece: loop-thinking detection)
**Scope:** Design for detecting an agent that is alive and producing output but making
no real progress — stuck retrying the same failing tool call or reasoning in circles.

**Grounded in:** the current merged `dispatch.ts`, `status.ts`, and `cancel-task.ts`
(as of base commit `0af2b29`), not the speculative pre-implementation state of the
prior design docs.

---

## 0. Problem Statement

The existing timeout system in `dispatch.ts` has two timers per worker:

- **`waited`** (inactivity): resets to 0 whenever the capture-file size signature
  changes (`plainActivity()` at `dispatch.ts:492` / `herdrActivity()` at
  `dispatch.ts:503`).
- **`elapsed`** (hard cap): never resets; defaults to `timeout_minutes * 6`.

**The gap:** an agent that is alive and streaming output — even repeating the same
failing tool call indefinitely — will always have a changing size signature (each
retry appends bytes to `.cli.jsonl` / `.events.jsonl` / `.stderr`). The `waited`
counter never reaches `limit`, so `agent_timed_out` with `reason: "stalled"` never
fires. The only backstop is the hard cap, which defaults to **6x the timeout** —
e.g., 270 minutes for a 45-minute task. That is enormously wasteful.

A loop-thinking detector closes this gap by looking at **what** the agent is
producing (semantic content), not just **how much** (byte sizes).

---

## 1. Detection Signals

Three complementary signals. The detector requires **Signal A AND Signal B** to
fire; Signal C is confirmatory only.

### Signal A — Semantic tool-call repetition (streaming vendors only)

**Source files:**

| Vendor | Capture file | Parser (existing) |
|---|---|---|
| Codex | `<sessions>/<agent_run_id>.cli.jsonl` | `codexEventText()` (`dispatch.ts:588`) |
| Kimi | `<sessions>/<agent_run_id>.cli.jsonl` | `kimiEventText()` (`dispatch.ts:632`) |
| OpenCode | `<sessions>/<agent_run_id>.events.jsonl` | `monitorEventText()` (`dispatch.ts:677`) |
| Claude | (none while running) | N/A — degrade to Signal B only |

**Mechanism:** incrementally parse new JSONL records from the raw capture file
using the same offset-tracking pattern as `pollJsonlFile()` (`dispatch.ts:650`).
For each actionable record, compute a normalized signature:

```
<vendor>:<action-kind>:sha256(canonical_payload)
```

Action kinds and payload per vendor:

| Vendor | Event pattern | Kind | Canonical payload |
|---|---|---|---|
| Codex | `item.started` + `command_execution` | `cmd` | command with absolute worktree paths stripped to relative, newlines→spaces, truncated at 200 chars |
| Codex | `item.started` + `file_change` | `edit` | sorted basenames of changed paths |
| Codex | `item.started` + `mcp_tool_call` | `tool` | `server.tool` |
| Kimi | `role: assistant` + `tool_calls[].function` | `tool` | `function.name` + JSON-stringified arguments with absolute paths stripped, truncated at 200 chars |
| Kimi | `role: assistant` + `content` (non-empty string) | `text` | first 200 chars of content |
| OpenCode | `part.type: tool` | `tool` | `tool` name + `state.title` |
| OpenCode | `part.type: text` | `text` | first 200 chars of text |

**Failure fingerprint:** when a tool-call action is followed by an error outcome
(vendor-specific — see below), compute a separate fingerprint:

```
fail:<action-signature>:sha256(error_marker)
```

Error markers:
- **Codex:** `item.completed` with a nonzero exit status following a
  `command_execution`, or an error field in an `mcp_tool_call` result.
- **Kimi:** `role: tool` message whose content matches `/error|fail|exception/i`.
- **OpenCode:** tool part with `state.error` or `state.status: "error"`.

For V1, if error parsing is too fragile, a simpler proxy works: an action
signature that appears more than `repeatThreshold` times without any new unique
action signature appearing is already strong evidence of failure repetition.

### Signal B — Worktree Git stagnation

**Source:** the task's worktree directory (from `TaskSpec.worktree`, read by
`readTaskSpec()` in `dispatch.ts:205`).

**Mechanism:** every `gitSampleIntervalMs` (default 30s = every 15th poll tick at
2s interval), compute a content-sensitive Git signature:

```bash
GIT_OPTIONAL_LOCKS=0 git -C <worktree> rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C <worktree> diff --no-ext-diff HEAD --
GIT_OPTIONAL_LOCKS=0 git -C <worktree> status --porcelain -z
```

Concatenate stdout from all three commands, SHA-256 the result. This detects:
- New commits (HEAD changes)
- Working-tree content changes (diff changes — including same-size rewrites)
- Staged/unstaged/new/deleted file changes (status changes)

`GIT_OPTIONAL_LOCKS=0` prevents contention with worker-side git operations.

**Why `--no-ext-diff`:** external diff tools may not exist in the harness
environment and add nondeterminism.

**Why `diff HEAD --` (not `diff --cached`):** we want unstaged changes too, since
an agent may be editing files without staging them. The full working-tree diff
captures both staged and unstaged changes.

### Signal C — Repeated stderr lines (confirmatory)

**Source:** `<sessions>/<agent_run_id>.stderr`

**Mechanism:** tail the last 50 non-empty lines. If any single line accounts for
>60% of the tail, this is confirmatory evidence of an error loop.

This signal alone is insufficient (verbose tools produce repeated warnings), but
it strengthens the case when combined with A and B.

---

## 2. Thresholds and Windows

All defaults are configurable via `HYDRA_LOOP_*` environment variables, set once
at dispatch start and stored in the detector state.

### Primary detection window: 10 minutes

```
HYDRA_LOOP_WINDOW_MS = 600_000  (10 minutes)
```

**Justification — false positive tradeoff:**
- 10 minutes of repeated identical tool calls with zero worktree change is already
  abnormal. Normal iterative development (run tests → fix → re-run) produces file
  changes between repetitions, which breaks the git-stagnation condition.
- A healthy agent that is "thinking" (producing reasoning text without tool calls)
  will have a changing text signature or will eventually act. 10 minutes of pure
  reasoning without any tool call or file change is rare for implementation tasks.

**Justification — false negative tradeoff:**
- 10 minutes is short enough that a looping agent wastes at most ~10 minutes
  before suspicion is flagged, versus the current hard-cap default of potentially
  270 minutes. The confirmation window adds 5 more minutes before action, for a
  total of ~15 minutes — still 18x faster than the current backstop.

### Confirmation window: 5 minutes additional

```
HYDRA_LOOP_CONFIRM_MS = 300_000  (5 minutes)
```

After initial suspicion, require 5 more minutes of the SAME dominant action with
no worktree change. This gives the agent a chance to break out (e.g., if it was
exploring different approaches that happen to share a tool-call signature).

### Repetition thresholds

| Parameter | Default | Justification |
|---|---|---|
| `repeatSetSize` | 12 | Rolling window of recent action signatures. At 2s poll, this covers ~24s+ of activity. Large enough to smooth over transient bursts. |
| `repeatThreshold` | 8 | One signature appears ≥8 times in the 12-action window (67%). Deliberately high to avoid false positives from legitimate repeated operations (e.g., running `npm test` 3-4 times while iterating on a fix). |
| `maxUniqueActions` | 2 | A healthy agent uses many tools (read, edit, bash, etc.). A looping agent typically cycles between 1-2 actions. |
| `minMatchingFailures` | 4 | At least 4 actions in the window must have failure fingerprints. Repeated successes (e.g., legitimate `git status` polling) should not trigger the detector. |
| `minCaptureGrowthBytes` | 8192 | Capture files must have grown by ≥8 KiB in the window. Below this, the agent is effectively idle and the existing stalled timeout handles it. |
| `gitSampleIntervalMs` | 30000 | Git is sampled every 30s (every 15th tick at 2s). `rev-parse + diff + status` on a typical repo takes <50ms; 30s spacing keeps overhead negligible. |

### Non-streaming vendor window (Claude): 20 minutes, suspicion only

For vendors without streaming capture (Claude), Signal A is unavailable. Use a
**longer window** (20 minutes) and **never auto-cancel** — only flag suspicion.
The existing hard-cap timeout remains the backstop.

```
HYDRA_LOOP_NONSTREAMING_WINDOW_MS = 1_200_000  (20 minutes)
```

---

## 3. Architecture: Where the Detector Runs

### Recommendation: Integrated into `dispatch.ts`'s polling loops

The detector hooks into the existing poll loop in both `runWorkerPlain()`
(`dispatch.ts:815-838`) and `runWorkerInHerdrPane()` (`dispatch.ts:972-998`).

**Why not a separate one-shot/periodic script:**

1. **Cancellation safety:** the in-process detector can call `ExitRecorder.cancel()`
   directly — the same clean path used by `AbortSignal` and signal handlers. A
   separate script would need to call `cancelTask()` (SIGTERM → wait → SIGKILL),
   which is designed for external/human invocation and is more complex.

2. **No state-file management:** the detector state lives in a local variable in
   the worker function. A separate script would need persistent state files under
   `sessions/` (introducing stale-state and race problems, as noted in the prior
   Codex design's concern about supervisor subdirectories).

3. **No process discovery:** a separate script would need to duplicate
   `cancel-task.ts`'s pidfile + process-discovery logic to find the dispatch
   process — complexity that is already solved by being in-process.

4. **Existing precedent:** `openOpencodeMonitor()` (`dispatch.ts:692`) already
   demonstrates the pattern of per-tick incremental JSONL parsing within the
   dispatch lifecycle.

5. **Automatic coverage:** every dispatched task gets loop detection for free,
   with no lead action required.

**Tradeoff acknowledged:** adding ~1 git exec per 15 ticks and JSONL parsing per
tick increases per-tick cost. At 2s intervals with a 30s git cadence, this is
negligible. The `execFileSync` override in tests means git is never actually
invoked in unit tests.

**The detector core is a pure function** (see §6), so a future one-shot
`detect-loop.ts` could wrap the same logic for lead-invoked checks. The
integration point is the primary mechanism; the one-shot is a future option, not
a dependency.

### New module: `kit/hydra-ts/src/loop-detector.ts`

This keeps the detection logic separate from the dispatch orchestration, making
it independently testable. The module exports:

```typescript
// Pure detection function — no I/O, no clock, fully deterministic
export function detectLoop(
  state: LoopDetectorState,
  input: LoopDetectorInput,
): LoopDetectorResult;

// I/O helpers — used by dispatch.ts, injectable in tests
export function sampleGitSignature(
  worktree: string,
  execFileSync: ExecFileSyncLike,
): string;

export function parseActionSignatures(
  capturePath: string,
  offset: number,
  vendor: string,
): { signatures: ActionSignature[]; newOffset: number };

// State factory
export function createLoopDetectorState(): LoopDetectorState;
```

---

## 4. Data Structures

```typescript
export type LoopVerdict = 'healthy' | 'suspected' | 'confirmed';

export interface ActionSignature {
  signature: string;        // "<vendor>:<kind>:sha256(...)"
  timestamp: number;        // clock.now() when observed
  isFailure: boolean;
  failureFingerprint?: string;
}

export interface LoopDetectorState {
  // Capture file parsing
  captureOffset: number;
  
  // Rolling action window
  recentActions: ActionSignature[];
  
  // Git tracking
  lastGitSignature: string;
  lastGitChangeTime: number;      // clock.now() when git signature last changed
  lastGitSampleTime: number;
  
  // Capture growth tracking
  lastCaptureSize: number;
  lastCaptureChangeTime: number;
  
  // Suspicion episode
  suspicionStartTime: number | null;
  suspicionDominantAction: string | null;
  suspicionEmitted: boolean;
  
  // Stderr analysis
  lastStderrSize: number;
}

export interface LoopDetectorInput {
  now: number;
  vendor: string;
  newActions: ActionSignature[];
  captureSize: number;
  gitSignature: string;
  gitSampled: boolean;             // true if git was sampled this tick
  stderrRepetitionRatio: number;   // 0..1, or 0 if no stderr
  
  // Thresholds (with defaults filled in)
  windowMs: number;
  confirmMs: number;
  repeatSetSize: number;
  repeatThreshold: number;
  maxUniqueActions: number;
  minMatchingFailures: number;
  minCaptureGrowthBytes: number;
}

export interface LoopDetectorResult {
  verdict: LoopVerdict;
  state: LoopDetectorState;        // updated state (immutable copy)
  metrics?: {
    dominantActionHash: string;
    dominantActionCount: number;
    uniqueActionCount: number;
    matchingFailureCount: number;
    captureGrowthBytes: number;
    gitStagnationSeconds: number;
    windowSeconds: number;
  };
}
```

---

## 5. Detection Algorithm (Pure Function)

```typescript
export function detectLoop(
  prev: LoopDetectorState,
  input: LoopDetectorInput,
): LoopDetectorResult {
  const state: LoopDetectorState = { ...prev };
  
  // 1. Update capture growth tracking
  const captureGrew = input.captureSize - state.lastCaptureSize;
  if (captureGrew > 0) {
    state.lastCaptureSize = input.captureSize;
    state.lastCaptureChangeTime = input.now;
  }
  
  // 2. Update git tracking (only if git was sampled this tick)
  if (input.gitSampled && input.gitSignature !== state.lastGitSignature) {
    state.lastGitSignature = input.gitSignature;
    state.lastGitChangeTime = input.now;
  }
  
  // 3. Append new actions to rolling window, trim to repeatSetSize
  state.recentActions = [...state.recentActions, ...input.newActions]
    .slice(-input.repeatSetSize);
  
  // 4. Compute derived metrics
  const totalCaptureGrowth = input.captureSize - (state.lastCaptureSize - captureGrew);
  // Actually: growth since the start of the potential loop window.
  // Simpler: if captureSize has grown > minCaptureGrowthBytes since the
  // lastGitChangeTime, the agent is producing output without git progress.
  
  const gitStagnationMs = input.now - state.lastGitChangeTime;
  const captureActive = captureGrew > 0 || 
    (input.now - state.lastCaptureChangeTime) < input.windowMs;
  
  // Count action signatures
  const counts = new Map<string, number>();
  const failureCounts = new Map<string, number>();
  for (const action of state.recentActions) {
    counts.set(action.signature, (counts.get(action.signature) ?? 0) + 1);
    if (action.isFailure && action.failureFingerprint) {
      failureCounts.set(
        action.failureFingerprint,
        (failureCounts.get(action.failureFingerprint) ?? 0) + 1,
      );
    }
  }
  
  const maxCount = Math.max(...counts.values(), 0);
  const uniqueActions = counts.size;
  const maxFailureCount = Math.max(...failureCounts.values(), 0);
  
  const dominantAction = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  
  // 5. Check suspicion conditions
  const isStreaming = input.vendor !== 'claude';
  const effectiveWindow = isStreaming ? input.windowMs : input.windowMs * 2;
  
  const suspicionConditionsMet = isStreaming
    ? captureActive
      && gitStagnationMs >= effectiveWindow
      && maxCount >= input.repeatThreshold
      && uniqueActions <= input.maxUniqueActions
      && maxFailureCount >= input.minMatchingFailures
    : // Non-streaming: capture growth + git stagnation only
      captureActive && gitStagnationMs >= effectiveWindow;
  
  // 6. Stage 1: flag suspicion
  if (suspicionConditionsMet && state.suspicionStartTime === null) {
    state.suspicionStartTime = input.now;
    state.suspicionDominantAction = dominantAction;
    return {
      verdict: 'suspected',
      state,
      metrics: { /* ... */ },
    };
  }
  
  // 7. Clear suspicion if conditions no longer met
  if (!suspicionConditionsMet && state.suspicionStartTime !== null) {
    state.suspicionStartTime = null;
    state.suspicionDominantAction = null;
    state.suspicionEmitted = false;
    return { verdict: 'healthy', state };
  }
  
  // 8. Stage 2: confirm and act (streaming vendors only)
  if (isStreaming && state.suspicionStartTime !== null) {
    const suspicionDuration = input.now - state.suspicionStartTime;
    const sameDominant = dominantAction === state.suspicionDominantAction;
    
    if (suspicionDuration >= input.confirmMs && sameDominant) {
      return {
        verdict: 'confirmed',
        state,
        metrics: { /* ... */ },
      };
    }
  }
  
  return { verdict: 'healthy', state };
}
```

---

## 6. Integration into `dispatch.ts`

### New `WorkerContext` fields

Add to the `WorkerContext` interface (`dispatch.ts:271`):

```typescript
interface WorkerContext {
  // ... existing fields ...
  loopDetectorEnabled: boolean;
  execFileSync: ExecFileSyncLike;   // already exists as options.execFileSync
}
```

### Hook in `runWorkerPlain()` (dispatch.ts:807-852)

Inside the polling loop, after the existing activity check:

```typescript
// Existing: lines 833-837
const activity = plainActivity(ctx.sessionsDir, ctx.agentRunId);
if (activity !== previousActivity) {
  previousActivity = activity;
  waited = 0;
}

// NEW: loop detector tick
if (ctx.loopDetectorEnabled) {
  const detectorResult = loopDetectorTick(ctx, detectorState, recorder, {
    now: ctx.clock.now(),
    elapsed,
    vendor: ctx.vendor,
    sessionsDir: ctx.sessionsDir,
    agentRunId: ctx.agentRunId,
    worktree: ctx.worktree,
  });
  detectorState = detectorResult.state;
  
  if (detectorResult.verdict === 'suspected' && !detectorState.suspicionEmitted) {
    detectorState.suspicionEmitted = true;
    ctx.appendLedger(
      ctx.runId,
      'agent_loop_suspected',
      'task_id', ctx.taskId,
      'vendor', ctx.vendor,
      'window_sec', String(Math.floor(detectorResult.metrics!.windowSeconds)),
      'dominant_action_hash', detectorResult.metrics!.dominantActionHash,
      'action_count', String(detectorResult.metrics!.dominantActionCount),
      'unique_actions', String(detectorResult.metrics!.uniqueActionCount),
      'failure_count', String(detectorResult.metrics!.matchingFailureCount),
    );
  }
  
  if (detectorResult.verdict === 'confirmed') {
    ctx.appendLedger(
      ctx.runId,
      'agent_loop_confirmed',
      'task_id', ctx.taskId,
      'vendor', ctx.vendor,
      'suspicion_duration_sec',
        String(Math.floor((ctx.clock.now() - detectorState.suspicionStartTime!) / 1000)),
      'git_stagnation_sec',
        String(detectorResult.metrics!.gitStagnationSeconds),
      'dominant_action_hash', detectorResult.metrics!.dominantActionHash,
    );
    recorder.cancel();
    break;
  }
}
```

### Hook in `runWorkerInHerdrPane()` (dispatch.ts:972-998)

Identical detector tick, placed after the existing `herdrActivity()` check at
line 986-990.

### The `loopDetectorTick()` helper

```typescript
function loopDetectorTick(
  ctx: WorkerContext,
  prev: LoopDetectorState,
  recorder: ExitRecorder,
  params: {
    now: number;
    elapsed: number;
    vendor: string;
    sessionsDir: string;
    agentRunId: string;
    worktree: string;
  },
): LoopDetectorResult {
  // 1. Parse new capture records
  const capturePath = params.vendor === 'opencode'
    ? join(params.sessionsDir, `${params.agentRunId}.events.jsonl`)
    : join(params.sessionsDir, `${params.agentRunId}.cli.jsonl`);
  
  const { signatures, newOffset } = parseActionSignatures(
    capturePath, prev.captureOffset, params.vendor,
  );
  prev.captureOffset = newOffset;
  
  // 2. Sample git every gitSampleIntervalMs
  const gitSampleIntervalMs = 30_000;
  const gitSampled = params.elapsed - prev.lastGitSampleTime >= gitSampleIntervalMs;
  let gitSignature = prev.lastGitSignature;
  if (gitSampled) {
    gitSignature = sampleGitSignature(params.worktree, ctx.execFileSync);
    prev.lastGitSampleTime = params.elapsed;
  }
  
  // 3. Capture size
  const captureSize = captureFileSize([
    capturePath,
    join(params.sessionsDir, `${params.agentRunId}.stderr`),
  ]);
  
  // 4. Stderr repetition (simplified)
  const stderrRepetitionRatio = computeStderrRepetition(
    join(params.sessionsDir, `${params.agentRunId}.stderr`),
  );
  
  // 5. Evaluate
  return detectLoop(prev, {
    now: params.now,
    vendor: params.vendor,
    newActions: signatures,
    captureSize,
    gitSignature,
    gitSampled,
    stderrRepetitionRatio,
    windowMs: Number(ctx.env.HYDRA_LOOP_WINDOW_MS || 600_000),
    confirmMs: Number(ctx.env.HYDRA_LOOP_CONFIRM_MS || 300_000),
    repeatSetSize: Number(ctx.env.HYDRA_LOOP_REPEAT_SET || 12),
    repeatThreshold: Number(ctx.env.HYDRA_LOOP_REPEAT_THRESHOLD || 8),
    maxUniqueActions: Number(ctx.env.HYDRA_LOOP_MAX_UNIQUE || 2),
    minMatchingFailures: Number(ctx.env.HYDRA_LOOP_MIN_FAILURES || 4),
    minCaptureGrowthBytes: Number(ctx.env.HYDRA_LOOP_MIN_GROWTH || 8192),
  });
}
```

### Enable/disable

```typescript
// In dispatch(), when building ctx:
const loopDetectorEnabled = ctx.env.HYDRA_LOOP_DETECTOR !== '0';
```

Default: **enabled**. Set `HYDRA_LOOP_DETECTOR=0` to disable.

---

## 7. What Happens on Detection

### Two-stage approach

**Stage 1 — Suspicion (nonterminal ledger event):**

When all detection conditions first hold, append one nonterminal
`agent_loop_suspected` event:

```json
{
  "time": "2026-07-14T10:10:00Z",
  "event": "agent_loop_suspected",
  "run_id": "0013",
  "dispatch_instance_id": "8d2f...",
  "task_id": "loop-detector-design",
  "vendor": "codex",
  "window_sec": "600",
  "dominant_action_hash": "sha256:abc123...",
  "action_count": "9",
  "unique_actions": "1",
  "failure_count": "6"
}
```

This event is **nonterminal** — it does not change the task state. `status.ts`
and `status.sh` will surface it in `ledger_events` immediately. It contains only
**hashes**, never raw prompts or tool output.

**Stage 2 — Confirmation (auto-cancel):**

If the same dominant action persists for `confirmMs` (5 minutes) longer, with
no git signature change:

1. Append a nonterminal `agent_loop_confirmed` event with the evidence.
2. Call `recorder.cancel()` — the same clean in-process path used by
   `AbortSignal` and signal handlers.

`recorder.cancel()` (`dispatch.ts:330-345`) does:
- Sets `wasCancelled = true`
- Calls `ctx.killTree(workerPid)` (SIGTERM + best-effort SIGKILL after 2s)
- Calls `finish('agent_cancelled', [], '130')` which appends the terminal ledger
  event with `exit_code: "130"` and releases the concurrency slot
- Closes the herdr pane (best effort)

The ledger will show:
```
task_started → ... → agent_loop_suspected → agent_loop_confirmed → agent_cancelled
```

This makes the cause fully auditable.

### Why auto-cancel is safe here

1. **Conservative thresholds:** total ~15 minutes of confirmed looping (10 min
   window + 5 min confirmation) with BOTH semantic repetition AND git stagnation.
   This is not a knee-jerk reaction.

2. **Same cancellation path as human-initiated cancel:** `recorder.cancel()` is
   the exact same function called by `ExitRecorder.register()` for SIGINT/SIGTERM
   (`dispatch.ts:364-381`). It has the same safety properties: idempotent
   terminal-event recording, slot release, pane cleanup.

3. **No `cancelTask()` complexity needed:** the detector is in-process, so it
   doesn't need pidfile resolution, process discovery, SIGTERM→wait→SIGKILL
   escalation, or orphan detection. It calls `cancel()` directly.

4. **Auditable:** the `agent_loop_suspected` and `agent_loop_confirmed` events
   precede the terminal event, so the reason is always in the ledger.

5. **Disableable:** `HYDRA_LOOP_DETECTOR=0` turns it off entirely.

### Non-streaming vendors: suspicion only, never auto-cancel

For Claude (no streaming capture), the detector flags `agent_loop_suspected`
based on git stagnation + capture growth but **never advances to `confirmed`**.
The existing hard-cap timeout remains the backstop. This is because the evidence
is weaker without semantic action repetition.

---

## 8. Graceful Degradation by Vendor

| Vendor | Signal A (actions) | Signal B (git) | Signal C (stderr) | Behavior |
|---|---|---|---|---|
| Codex | `.cli.jsonl` — full action signatures + failure detection | Yes | Yes | Full two-stage detection |
| Kimi | `.cli.jsonl` — action signatures from tool_calls + content | Yes | Yes | Full two-stage detection |
| OpenCode | `.events.jsonl` — action signatures from part.type=tool/text | Yes | Yes | Full two-stage detection |
| Claude | N/A (no streaming capture) | Yes | Yes | Suspicion only, 20-min window, never auto-cancel |

If a capture file doesn't exist or can't be read, `parseActionSignatures()`
returns an empty array — the detector degrades to git-only mode for that tick.
This matches `pollJsonlFile()`'s existing error tolerance
(`dispatch.ts:672-674`).

---

## 9. Testability

The design follows the same injectable patterns used throughout
`kit/hydra-ts/test/`.

### Pure function tests (no I/O)

The `detectLoop()` function is pure: it takes `(state, input)` and returns
`{verdict, state}`. Tests construct synthetic states and inputs directly:

```typescript
describe('detectLoop', () => {
  it('returns healthy when actions are diverse', () => {
    const state = createLoopDetectorState();
    state.lastGitChangeTime = 0;
    
    const result = detectLoop(state, {
      now: 700_000,  // 700s elapsed
      vendor: 'codex',
      newActions: [
        { signature: 'codex:cmd:hash-a', timestamp: 690_000, isFailure: false },
        { signature: 'codex:cmd:hash-b', timestamp: 692_000, isFailure: false },
        { signature: 'codex:edit:hash-c', timestamp: 694_000, isFailure: false },
        { signature: 'codex:tool:hash-d', timestamp: 696_000, isFailure: false },
      ],
      captureSize: 100_000,
      gitSignature: 'unchanged',
      gitSampled: true,
      stderrRepetitionRatio: 0,
      windowMs: 600_000,
      confirmMs: 300_000,
      repeatSetSize: 12,
      repeatThreshold: 8,
      maxUniqueActions: 2,
      minMatchingFailures: 4,
      minCaptureGrowthBytes: 8192,
    });
    
    assert.equal(result.verdict, 'healthy');
  });
  
  it('returns suspected when same action repeats with git stagnation', () => {
    // Build state with lastGitChangeTime far in the past,
    // populate recentActions with 8+ identical failures,
    // verify verdict === 'suspected'
  });
  
  it('returns confirmed after confirmation window with same dominant action', () => {
    // Set suspicionStartTime to confirmMs ago, verify verdict === 'confirmed'
  });
  
  it('clears suspicion when git signature changes', () => {
    // Set suspicion state, then provide a different gitSignature, verify 'healthy'
  });
  
  it('never confirms for non-streaming vendors', () => {
    // vendor: 'claude', verify suspicion fires but never confirms
  });
});
```

### Integration tests with injectable clock and fake fs

The dispatch test suite (`dispatch.test.ts`) already demonstrates all the
patterns needed:

- **`StepClock`** (`dispatch.test.ts:181`): increments time deterministically on
  each `sleep()` call. The detector's time-based windows advance at a known rate.

- **`FakeChild`** + **`fakeSpawn()`** (`dispatch.test.ts:114-159`): simulates a
  worker that never exits (`autoExit: false`), keeping the polling loop alive so
  the detector can run.

- **Injected `execFileSync`**: tests inject `execFileSync: () => { throw ... }`
  to prevent real git calls. For loop detector tests, inject a mock that returns
  canned git output:

```typescript
const gitOutputs = ['sha1:abc\nM file.ts\n', 'sha1:abc\nM file.ts\n', ...];
let gitCall = 0;
const options = injectedOptions(f, mock.spawn, {
  clock: new StepClock(),
  pollIntervalMs: 20_000,
  env: { HYDRA_LOOP_WINDOW_MS: '60000', HYDRA_LOOP_CONFIRM_MS: '30000' },
  execFileSync: () => gitOutputs[gitCall++],
});
```

- **Capture file fixtures:** tests write JSONL files to the tmpdir sessions
  directory using `writeFileSync()` (same pattern as the existing Codex/Kimi
  progress tests at `dispatch.test.ts:920-1007`):

```typescript
const clock = new StepClock((_ms, count) => {
  if (count === 1) {
    // Write repeated identical failed tool calls
    const failingCmd = JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'npm test' },
    });
    writeFileSync(cliJsonlPath, Array(10).fill(failingCmd).join('\n') + '\n');
  }
});
```

### Test cases required

| Test | Description |
|---|---|
| `detectLoop_healthy_diverse_actions` | Diverse actions + git changing → healthy |
| `detectLoop_healthy_repeated_successes` | Same action repeating but all successful + git changing → healthy |
| `detectLoop_suspected_repeated_failures` | Same failing action 8+ times, ≤2 unique, git unchanged 10min → suspected |
| `detectLoop_confirmed_after_window` | Suspicion persists 5 more min with same dominant → confirmed |
| `detectLoop_clears_on_git_change` | Suspicion fires, then git changes → healthy, suspicion cleared |
| `detectLoop_clears_on_new_action` | Suspicion fires, then new unique action appears → healthy |
| `detectLoop_nonstreaming_never_confirms` | vendor=claude → suspicion only, never confirmed |
| `detectLoop_respects_threshold_overrides` | Custom thresholds via input |
| `dispatch_detects_codex_loop_and_cancels` | Integration: Codex worker looping → agent_cancelled in ledger |
| `dispatch_detects_opencode_loop_and_cancels` | Integration: OpenCode worker looping → agent_cancelled |
| `dispatch_loop_suspected_does_not_cancel` | Stage 1 fires but not Stage 2 → no cancellation |
| `dispatch_loop_disabled_by_env` | `HYDRA_LOOP_DETECTOR=0` → no detector, looping worker runs to hard cap |
| `dispatch_loop_git_change_clears_suspicion` | Worker loops, then makes git progress → suspicion cleared, no cancel |
| `dispatch_claude_loop_suspicion_only` | Claude worker: agent_loop_suspected but no auto-cancel |
| `dispatch_loop_ledger_events_contain_hashes_not_raw` | Verify ledger events have sha256 hashes, not raw content |

---

## 10. File Plan

### New files

| File | Purpose |
|---|---|
| `kit/hydra-ts/src/loop-detector.ts` | Pure detection function + I/O helpers + types |
| `kit/hydra-ts/test/loop-detector.test.ts` | Unit tests for pure function + integration via dispatch |

### Modified files

| File | Changes |
|---|---|
| `kit/hydra-ts/src/dispatch.ts` | Add detector tick to `runWorkerPlain()` and `runWorkerInHerdrPane()` polling loops; add `loopDetectorEnabled` to `WorkerContext`; wire `HYDRA_LOOP_DETECTOR` env var |
| `kit/hydra-ts/src/status.ts` | No change required — `agent_loop_suspected` / `agent_loop_confirmed` are nonterminal events already surfaced in `ledger_events` |

### No change needed

| File | Why |
|---|---|
| `cancel-task.ts` | The detector uses in-process `recorder.cancel()`, not external cancellation. `cancelTask()` remains for human-invoked cancellation. |
| `kit/hydra/scripts/status.sh` | Already displays all ledger events; nonterminal events appear automatically. |
| `kit/hydra/scripts/cancel-task.sh` | Unaffected — the detector doesn't shell out to it. |

---

## 11. Action Signature Extraction Pseudocode

### `parseActionSignatures(capturePath, offset, vendor)`

```typescript
export function parseActionSignatures(
  capturePath: string,
  offset: number,
  vendor: string,
): { signatures: ActionSignature[]; newOffset: number } {
  const signatures: ActionSignature[] = [];
  let contents: Buffer;
  try {
    contents = readFileSync(capturePath);
  } catch {
    return { signatures: [], newOffset: offset };
  }
  
  // Handle truncation (same as pollJsonlFile, dispatch.ts:659)
  if (contents.length < offset) offset = 0;
  
  const available = contents.subarray(offset);
  const lastNewline = available.lastIndexOf(0x0a);
  const consumed = lastNewline + 1;  // never consume partial lines
  if (consumed <= 0) return { signatures: [], newOffset: offset };
  
  const lines = available.subarray(0, consumed).toString('utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    const sig = extractSignature(line, vendor);
    if (sig) signatures.push(sig);
  }
  
  return { signatures, newOffset: offset + consumed };
}
```

### `extractSignature(line, vendor)`

```typescript
function extractSignature(line: string, vendor: string): ActionSignature | undefined {
  if (vendor === 'codex') return extractCodexSignature(line);
  if (vendor === 'kimi') return extractKimiSignature(line);
  if (vendor === 'opencode') return extractOpenCodeSignature(line);
  return undefined;
}

function extractCodexSignature(line: string): ActionSignature | undefined {
  let event: CodexEvent;
  try { event = JSON.parse(line); } catch { return undefined; }
  
  if (event.type === 'item.started' && event.item?.type === 'command_execution') {
    const cmd = canonicalize(event.item.command ?? '');
    return {
      signature: `codex:cmd:${sha256(cmd)}`,
      timestamp: Date.now(),
      isFailure: false,
    };
  }
  // ... other Codex event types
  return undefined;
}
```

### `sampleGitSignature(worktree, execFileSync)`

```typescript
export function sampleGitSignature(
  worktree: string,
  execFileSync: ExecFileSyncLike,
): string {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const parts: string[] = [];
  
  try {
    parts.push(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env,
    }));
  } catch { parts.push('NO_HEAD'); }
  
  try {
    parts.push(execFileSync('git', ['-C', worktree, 'diff', '--no-ext-diff', 'HEAD', '--'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env,
    }));
  } catch { parts.push('NO_DIFF'); }
  
  try {
    parts.push(execFileSync('git', ['-C', worktree, 'status', '--porcelain', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env,
    }));
  } catch { parts.push('NO_STATUS'); }
  
  return sha256(parts.join('\x00'));
}
```

---

## 12. Canonicalization Rules

```
canonicalizeCommand(cmd):
  1. Replace absolute worktree path prefixes with relative paths
     (e.g., "/Users/foo/worktrees/repo/src/file.ts" → "src/file.ts")
  2. Replace newlines with spaces
  3. Collapse consecutive whitespace
  4. Truncate to 200 characters
  5. Lowercase (commands are case-insensitive on macOS)
  
canonicalizePaths(paths):
  1. Map each path to basename (last path segment)
  2. Sort alphabetically
  3. Join with ","
  
canonicalizeArguments(args):
  1. Parse JSON if string
  2. Replace absolute path values with relative
  3. Remove volatile fields (timestamps, request IDs, nonce values)
  4. JSON-stringify with sorted keys
  5. Truncate to 200 characters
```

---

## 13. Comparison with Prior Speculative Designs

Both prior design docs (`async-trigger-design-codex.md` and
`async-trigger-design-kimi.md`) proposed similar detection signals but were
written **before** `dispatch_instance_id`, the dispatch pidfile, pane-mode
worker-liveness, `status.ts`, and `cancel-task.ts` existed. Key differences in
this updated design:

| Aspect | Prior Codex design | Prior Kimi design | This design |
|---|---|---|---|
| State persistence | Atomic `sessions/supervisor/<id>.json` files | `sessions/.loop-detector/<id>.state.json` | **In-memory local variable** in the polling loop — no state files, no stale-state risk |
| Cancellation | Called a future `recorder.cancel({reason})` or external cancel-task.sh | Invoked cancel-task.sh | **Calls existing `recorder.cancel()` directly** — no new interface, no external process |
| Detection model | Integrated into dispatch loop (recommended) | Integrated into dispatch loop (recommended) | **Same recommendation, now grounded in actual code** |
| Git signature | Complex: rev-parse + binary diff + porcelain v2 + hash-object per untracked file | Simpler: porcelain + diff --name-status | **Pragmatic: rev-parse + text diff + porcelain -z** — sufficient signal, lower cost |
| Action parsing | New `TaskHealthSampler` module | Vendor-specific fingerprint of last event | **Reuse existing `pollJsonlFile` offset pattern + new pure `detectLoop()`** |
| Non-streaming (Claude) | Acknowledged but underspecified | Acknowledged but underspecified | **Concrete degradation: 20-min window, suspicion only, never auto-cancel** |

The prior designs' concern about supervisor subdirectories interfering with
`plainActivity()` is now moot: `plainActivity()` (`dispatch.ts:492-501`) only
globs top-level `<agent_run_id>.*` files, and this design stores **no files**
in the sessions directory for detector state.

---

## 14. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| False positive on long-running reasoning tasks (agent thinks before acting) | 10-min window requires BOTH git stagnation AND action repetition. Pure reasoning without repeated tool calls won't trigger it (action count stays low). |
| False positive on legitimate iterative testing | `minMatchingFailures: 4` requires failures, not just repetitions. Successful test runs don't count. Git changes between iterations break the stagnation condition. |
| Git commands slow on large repos | Sampled every 30s (not every tick). `GIT_OPTIONAL_LOCKS=0` prevents contention. `execFileSync` is injectable in tests. |
| Action signature parsing breaks on vendor format changes | Parsers are defensive (try/catch per line, same as existing `codexEventText`/`kimiEventText`/`monitorEventText`). Broken parsing degrades to git-only mode. |
| Detector cancels a task that was about to succeed | Conservative two-stage approach (10 min + 5 min confirmation). `HYDRA_LOOP_DETECTOR=0` escape hatch. Ledger events make the decision auditable. |

---

## 15. Open Questions for Implementation

1. **Failure detection depth:** should V1 parse completion/error events (Codex
   `item.completed`, Kimi `role: tool`, OpenCode error states) for failure
   fingerprints, or use the simpler proxy (same action signature repeating 8+
   times = likely failing)? The simpler proxy is recommended for V1; full error
   parsing can be added later for tighter false-positive control.

2. **Kimi tool-call parsing:** `kimiEventText()` (`dispatch.ts:632`) currently
   extracts only assistant `content` strings. Extracting `tool_calls[].function`
   requires a new parser function. This is straightforward but needs a separate
   `kimiActionSignature()` function.

3. **Stderr repetition analysis:** is the 60% threshold for repeated lines too
   aggressive? Should it be lowered to 40% for confirmatory weight? This should
   be calibrated during implementation with real capture data.
