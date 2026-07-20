import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { assertTaskId } from './task-id.ts';

// ---------------------------------------------------------------------------
// Append-only, ledger-correlatable review verdict storage.
//
// A review round writes one file per publish under
// <run>/authoritative/reviews/<taskId>/, named "<seq>-<reviewedHead>.json".
// This lets a second review round add findings without destroying the first,
// and lets a replacement lead correlate a stored verdict back to the exact
// git head it was reviewed against.
// ---------------------------------------------------------------------------

const GIT_OBJECT_ID_RE = /^[0-9a-f]{40}$/i;

/**
 * reviewed_head is only typed as "string" by the review schema and gets
 * interpolated into a filename. Validate it as a full 40-char hex git object
 * id BEFORE it participates in any path construction, so a slash- or
 * traversal-shaped value ('../escape', 'abc/def') cannot escape the intended
 * reviews directory.
 */
export function assertGitObjectId(value: string, label: string): string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID_RE.test(value)) {
    throw new Error(
      `${label}: expected a 40-character hex git object id, got ${JSON.stringify(value)}`,
    );
  }
  return value.toLowerCase();
}

// taskId is interpolated into a path segment exactly like reviewed_head, so
// it needs the same treatment: the shared canonical grammar from task-id.ts
// (lowercase letters, digits and hyphens; no dots, no slashes, no
// leading/trailing hyphen; bounded length) simply cannot express a traversal.

export function reviewDirFor(runDirPath: string, taskId: string): string {
  // Validate BEFORE any path is constructed. The grammar alone cannot contain
  // a traversal; the containment assertion after resolving is defence-in-depth
  // in case the grammar is ever loosened.
  assertTaskId(taskId);
  const reviewsRoot = resolve(runDirPath, 'authoritative', 'reviews');
  const dir = resolve(reviewsRoot, taskId);
  if (dir !== reviewsRoot && !dir.startsWith(reviewsRoot + sep)) {
    throw new Error(
      `taskId ${JSON.stringify(taskId)} escapes the reviews directory: ` +
      `${dir} is not beneath ${reviewsRoot}`,
    );
  }
  return dir;
}

export function reviewFileName(seq: number, reviewedHead: string): string {
  const head = assertGitObjectId(reviewedHead, 'reviewedHead');
  const paddedSeq = String(seq).padStart(4, '0');
  return `${paddedSeq}-${head}.json`;
}

/**
 * Serialize directly instead of building a sorted intermediate object in a
 * plain {}: assigning a parsed own '__proto__' key into {} mutates the
 * temporary's prototype instead of becoming an own property, so two different
 * findings could serialize identically. Inputs that are not JSON values
 * (undefined, functions, symbols, NaN, Infinity) are rejected rather than
 * silently collapsed.
 */
function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: ${value} is not a JSON value`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      // undefined, function, symbol, bigint: JSON has no representation.
      throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
  }
}

/** Deterministic JSON: object keys sorted recursively so key order cannot change a hash. */
export function canonicalJson(value: unknown): string {
  return canonicalSerialize(value);
}

/**
 * Findings are identified by a hash over their full context (ref, field,
 * index, value) rather than just their content, so a byte-identical finding
 * re-raised in a different verdict or at a different position is treated as
 * a NEW finding that must be resolved deliberately, not silently merged with
 * a prior one.
 */
export function findingId(ref: string, field: string, index: number, value: unknown): string {
  const record = canonicalJson({
    version: 'hydra-finding-v1',
    ref,
    field,
    index,
    value,
  });
  return createHash('sha256').update(record).digest('hex');
}

export interface PublishedVerdict {
  seq: number;
  path: string;
  sha256: string;
}

const LOCK_RETRY_DELAY_MS = 20;
const LOCK_TIMEOUT_MS = 5000;
/**
 * A lock older than this is reclaimed as stale. Deliberately much larger than
 * LOCK_TIMEOUT_MS: a live publisher holds the lock for milliseconds, so
 * anything this old can only be a crash leftover. Staleness is judged by AGE
 * alone: a pid recorded in the lock cannot distinguish PID REUSE, so a
 * liveness check would mistake a dead owner's recycled pid for a live owner
 * and time out every future publish forever.
 */
const STALE_LOCK_AGE_MS = 30_000;

/** Ownership record written into an immutable generation owner file. */
interface LockRecord {
  pid: number;
  token: string;
  /** Epoch milliseconds when the lock was acquired. */
  acquired: number;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * fsync an opened directory so that a newly created entry in it (a task
 * directory, a lock file, a linked verdict) is durable before the caller
 * relies on it.
 */
function fsyncDirectorySync(dirPath: string, closeFaultStage?: string): void {
  const fd = openSync(dirPath, 'r');
  let primary: unknown;
  try {
    fsyncSync(fd);
  } catch (err) {
    primary = err;
    throw err;
  } finally {
    try {
      closeSync(fd);
      if (closeFaultStage !== undefined) maybeInjectFault(closeFaultStage);
    } catch (err) {
      if (primary === undefined) throw err;
    }
  }
}

/**
 * writeSync(2) may short-write; loop until the complete byte sequence has
 * been written through the descriptor.
 */
function writeAllSync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const requested = faultEnabled('lock-write-short') ? 1 : bytes.length - offset;
    const written = faultEnabled('lock-write-zero') ? 0 : writeSync(fd, bytes, offset, requested);
    if (written <= 0) throw new Error('review publish lock write made zero progress');
    offset += written;
  }
}

// Match \d+, not \d{4}: reviewFileName pads to AT LEAST 4 digits, so a
// sequence past 9999 still produces a discoverable name. With \d{4} a 5-digit
// file was invisible to seq discovery, which then returned the same seq
// forever and let a replacing rename silently overwrite the earlier verdict.
const PUBLISHED_NAME_RE = /^(\d+)-[0-9a-f]{40}\.json$/;

/**
 * A `.seq-0001.claimed` DIRECTORY is both the atomic sequence reservation and
 * the ordered lock generation. Its immutable `.owner-<random>` child is the
 * ownership identity. mkdir(2) chooses exactly one owner for a sequence; later
 * generations wait for every lower live generation before entering.
 */
const MARKER_NAME_RE = /^\.seq-(\d+)\.claimed$/;
const OWNER_NAME_RE = /^\.owner-([0-9a-f]{32})$/;

function markerPathFor(dir: string, seq: number): string {
  return join(dir, `.seq-${String(seq).padStart(4, '0')}.claimed`);
}

interface LockClaim { seq: number; claimPath: string; ownerPath: string }

/**
 * Documented safe upper bound on a single task's review rounds. 9999 rounds
 * is already pathological for one task; the publish that would exceed the
 * bound fails loudly instead of degrading the append-only store.
 */
const MAX_PUBLISHED_SEQ = 9999;

/**
 * Allocate the next sequence number, claiming it atomically by
 * exclusive-creating its marker. Candidates come from a directory listing
 * over BOTH published verdicts and outstanding claims; on a claim collision
 * the loser rescans and retries with the next candidate.
 */
function allocateSeq(dir: string, taskId: string): LockClaim {
  for (;;) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    let max = 0;
    for (const name of entries) {
      const match = PUBLISHED_NAME_RE.exec(name) ?? MARKER_NAME_RE.exec(name);
      if (match === null) continue;
      const seq = Number(match[1]);
      if (seq > max) max = seq;
    }
    const candidate = max + 1;
    if (candidate > MAX_PUBLISHED_SEQ) {
      throw new Error(
        `review verdict sequence ${candidate} for task ${JSON.stringify(taskId)} exceeds the ` +
        `documented append-only bound of ${MAX_PUBLISHED_SEQ}; refusing to publish`,
      );
    }
    try {
      const claimPath = markerPathFor(dir, candidate);
      mkdirSync(claimPath);
      const token = randomBytes(16).toString('hex');
      const ownerPath = join(claimPath, `.owner-${token}`);
      const record: LockRecord = { pid: process.pid, token, acquired: Date.now() };
      const fd = openSync(ownerPath, 'wx');
      let closed = false;
      try {
        maybeInjectFault('lock-write');
        writeAllSync(fd, Buffer.from(JSON.stringify(record)));
        maybeInjectFault('lock-fsync');
        fsyncSync(fd);
        closeSync(fd);
        closed = true;
        maybeInjectFault('lock-close');
        maybeInjectFault('lock-dir-fsync');
        fsyncDirectorySync(claimPath, 'lock-dir-close');
        fsyncDirectorySync(dir, 'lock-parent-dir-close');
      } catch (err) {
        if (!closed) { try { closeSync(fd); } catch {} }
        try { maybeInjectFault('lock-cleanup-owner'); unlinkSync(ownerPath); } catch {}
        try { maybeInjectFault('lock-cleanup-claim'); rmdirSync(claimPath); } catch {}
        throw err;
      }
      return { seq: candidate, claimPath, ownerPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another publisher claimed this seq first — rescan and retry.
    }
  }
}

function ownerAgeMs(ownerPath: string): number {
  maybeInjectFault('stale-read');
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, 'utf8')) as Partial<LockRecord>;
    if (typeof parsed.acquired === 'number') return Date.now() - parsed.acquired;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return -1;
  }
  try { return Date.now() - statSync(ownerPath).mtimeMs; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return -1; throw err; }
}

/**
 * Ownership invariant: every acquisition has a never-reused claim generation
 * and a random, immutable owner pathname inside it. Publishers wait behind all
 * lower generations. Release and stale recovery destroy only that immutable
 * owner pathname; they never inspect a shared pathname and later unlink/move
 * whatever has replaced it. A replacement therefore has a different pathname
 * and cannot be captured or removed by a paused predecessor. Empty-generation
 * removal is safe because generations are never reused while any later claim
 * or published verdict records progress; ENOTEMPTY is an ambiguous replacement
 * and is deliberately left in place (fail closed).
 */
function waitForTurn(dir: string, claim: LockClaim): void {
  let waited = 0;
  for (;;) {
    let blocked = false;
    const entries = readdirSync(dir);
    for (const name of entries) {
      const match = MARKER_NAME_RE.exec(name);
      if (match === null || Number(match[1]) >= claim.seq) continue;
      const lowerPath = join(dir, name);
      let owners: string[];
      try { owners = readdirSync(lowerPath).filter((entry) => OWNER_NAME_RE.test(entry)); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (owners.length === 0) {
        let age: number;
        try { age = Date.now() - statSync(lowerPath).mtimeMs; }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        if (age >= STALE_LOCK_AGE_MS) {
          testHookPoint('stale-observed');
          try { maybeInjectFault('stale-cleanup'); rmdirSync(lowerPath); }
          catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw err;
            if (code === 'ENOTEMPTY') {
              testHookPoint('stale-replacement-preserved');
              blocked = true;
            }
          }
        } else blocked = true;
        continue;
      }
      for (const owner of owners) {
        const ownerPath = join(lowerPath, owner);
        const age = ownerAgeMs(ownerPath);
        if (age < 0) continue;
        if (age < STALE_LOCK_AGE_MS) { blocked = true; continue; }
        testHookPoint('stale-observed');
        try {
          maybeInjectFault('stale-owner-unlink');
          unlinkSync(ownerPath);
          testHookPoint('stale-claimed');
        }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
      try { maybeInjectFault('stale-cleanup'); rmdirSync(lowerPath); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw err;
        if (code === 'ENOTEMPTY') {
          // No restore is needed: the live replacement was never moved. The
          // non-empty generation itself keeps every later owner blocked.
          testHookPoint('stale-replacement-preserved');
          blocked = true;
        }
      }
    }
    if (!existsSync(claim.ownerPath)) {
      throw new Error(`review publish ownership was lost before acquisition: ${claim.ownerPath}`);
    }
    const ownOthers = readdirSync(claim.claimPath)
      .filter((entry) => OWNER_NAME_RE.test(entry) && join(claim.claimPath, entry) !== claim.ownerPath);
    if (ownOthers.length !== 0) {
      throw new Error(`ambiguous review publish ownership in ${claim.claimPath}`);
    }
    if (!blocked) return;
    testHookPoint('blocked');
    if (waited >= LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for review publish claim: ${claim.claimPath}`);
    sleepSync(LOCK_RETRY_DELAY_MS);
    waited += LOCK_RETRY_DELAY_MS;
  }
}

function releaseClaim(claim: LockClaim): void {
  testHookPoint('release-before-owner-unlink');
  try { maybeInjectFault('release-owner-unlink'); unlinkSync(claim.ownerPath); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  testHookPoint('release-after-owner-unlink');
  try { maybeInjectFault('release-claim-rmdir'); rmdirSync(claim.claimPath); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw err;
    if (code === 'ENOTEMPTY') throw new Error(`ambiguous review publish release preserved: ${claim.claimPath}`);
  }
}

/**
 * Fault injection is inert unless the caller also proves possession of the
 * validated hook-directory capability. A fault tag or path alone is never an
 * activation mechanism.
 */
function faultEnabled(stage: string): boolean {
  return hookConfig() !== undefined && (process.env.HYDRA_REVIEW_STORE_FAULT ?? '').split(',').includes(stage);
}

function maybeInjectFault(stage: string): void {
  if (faultEnabled(stage)) {
    throw new Error(`injected fault at review-store publish stage: ${stage}`);
  }
}

// ---------------------------------------------------------------------------
// Test-only contention barrier.
//
// Hooks require a random capability in BOTH the environment and the contained
// `.hydra-review-store.capability` file. Paths and tags are validated before a
// barrier is constructed. A comma-separated pause list can park only after a
// named real transition (including genuine acquisition); it cannot bypass the
// ordered ownership algorithm. Every pause is bounded.
// ---------------------------------------------------------------------------

/** Bounded so a test that never releases the hold fails instead of hanging. */
const HOOK_RELEASE_TIMEOUT_MS = 10_000;

interface HookConfig { dir: string; tag: string }
const HOOK_TAG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HOOK_CAP_RE = /^[0-9a-f]{32,128}$/;

function hookConfig(): HookConfig | undefined {
  const hookDir = process.env.HYDRA_REVIEW_STORE_HOOK_DIR;
  if (hookDir === undefined || hookDir === '') return undefined;
  const capability = process.env.HYDRA_REVIEW_STORE_HOOK_CAPABILITY;
  const tag = process.env.HYDRA_REVIEW_STORE_HOOK_TAG ?? `pid-${process.pid}`;
  const resolvedDir = resolve(hookDir);
  if (hookDir !== resolvedDir || !resolvedDir.startsWith(sep)) return undefined;
  if (capability === undefined || !HOOK_CAP_RE.test(capability) || !HOOK_TAG_RE.test(tag)) return undefined;
  try {
    const capabilityPath = resolve(resolvedDir, '.hydra-review-store.capability');
    if (!capabilityPath.startsWith(resolvedDir + sep)) return undefined;
    if (readFileSync(capabilityPath, 'utf8') !== capability) return undefined;
  } catch { return undefined; }
  return { dir: resolvedDir, tag };
}

function testHookPoint(name: string): void {
  const config = hookConfig();
  if (config === undefined || !HOOK_TAG_RE.test(name)) return;
  const barrier = join(config.dir, `${config.tag}.${name}`);
  try {
    writeFileSync(barrier, String(Date.now()), { flag: 'wx' });
  } catch {}
  const pauses = (process.env.HYDRA_REVIEW_STORE_HOOK_PAUSE ?? '').split(',');
  if (!pauses.includes(name)) return;
  const releaseBarrier = join(config.dir, `${config.tag}.${name}.release`);
  const deadline = Date.now() + HOOK_RELEASE_TIMEOUT_MS;
  while (!existsSync(releaseBarrier)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `review-store test hook: timed out waiting for release barrier ${releaseBarrier}`,
      );
    }
    sleepSync(10);
  }
}

export function publishVerdict(
  runDirPath: string,
  taskId: string,
  verdictBytes: Buffer,
  reviewedHead: string,
): PublishedVerdict {
  const head = assertGitObjectId(reviewedHead, 'reviewedHead');
  const dir = reviewDirFor(runDirPath, taskId);
  const taskDirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  if (!taskDirExisted) {
    // First publish for this task: the recursive mkdir created the per-task
    // reviews directory, but that new directory ENTRY is only durable once
    // its parent — the reviews root — has been fsynced. Do it before
    // proceeding so a crash cannot lose the directory the verdict (and the
    // ledger event referencing it) is about to land in. An existing directory
    // needs no such fsync: no new entry was created.
    maybeInjectFault('reviews-dir-fsync');
    fsyncDirectorySync(dirname(dir), 'reviews-dir-close');
  }
  const claim = allocateSeq(dir, taskId);
  let primary: unknown;
  try {
    waitForTurn(dir, claim);
    testHookPoint('acquired');
    const seq = claim.seq;
    const fileName = reviewFileName(seq, head);
    const finalPath = join(dir, fileName);
    const tmpPath = join(dir, `.${fileName}.tmp-${process.pid}`);

    // Durability order: write the temp file, fsync and close it, publish
    // atomically with a NO-REPLACE primitive — link(2) fails with EEXIST
    // rather than overwriting an existing verdict, which a replacing rename
    // cannot guarantee for append-only storage — then fsync the DIRECTORY so
    // the new directory entry is durable before the caller appends the ledger
    // event that references it.
    //
    // The whole post-claim lifecycle sits inside ONE try/finally: a failure
    // at ANY stage (open, write, fsync, close, link, the temp unlink, or the
    // directory fsync) must leak neither the temp file nor the seq claim
    // into the reviews directory, where the discovery scan would have to
    // ignore them forever.
    let published = false;
    maybeInjectFault('open');
    const fd = openSync(tmpPath, 'w');
    let filePrimary: unknown;
    try {
      try {
        maybeInjectFault('write');
        writeFileSync(fd, verdictBytes);
        maybeInjectFault('fsync-file');
        fsyncSync(fd);
      } catch (err) {
        filePrimary = err;
        throw err;
      } finally {
        try {
          closeSync(fd);
          maybeInjectFault('file-close');
        } catch (err) {
          if (filePrimary === undefined) throw err;
        }
      }
      maybeInjectFault('link');
      linkSync(tmpPath, finalPath);
      maybeInjectFault('unlink-tmp');
      unlinkSync(tmpPath);
      published = true;
      maybeInjectFault('dir-fsync');
      fsyncDirectorySync(dir, 'dir-close');
    } finally {
      if (!published) {
        // A failure left the temp behind: remove it. The PRIMARY error
        // must win — published === false means one is already in flight —
        // so a cleanup failure is swallowed rather than allowed to mask
        // it; ENOENT simply means the temp never got created or is
        // already gone.
        try {
          maybeInjectFault('temp-cleanup');
          unlinkSync(tmpPath);
        } catch {
          // Deliberately swallowed (see above).
        }
      }
    }

    const sha256 = createHash('sha256').update(verdictBytes).digest('hex');
    return { seq, path: finalPath, sha256 };
  } catch (err) {
    primary = err;
    throw err;
  } finally {
    try { releaseClaim(claim); }
    catch (err) { if (primary === undefined) throw err; }
  }
}

export default {
  assertGitObjectId,
  reviewDirFor,
  reviewFileName,
  canonicalJson,
  findingId,
  publishVerdict,
};
