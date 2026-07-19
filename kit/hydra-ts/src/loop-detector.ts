import { createHash, randomBytes } from 'node:crypto';
import { readFileSync as defaultReadFileSync, statSync as defaultStatSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecFileSyncLike } from './dispatch.ts';
import { currentAttemptEvents, type LedgerEntry } from './current-attempt.ts';

export type ExecGit = ExecFileSyncLike;

export interface LoopDetectorClock {
  now(): number;
}

export interface LoopDetectorOptions {
  runId: string;
  taskId: string;
  worktree: string;
  sessionsDir: string;
  agentRunId: string;
  vendor: string;
  dispatchInstanceId: string;
  pollIntervalMs: number;
  clock: LoopDetectorClock;
  appendLedger: (event: string, ...kvs: string[]) => void;
  readLedger?: () => LedgerEntry[];
  readFileSync?: (path: string) => Buffer | undefined;
  statSync?: (path: string) => { size: number; ino: number; dev: number; isFile(): boolean } | undefined;
  execGit?: ExecGit;
  env?: NodeJS.ProcessEnv;
}

export interface ActionSignature {
  hash: string;
  timestamp: number;
  isActionable: boolean;
  failureHash?: string;
  correlationId?: string;
  failureMarker?: unknown;
}

export interface CaptureReaderState {
  capturePath: string;
  offset: number;
  lastSize: number;
  lastIno: number;
  lastDev: number;
  boundaryHash: string;
}

export interface LoopEpisode {
  id: string;
  kind: 'repeated_failure' | 'repeated_event_cycle';
  dominantActionHash: string;
  suspectedAt: number;
  emittedSuspected: boolean;
  emittedConfirmed: boolean;
  failureHash?: string;
  cycleHashes?: string[];
  freshMatchingFailures: number;
  freshMatchingCycleFailures: number;
}

export interface LoopDetectorState {
  enabled: boolean;
  reader: CaptureReaderState | null;
  lastGitSignature: string;
  lastGitChangeAt: number;
  lastGitSampleAt: number;
  gitUnknown: boolean;
  recentActions: ActionSignature[];
  recentActionHashes: string[];
  episode: LoopEpisode | null;
  lastCaptureBytes: number;
  lastCaptureChangeAt: number;
  totalMeaningfulEvents: number;
  cumulativeRawBytes: number;
  correlationIdToHash: Map<string, string>;
}

export interface LoopMetrics {
  windowSec: number;
  gitStagnantSec: number;
  rawBytes: number;
  meaningfulEvents: number;
  repeatCount: number;
  failureCount: number;
  uniqueActions: number;
  dominantActionHash: string;
  failureHash?: string;
  cycleLength?: number;
}

export interface LoopDetectorResult {
  verdict: 'healthy' | 'suspected' | 'confirmed';
  episodeId?: string;
  metrics?: LoopMetrics;
  cleared?: boolean;
}

// Thresholds from the synthesized spec (Codex defaults).
const RULE_A_WINDOW_MS = 10 * 60 * 1000;
const RULE_B_WINDOW_MS = 15 * 60 * 1000;
const CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;
const ACTIONABLE_SUFFIX = 12;
const DOMINANT_THRESHOLD = 8;
const ACTION_DIVERSITY_CEILING = 3;
const MATCHING_FAILURES_THRESHOLD = 6;
const RULE_A_OUTPUT_FLOOR_RECORDS = 20;
const RULE_A_OUTPUT_FLOOR_BYTES = 8 * 1024;
const RULE_B_OUTPUT_FLOOR_RECORDS = 24;
const RULE_B_OUTPUT_FLOOR_BYTES = 32 * 1024;
const CYCLE_MAX_PERIOD = 4;
const CYCLE_MIN_REPETITIONS = 5;
const RULE_B_FAILURES_THRESHOLD = 2;
const CONFIRMATION_FRESH_FAILURES_THRESHOLD = 2;
const CONFIRMATION_FRESH_CYCLE_REPETITIONS = 2;
const GIT_SAMPLE_INTERVAL_MS = 30_000;

const TERMINAL_EVENTS = new Set(['agent_exited', 'agent_cancelled', 'agent_timed_out', 'agent_usage_limited']);
const STREAMING_VENDORS = new Set(['codex', 'kimi', 'opencode']);

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = v[key];
        return acc;
      }, {});
    }
    return v;
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripWorktreePrefix(value: string, worktree: string): string {
  if (!worktree) return value;
  const prefix = worktree.replace(/\/$/, '');
  if (value.startsWith(prefix)) {
    const rest = value.slice(prefix.length);
    return rest.startsWith('/') ? rest.slice(1) : rest;
  }
  return value;
}

function signatureHash(kind: string, payload: unknown, worktree: string): string {
  const normalized = typeof payload === 'string'
    ? normalizeWhitespace(stripWorktreePrefix(payload, worktree))
    : canonicalJson(payload);
  return sha256(`${kind}:${normalized}`);
}

function makeFailureHash(actionHash: string, failureMarker: unknown): string {
  const marker = typeof failureMarker === 'string'
    ? normalizeWhitespace(failureMarker).slice(0, 512)
    : canonicalJson(failureMarker);
  return sha256(`failure:${actionHash}:${marker}`);
}

function extractCodexSignatures(line: string, worktree: string): ActionSignature[] {
  let event: {
    type?: string;
    item?: {
      type?: string;
      command?: string;
      changes?: Array<{ path?: string }>;
      server?: string;
      tool?: string;
      id?: string;
      text?: string;
    };
    call_id?: string;
    error?: unknown;
    status?: string;
    exit_code?: number;
  };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return [];
  }
  if (!event || typeof event !== 'object') return [];

  const item = event.item;
  if (!item) return [];

  if (event.type === 'item.started') {
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      const hash = signatureHash('cmd', item.command, worktree);
      return [{ hash, timestamp: 0, isActionable: true }];
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const paths = item.changes
        .map((c) => c.path ?? '')
        .filter(Boolean)
        .sort();
      return [{ hash: signatureHash('edit', paths, worktree), timestamp: 0, isActionable: true }];
    }
    if (item.type === 'mcp_tool_call' && typeof item.tool === 'string') {
      const payload = { server: item.server ?? '', tool: item.tool };
      return [{ hash: signatureHash('tool', payload, worktree), timestamp: 0, isActionable: true }];
    }
  }

  if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim() !== '') {
    return [{ hash: signatureHash('say', item.text, worktree), timestamp: 0, isActionable: false }];
  }

  if (event.type === 'item.completed') {
    if (item.type === 'command_execution') {
      const failed = typeof event.exit_code === 'number' && event.exit_code !== 0;
      const hash = signatureHash('cmd', item.command ?? '', worktree);
      return [{
        hash,
        timestamp: 0,
        isActionable: true,
        failureHash: failed ? makeFailureHash(hash, String(event.exit_code)) : undefined,
      }];
    }
    if (item.type === 'mcp_tool_call') {
      const failed = event.status === 'failed' || event.status === 'error' || event.error !== undefined;
      const payload = { server: item.server ?? '', tool: item.tool };
      const hash = signatureHash('tool', payload, worktree);
      return [{
        hash,
        timestamp: 0,
        isActionable: true,
        failureHash: failed ? makeFailureHash(hash, event.error ?? event.status ?? 'failed') : undefined,
      }];
    }
  }

  return [];
}

function extractKimiSignatures(line: string, worktree: string): ActionSignature[] {
  let event: {
    role?: string;
    content?: unknown;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: unknown };
    }>;
    tool_call_id?: string;
    is_error?: boolean;
    error?: unknown;
    status?: string;
  };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return [];
  }
  if (!event || typeof event !== 'object') return [];

  const results: ActionSignature[] = [];

  if (event.role === 'assistant' && Array.isArray(event.tool_calls)) {
    for (const tc of event.tool_calls) {
      if (tc.type === 'function' || tc.function) {
        const payload = {
          name: tc.function?.name ?? '',
          args: tc.function?.arguments,
        };
        results.push({
          hash: signatureHash('tool', payload, worktree),
          timestamp: 0,
          isActionable: true,
          correlationId: tc.id,
        });
      }
    }
  }

  if (event.role === 'assistant' && typeof event.content === 'string' && event.content.trim() !== '') {
    results.push({
      hash: signatureHash('say', event.content, worktree),
      timestamp: 0,
      isActionable: false,
    });
  }

  if (event.role === 'tool' && event.tool_call_id) {
    const failed = event.is_error === true
      || event.status === 'failed'
      || event.status === 'error'
      || (event.error !== undefined && event.error !== null);
    if (failed) {
      // The logical action hash is resolved by correlationId in loopDetectorTick.
      // We retain the ID only for correlation, not as part of the signature.
      const marker = event.error ?? event.status ?? 'failed';
      results.push({
        hash: '',
        timestamp: 0,
        isActionable: true,
        correlationId: event.tool_call_id,
        failureMarker: marker,
      });
    }
  }

  return results;
}

function extractOpenCodeSignatures(line: string, worktree: string): ActionSignature[] {
  let event: {
    part?: {
      type?: string;
      text?: string;
      tool?: string;
      state?: {
        title?: string;
        status?: string;
        error?: unknown;
      };
      id?: string;
    };
  };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return [];
  }
  if (!event || typeof event !== 'object') return [];

  const part = event.part;
  if (!part || typeof part !== 'object') return [];

  if (part.type === 'tool' && typeof part.tool === 'string') {
    const payload = { tool: part.tool, title: part.state?.title ?? '' };
    const hash = signatureHash('tool', payload, worktree);
    const failed = part.state?.status === 'error' || part.state?.status === 'failed' || part.state?.error !== undefined;
    return [{
      hash,
      timestamp: 0,
      isActionable: true,
      failureHash: failed ? makeFailureHash(hash, part.state?.error ?? part.state?.status ?? 'failed') : undefined,
    }];
  }

  if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
    return [{ hash: signatureHash('say', part.text, worktree), timestamp: 0, isActionable: false }];
  }

  return [];
}

function extractSignatures(line: string, vendor: string, worktree: string): ActionSignature[] {
  if (vendor === 'codex') return extractCodexSignatures(line, worktree);
  if (vendor === 'kimi') return extractKimiSignatures(line, worktree);
  if (vendor === 'opencode') return extractOpenCodeSignatures(line, worktree);
  return [];
}

function makeReaderState(capturePath: string): CaptureReaderState {
  return {
    capturePath,
    offset: 0,
    lastSize: -1,
    lastIno: -1,
    lastDev: -1,
    boundaryHash: '',
  };
}

function safeReadFile(path: string, read: (path: string) => Buffer | undefined): Buffer | undefined {
  try {
    return read(path);
  } catch {
    return undefined;
  }
}

function safeStat(
  path: string,
  stat: (path: string) => { size: number; ino: number; dev: number; isFile(): boolean } | undefined,
): { size: number; ino: number; dev: number; isFile(): boolean } | undefined {
  try {
    return stat(path);
  } catch {
    return undefined;
  }
}

function readCaptureIncrementally(
  state: CaptureReaderState,
  vendor: string,
  worktree: string,
  readFileSync: (path: string) => Buffer | undefined,
  statSync: (path: string) => { size: number; ino: number; dev: number; isFile(): boolean } | undefined,
): { signatures: ActionSignature[]; rawBytes: number; reset: boolean; state: CaptureReaderState } {
  const stat = safeStat(state.capturePath, statSync);
  if (!stat || !stat.isFile()) {
    return { signatures: [], rawBytes: 0, reset: false, state };
  }

  const contents = safeReadFile(state.capturePath, readFileSync);
  if (!contents) {
    return { signatures: [], rawBytes: 0, reset: false, state };
  }

  let reset = false;
  if (stat.ino !== state.lastIno || stat.dev !== state.lastDev) {
    // New file (different inode/device): reset to beginning.
    state.offset = 0;
    state.boundaryHash = '';
    reset = true;
  } else if (contents.length < state.offset) {
    // File shrank: reset.
    state.offset = 0;
    state.boundaryHash = '';
    reset = true;
  } else if (state.offset > 0) {
    // Same-size or growth: verify boundary bytes match to detect rewrite.
    const boundaryStart = Math.max(0, state.offset - 64);
    const boundaryBytes = contents.subarray(boundaryStart, state.offset);
    const boundaryHash = sha256(boundaryBytes);
    if (boundaryHash !== state.boundaryHash) {
      state.offset = 0;
      state.boundaryHash = '';
      reset = true;
    }
  }

  state.lastSize = contents.length;
  state.lastIno = stat.ino;
  state.lastDev = stat.dev;

  const available = contents.subarray(state.offset);
  const lastNewline = available.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // No complete line; update boundary hash from current offset for next comparison.
    const boundaryStart = Math.max(0, state.offset - 64);
    state.boundaryHash = sha256(contents.subarray(boundaryStart, state.offset));
    return { signatures: [], rawBytes: 0, reset, state };
  }

  const consumed = lastNewline + 1;
  const lines = available.subarray(0, consumed).toString('utf8').split('\n');
  const signatures: ActionSignature[] = [];
  for (const line of lines) {
    if (!line) continue;
    const sigs = extractSignatures(line, vendor, worktree);
    for (const sig of sigs) signatures.push(sig);
  }

  state.offset += consumed;
  const boundaryStart = Math.max(0, state.offset - 64);
  state.boundaryHash = sha256(contents.subarray(boundaryStart, state.offset));

  return { signatures, rawBytes: consumed, reset, state };
}

function runGit(
  worktree: string,
  args: string[],
  execGit: ExecGit,
  env: NodeJS.ProcessEnv | undefined,
): string {
  const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  return String(execGit('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv,
  }));
}

function listUntrackedFiles(worktree: string, execGit: ExecGit, env: NodeJS.ProcessEnv | undefined): string[] {
  const output = runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], execGit, env);
  return output.split('\0').filter(Boolean).sort();
}

function hashUntrackedFile(
  path: string,
  readFileSync: (path: string) => Buffer | undefined,
  statSync: (path: string) => { size: number; ino: number; dev: number; isFile(): boolean } | undefined,
): string {
  // Any failure to inspect an untracked file must propagate so the whole Git
  // sample can be marked unknown. Stable literals like 'missing'/'unreadable'
  // would hide rewrites behind a constant signature.
  const stat = statSync(path);
  if (!stat) throw new Error(`untracked stat failed: ${path}`);
  if (stat.isFile()) {
    const contents = readFileSync(path);
    if (contents === undefined) throw new Error(`untracked read failed: ${path}`);
    return `file:${sha256(contents)}`;
  }
  return `type:special`;
}

function sampleGitSignature(
  worktree: string,
  execGit: ExecGit | undefined,
  readFileSync: (path: string) => Buffer | undefined,
  statSync: (path: string) => { size: number; ino: number; dev: number; isFile(): boolean } | undefined,
  env: NodeJS.ProcessEnv | undefined,
): { signature: string; unknown: boolean } {
  if (!execGit) return { signature: '', unknown: true };

  try {
    const head = runGit(worktree, ['rev-parse', 'HEAD'], execGit, env);
    const diff = runGit(worktree, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], execGit, env);
    const statusOutput = runGit(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], execGit, env);

    const untracked = listUntrackedFiles(worktree, execGit, env);
    const untrackedHashes = untracked.map((p) => {
      const absolutePath = p.startsWith('/') ? p : join(worktree, p);
      return `${p}\n${hashUntrackedFile(absolutePath, readFileSync, statSync)}`;
    });

    const parts = [
      `HEAD\n${head}`,
      `DIFF\n${diff}`,
      `STATUS\n${statusOutput}`,
      `UNTRACKED\n${untrackedHashes.join('\n')}`,
    ];
    return { signature: sha256(parts.join('\0')), unknown: false };
  } catch {
    return { signature: '', unknown: true };
  }
}

function findDominantAction(actions: ActionSignature[]): { hash: string; count: number; unique: number } | null {
  const counts = new Map<string, number>();
  for (const a of actions) {
    counts.set(a.hash, (counts.get(a.hash) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestHash = '';
  let bestCount = 0;
  for (const [hash, count] of counts) {
    if (count > bestCount) {
      bestHash = hash;
      bestCount = count;
    }
  }
  return { hash: bestHash, count: bestCount, unique: counts.size };
}

function countMatchingFailures(actions: ActionSignature[], dominantHash: string): { count: number; failureHash: string | undefined } {
  const failureHashes = new Map<string, number>();
  for (const a of actions) {
    if (a.hash === dominantHash && a.failureHash) {
      failureHashes.set(a.failureHash, (failureHashes.get(a.failureHash) ?? 0) + 1);
    }
  }
  if (failureHashes.size === 0) return { count: 0, failureHash: undefined };
  let bestHash = '';
  let bestCount = 0;
  for (const [hash, count] of failureHashes) {
    if (count > bestCount) {
      bestHash = hash;
      bestCount = count;
    }
  }
  return { count: bestCount, failureHash: bestHash };
}

function detectCycle(actions: ActionSignature[]): { period: number; repetitions: number; hashes: string[]; hasActionable: boolean; failureCount: number } | null {
  const hashes = actions.map((a) => a.hash);
  if (hashes.length === 0) return null;
  for (let period = 1; period <= CYCLE_MAX_PERIOD; period += 1) {
    if (hashes.length < period * CYCLE_MIN_REPETITIONS) continue;
    const pattern = hashes.slice(-period);
    let repetitions = 0;
    while (repetitions * period < hashes.length) {
      const start = hashes.length - (repetitions + 1) * period;
      if (start < 0) break;
      const slice = hashes.slice(start, start + period);
      if (slice.length !== pattern.length || !slice.every((h, i) => h === pattern[i])) break;
      repetitions += 1;
    }
    if (repetitions >= CYCLE_MIN_REPETITIONS) {
      const cycleActions = actions.slice(-period * repetitions);
      const hasActionable = cycleActions.some((a) => a.isActionable);
      const failureCount = cycleActions.filter((a) => a.failureHash).length;
      return { period, repetitions, hashes: pattern, hasActionable, failureCount };
    }
  }
  return null;
}

function episodeId(dispatchInstanceId: string, kind: string, dominantHash: string, failureHash?: string): string {
  return sha256(`${dispatchInstanceId}:${kind}:${dominantHash}:${failureHash ?? ''}`);
}

function resetRollingEvidence(state: LoopDetectorState, now: number): void {
  state.recentActions = [];
  state.recentActionHashes = [];
  state.totalMeaningfulEvents = 0;
  state.cumulativeRawBytes = 0;
  state.lastCaptureBytes = 0;
  state.lastCaptureChangeAt = now;
  state.correlationIdToHash.clear();
}

/**
 * Verify that this detector still belongs to the ledger's current attempt
 * boundary. If a newer task_started (different spec_version or dispatch instance)
 * has appeared, or the current task_started does not match our identity, do not
 * emit loop events for this dispatch.
 */
function isCurrentAttemptValid(options: LoopDetectorOptions): boolean {
  const readLedger = options.readLedger;
  if (!readLedger) return true;
  let events: LedgerEntry[];
  try {
    events = readLedger();
  } catch {
    return false;
  }
  const taskEvents = events.filter((entry) => entry.task_id === options.taskId);
  const { events: attemptEvents, startedEntry } = currentAttemptEvents(
    taskEvents,
    options.agentRunId,
  );
  if (!startedEntry) return false;
  if (startedEntry.agent_run_id !== options.agentRunId) return false;
  if (startedEntry.dispatch_instance_id !== options.dispatchInstanceId) return false;
  // Ensure no newer task_started has superseded this attempt.
  const startedIndex = taskEvents.indexOf(startedEntry);
  if (startedIndex < 0) return false;
  return !taskEvents.slice(startedIndex + 1).some((entry) => entry.event === 'task_started');
}

/**
 * End an episode and reset all rolling evidence. This is an intentional,
 * conservative (false-negative-biased) choice for an auto-cancellation feature:
 * any pattern change clears not only the episode but also the action history,
 * output floors, capture-growth state, and Kimi correlation map. A fresh
 * qualifying window must be rebuilt before a new suspicion or confirmation can
 * occur.
 */
function clearEpisode(
  state: LoopDetectorState,
  options: LoopDetectorOptions,
  episode: LoopEpisode,
  reason: string,
  now: number,
): void {
  options.appendLedger(
    'agent_loop_cleared',
    'task_id', options.taskId,
    'vendor', options.vendor,
    'agent_run_id', options.agentRunId,
    'episode_id', episode.id,
    'reason', reason,
  );
  resetRollingEvidence(state, now);
  state.episode = null;
}

function makeMetrics(
  kind: 'repeated_failure' | 'repeated_event_cycle',
  dominant: { hash: string; count: number; unique: number },
  failureCount: number,
  failureHash: string | undefined,
  gitStagnantSec: number,
  rawBytes: number,
  meaningfulEvents: number,
  cycle: { period: number; repetitions: number } | undefined,
): LoopMetrics {
  return {
    windowSec: kind === 'repeated_failure' ? Math.floor(RULE_A_WINDOW_MS / 1000) : Math.floor(RULE_B_WINDOW_MS / 1000),
    gitStagnantSec,
    rawBytes,
    meaningfulEvents,
    repeatCount: cycle ? cycle.repetitions : dominant.count,
    failureCount,
    uniqueActions: cycle ? cycle.period : dominant.unique,
    dominantActionHash: dominant.hash,
    failureHash,
    cycleLength: cycle?.period,
  };
}

export function createLoopDetectorState(): LoopDetectorState {
  return {
    enabled: true,
    reader: null,
    lastGitSignature: '',
    lastGitChangeAt: 0,
    lastGitSampleAt: -GIT_SAMPLE_INTERVAL_MS,
    gitUnknown: false,
    recentActions: [],
    recentActionHashes: [],
    episode: null,
    lastCaptureBytes: 0,
    lastCaptureChangeAt: 0,
    totalMeaningfulEvents: 0,
    cumulativeRawBytes: 0,
    correlationIdToHash: new Map(),
  };
}

export function loopDetectorTick(
  state: LoopDetectorState,
  options: LoopDetectorOptions,
): { state: LoopDetectorState; result: LoopDetectorResult } {
  const now = options.clock.now();

  if (options.env?.HYDRA_LOOP_DETECTOR === '0' || !STREAMING_VENDORS.has(options.vendor)) {
    state.enabled = false;
    return { state, result: { verdict: 'healthy' } };
  }
  state.enabled = true;

  const readFileSync = options.readFileSync ?? ((p) => safeReadFile(p, defaultReadFileSync));
  const statSync = options.statSync ?? ((p) => safeStat(p, defaultStatSync));
  const execGit = options.execGit;

  // Capture path selection.
  const capturePath = options.vendor === 'opencode'
    ? join(options.sessionsDir, `${options.agentRunId}.events.jsonl`)
    : join(options.sessionsDir, `${options.agentRunId}.cli.jsonl`);

  if (!state.reader || state.reader.capturePath !== capturePath) {
    state.reader = makeReaderState(capturePath);
  }

  // Read new capture records.
  const { signatures, rawBytes, reset, state: newReaderState } = readCaptureIncrementally(
    state.reader,
    options.vendor,
    options.worktree,
    readFileSync,
    statSync,
  );
  state.reader = newReaderState;

  if (reset) {
    resetRollingEvidence(state, now);
  }

  // Resolve per-invocation correlation IDs before stamping/hashing. The ID is
  // retained only for start/outcome correlation, never as part of the logical
  // repetition-matching signature.
  for (const sig of signatures) {
    if (sig.correlationId && !sig.failureHash && sig.failureMarker === undefined) {
      state.correlationIdToHash.set(sig.correlationId, sig.hash);
      // Keep the correlation map bounded like the action history so a long run
      // of unique IDs cannot grow it without limit.
      if (state.correlationIdToHash.size > 100) {
        const firstKey = state.correlationIdToHash.keys().next().value;
        if (firstKey !== undefined) state.correlationIdToHash.delete(firstKey);
      }
    }
    if (sig.correlationId && sig.failureMarker !== undefined) {
      const resolvedHash = state.correlationIdToHash.get(sig.correlationId);
      if (resolvedHash) {
        sig.hash = resolvedHash;
        sig.failureHash = makeFailureHash(resolvedHash, sig.failureMarker);
      } else {
        // Cannot correlate: emit a synthetic signature so the failure is still
        // observable, but it will not accidentally match a repeated logical action.
        sig.hash = signatureHash('tool', { marker: sig.failureMarker }, options.worktree);
        sig.failureHash = makeFailureHash(sig.hash, sig.failureMarker);
      }
      // Consume the correlation entry once its outcome has been processed.
      state.correlationIdToHash.delete(sig.correlationId);
      delete sig.failureMarker;
    }
  }

  // Stamp signatures with observation time.
  const stamped = signatures.map((s) => ({ ...s, timestamp: now }));
  state.recentActions.push(...stamped);
  state.recentActions = state.recentActions.slice(-100);
  state.recentActionHashes.push(...stamped.map((s) => s.hash));
  state.recentActionHashes = state.recentActionHashes.slice(-100);
  state.totalMeaningfulEvents += stamped.length;
  state.cumulativeRawBytes += rawBytes;

  // Capture growth tracking.
  const stat = safeStat(capturePath, statSync);
  const captureBytes = stat?.size ?? 0;
  if (captureBytes !== state.lastCaptureBytes) {
    state.lastCaptureBytes = captureBytes;
    state.lastCaptureChangeAt = now;
  }

  // Git sampling (every ~30 seconds).
  let gitSignature = state.lastGitSignature;
  let gitUnknown = state.gitUnknown;
  if (now - state.lastGitSampleAt >= GIT_SAMPLE_INTERVAL_MS) {
    const sample = sampleGitSignature(options.worktree, execGit, readFileSync, statSync, options.env);
    gitSignature = sample.signature;
    gitUnknown = sample.unknown;
    state.lastGitSampleAt = now;
  }

  const wasUnknown = state.gitUnknown;
  let gitChangedThisTick = false;
  if (!gitUnknown) {
    if (state.lastGitSignature === '') {
      // First successful sample establishes the baseline. If we are recovering
      // from an unknown state, restart the stagnation clock so unknown-period
      // time is not credited.
      state.lastGitSignature = gitSignature;
      if (wasUnknown) {
        state.lastGitChangeAt = now;
      }
    } else if (gitSignature !== state.lastGitSignature) {
      state.lastGitSignature = gitSignature;
      state.lastGitChangeAt = now;
      gitChangedThisTick = true;
    } else if (wasUnknown) {
      // Recovered from an unknown Git state with the same signature: still
      // restart the stagnation clock; we cannot trust progress information
      // from the unavailable period.
      state.lastGitChangeAt = now;
    }
  }
  state.gitUnknown = gitUnknown;

  const gitStagnantMs = now - state.lastGitChangeAt;
  const gitStagnantSec = Math.floor(gitStagnantMs / 1000);

  // Any real Git progress clears an in-progress suspicion episode and resets
  // all rolling evidence so stale pre-progress failures cannot contribute to
  // a new suspicion.
  if (gitChangedThisTick) {
    if (state.episode !== null) {
      const episode = state.episode;
      clearEpisode(state, options, episode, 'git_progress', now);
      return { state, result: { verdict: 'healthy', cleared: true } };
    }
    resetRollingEvidence(state, now);
  }

  // If Git evidence is unknown, suppress detection until we have a baseline.
  if (state.gitUnknown) {
    return { state, result: { verdict: 'healthy' } };
  }

  // Evaluate Rule A on the last ACTIONABLE_SUFFIX actionable events.
  const actionableSuffix = state.recentActions
    .filter((a) => a.isActionable)
    .slice(-ACTIONABLE_SUFFIX);
  const dominant = findDominantAction(actionableSuffix);
  const { count: matchingFailures, failureHash } = dominant
    ? countMatchingFailures(actionableSuffix, dominant.hash)
    : { count: 0, failureHash: undefined };

  const ruleAFloorMet = state.totalMeaningfulEvents >= RULE_A_OUTPUT_FLOOR_RECORDS
    || state.cumulativeRawBytes >= RULE_A_OUTPUT_FLOOR_BYTES;
  const ruleAActive = gitStagnantMs >= RULE_A_WINDOW_MS
    && ruleAFloorMet
    && actionableSuffix.length >= ACTIONABLE_SUFFIX
    && dominant !== null
    && dominant.count >= DOMINANT_THRESHOLD
    && dominant.unique <= ACTION_DIVERSITY_CEILING
    && matchingFailures >= MATCHING_FAILURES_THRESHOLD;

  const ruleBFloorMet = state.totalMeaningfulEvents >= RULE_B_OUTPUT_FLOOR_RECORDS
    && state.cumulativeRawBytes >= RULE_B_OUTPUT_FLOOR_BYTES;
  const cycle = detectCycle(state.recentActions);
  const ruleBActive = gitStagnantMs >= RULE_B_WINDOW_MS
    && ruleBFloorMet
    && cycle !== null
    && cycle.hasActionable
    && cycle.failureCount >= RULE_B_FAILURES_THRESHOLD;

  const activeKind: 'repeated_failure' | 'repeated_event_cycle' | null = ruleAActive
    ? 'repeated_failure'
    : ruleBActive
      ? 'repeated_event_cycle'
      : null;
  const activeHash = ruleAActive
    ? (dominant?.hash ?? '')
    : ruleBActive
      ? cycle!.hashes.join(',')
      : '';
  const activeFailureHash = ruleAActive ? failureHash : undefined;

  // Update the active episode with fresh evidence observed since suspicion, and
  // end it immediately if the underlying rule is no longer active. Ending the
  // episode (rather than preserving a stale suspectedAt) forces a genuinely
  // continuous confirmation window measured from real reactivation.
  if (state.episode !== null) {
    const episode = state.episode;
    const episodeStillActive = activeKind !== null
      && episode.kind === activeKind
      && episode.dominantActionHash === activeHash;

    if (!episodeStillActive) {
      clearEpisode(state, options, episode, 'pattern_changed', now);
      return { state, result: { verdict: 'healthy', cleared: true } };
    }

    for (const s of stamped) {
      if (s.timestamp <= episode.suspectedAt) continue;
      const matchesEpisode = episode.kind === 'repeated_failure'
        ? s.hash === episode.dominantActionHash
        : episode.cycleHashes?.includes(s.hash) ?? false;
      if (!matchesEpisode) {
        clearEpisode(state, options, episode, 'pattern_changed', now);
        return { state, result: { verdict: 'healthy', cleared: true } };
      }
      if (episode.kind === 'repeated_failure') {
        if (s.failureHash === episode.failureHash) {
          episode.freshMatchingFailures += 1;
        }
      } else if (episode.cycleHashes?.includes(s.hash) && s.failureHash) {
        episode.freshMatchingCycleFailures += 1;
      }
    }
  }

  if (activeKind === null) {
    return { state, result: { verdict: 'healthy' } };
  }

  // Start or continue episode.
  if (state.episode === null || state.episode.kind !== activeKind || state.episode.dominantActionHash !== activeHash) {
    state.episode = {
      id: episodeId(options.dispatchInstanceId, activeKind, activeHash, activeFailureHash),
      kind: activeKind,
      dominantActionHash: activeHash,
      suspectedAt: now,
      emittedSuspected: false,
      emittedConfirmed: false,
      failureHash: activeFailureHash,
      cycleHashes: cycle?.hashes,
      freshMatchingFailures: 0,
      freshMatchingCycleFailures: 0,
    };
  }

  const episode = state.episode;
  const suspicionDurationMs = now - episode.suspectedAt;

  // Stage 2: confirmation requires ongoing qualifying evidence throughout the
  // confirmation window, not just elapsed wall-clock time.
  if (suspicionDurationMs >= CONFIRMATION_WINDOW_MS && !episode.emittedConfirmed) {
    const freshCycleRepetitions = episode.cycleHashes && episode.cycleHashes.length > 0
      ? Math.floor(episode.freshMatchingCycleFailures / episode.cycleHashes.length)
      : 0;
    const canConfirm = episode.kind === 'repeated_failure'
      ? episode.freshMatchingFailures >= CONFIRMATION_FRESH_FAILURES_THRESHOLD
      : freshCycleRepetitions >= CONFIRMATION_FRESH_CYCLE_REPETITIONS;
    if (!canConfirm) {
      clearEpisode(state, options, episode, 'pattern_changed', now);
      return { state, result: { verdict: 'healthy', cleared: true } };
    }
    if (!isCurrentAttemptValid(options)) {
      state.episode = null;
      return { state, result: { verdict: 'healthy' } };
    }
    const metrics = makeMetrics(
      episode.kind,
      dominant ?? { hash: activeHash, count: cycle?.repetitions ?? 0, unique: cycle?.period ?? 1 },
      matchingFailures,
      activeFailureHash,
      gitStagnantSec,
      state.cumulativeRawBytes,
      state.totalMeaningfulEvents,
      cycle ? { period: cycle.period, repetitions: cycle.repetitions } : undefined,
    );
    episode.emittedConfirmed = true;
    options.appendLedger(
      'agent_loop_confirmed',
      'task_id', options.taskId ?? '',
      'vendor', options.vendor,
      'agent_run_id', options.agentRunId,
      'episode_id', episode.id,
      'kind', episode.kind,
      'window_sec', String(metrics.windowSec),
      'git_stagnant_sec', String(metrics.gitStagnantSec),
      'raw_bytes', String(metrics.rawBytes),
      'meaningful_events', String(metrics.meaningfulEvents),
      'repeat_count', String(metrics.repeatCount),
      'failure_count', String(metrics.failureCount),
      'dominant_action_hash', metrics.dominantActionHash,
      ...(metrics.failureHash ? ['failure_hash', metrics.failureHash] : []),
    );
    return { state, result: { verdict: 'confirmed', episodeId: episode.id, metrics } };
  }

  // Stage 1: suspicion.
  if (!episode.emittedSuspected) {
    if (!isCurrentAttemptValid(options)) {
      state.episode = null;
      return { state, result: { verdict: 'healthy' } };
    }
    const metrics = makeMetrics(
      episode.kind,
      dominant ?? { hash: activeHash, count: cycle?.repetitions ?? 0, unique: cycle?.period ?? 1 },
      matchingFailures,
      activeFailureHash,
      gitStagnantSec,
      state.cumulativeRawBytes,
      state.totalMeaningfulEvents,
      cycle ? { period: cycle.period, repetitions: cycle.repetitions } : undefined,
    );
    episode.emittedSuspected = true;
    options.appendLedger(
      'agent_loop_suspected',
      'task_id', options.taskId ?? '',
      'vendor', options.vendor,
      'agent_run_id', options.agentRunId,
      'episode_id', episode.id,
      'kind', episode.kind,
      'window_sec', String(metrics.windowSec),
      'git_stagnant_sec', String(metrics.gitStagnantSec),
      'raw_bytes', String(metrics.rawBytes),
      'meaningful_events', String(metrics.meaningfulEvents),
      'repeat_count', String(metrics.repeatCount),
      'failure_count', String(metrics.failureCount),
      'dominant_action_hash', metrics.dominantActionHash,
      ...(metrics.failureHash ? ['failure_hash', metrics.failureHash] : []),
    );
    return { state, result: { verdict: 'suspected', episodeId: episode.id, metrics } };
  }

  return { state, result: { verdict: 'healthy' } };
}

export function isStreamingVendor(vendor: string): boolean {
  return STREAMING_VENDORS.has(vendor);
}

// Re-export helpers for tests.
export {
  extractCodexSignatures,
  extractKimiSignatures,
  extractOpenCodeSignatures,
  sampleGitSignature,
  readCaptureIncrementally,
  detectCycle,
  sha256,
};
