import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

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

/**
 * taskId is interpolated into a path segment exactly like reviewed_head, so
 * it needs the same treatment: a strict canonical grammar (lowercase letters,
 * digits and hyphens; no dots, no slashes, no leading/trailing hyphen;
 * bounded length) that simply cannot express a traversal.
 */
const TASK_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_TASK_ID_LENGTH = 64;

function assertTaskId(taskId: string): void {
  if (
    typeof taskId !== 'string'
    || taskId.length === 0
    || taskId.length > MAX_TASK_ID_LENGTH
    || !TASK_ID_RE.test(taskId)
  ) {
    throw new Error(
      `taskId: invalid task identifier ${JSON.stringify(taskId)} — expected 1-` +
      `${MAX_TASK_ID_LENGTH} characters of [a-z0-9-] with no leading/trailing hyphen`,
    );
  }
}

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

/** Ownership record written into the lock file. The pid is diagnostic only. */
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

function lockPathFor(dir: string): string {
  return join(dir, '.publish.lock');
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Partial<LockRecord>;
      if (
        typeof record.pid === 'number'
        && typeof record.token === 'string'
        && typeof record.acquired === 'number'
      ) {
        return record as LockRecord;
      }
    }
  } catch {
    // Unparseable: fall through.
  }
  return undefined;
}

/** A lock judged stale: the exact content of the lock file at judgment time. */
interface StaleLock {
  content: string;
}

/**
 * Return the raw content of the lock file if — and only if — it is provably
 * stale (older than STALE_LOCK_AGE_MS), else undefined. The age comes from
 * the ownership record's acquisition time when one is readable, falling back
 * to the file mtime for unparseable leftovers, so a corrupted lock cannot
 * deadlock every future publish either. A young or missing lock is NOT stale.
 */
function readStaleLock(lockPath: string): StaleLock | undefined {
  let content: string;
  try {
    content = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let acquired: number | undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Partial<LockRecord>;
      if (typeof record.acquired === 'number') acquired = record.acquired;
    }
  } catch {
    // Unparseable: fall back to the file mtime below.
  }
  if (acquired === undefined) {
    try {
      acquired = statSync(lockPath).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }
  if (Date.now() - acquired < STALE_LOCK_AGE_MS) return undefined;
  return { content };
}

/**
 * Attempt to reclaim a PROVABLY stale lock — atomically with respect to the
 * lock IDENTITY, never the pathname. Unlinking a lock pathname based on a
 * prior read is the ABA race this must not commit: two waiters can both judge
 * the same stale lock, and the second unlinkSync then deletes the FIRST
 * reclaimer's freshly acquired lock, admitting two publishers into the
 * critical section at once.
 *
 * Instead the stale lock is claimed by RENAMING it to a unique path. rename(2)
 * atomically hands the claimant whatever file currently lives at lockPath,
 * and only ONE claimant's rename of the same stale file can win — the loser's
 * fails with ENOENT. The winner re-reads the CLAIMED file and proceeds only
 * when its content is byte-identical to the record it judged stale. If the
 * rename captured a DIFFERENT lock (between the staleness read and the rename
 * the dead lock was legitimately replaced by a live one), the captured lock is
 * handed back with an atomic no-replace link(2) and the claimant backs off.
 *
 * Returns true only when this caller genuinely reclaimed the stale lock and
 * lockPath is free for its next exclusive-create attempt.
 */
function tryReclaimStaleLock(dir: string, lockPath: string): boolean {
  const stale = readStaleLock(lockPath);
  if (stale === undefined) return false;

  const claimPath = join(
    dir,
    `.publish.lock.reclaim-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    renameSync(lockPath, claimPath);
  } catch (err) {
    // ENOENT: another claimant moved the stale lock first, or it was released
    // — either way WE did not win the claim, so just keep waiting.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const claimed = readFileSync(claimPath, 'utf8');
  if (claimed === stale.content) {
    // Genuine reclaim: the claimed file IS the dead lock we judged. Dispose
    // of it; the caller's next exclusive create wins the freed pathname.
    try {
      unlinkSync(claimPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return true;
  }

  // The claim captured a different lock than the one judged stale: hand it
  // back atomically. link(2) fails with EEXIST rather than displacing yet
  // another lock if one appeared while the captured lock was held aside, so
  // this restore can never overwrite a live lock.
  try {
    linkSync(claimPath, lockPath);
  } catch (err) {
    // Best-effort cleanup of our claim copy before backing off or throwing.
    try {
      unlinkSync(claimPath);
    } catch {
      // The claim copy is uniquely named and junk-only; nothing to preserve.
    }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  unlinkSync(claimPath);
  return false;
}

/**
 * Allocating a sequence number from a directory listing is racy: two
 * reviewers publishing at once can observe the same "next seq" and, because
 * different reviewed_heads yield different filenames at the same seq,
 * O_EXCL on the final filename alone would not catch the collision. Guard
 * the whole allocate -> write -> publish -> hash critical section with an
 * exclusive-create lock file, following the O_EXCL latch idiom in lib.ts —
 * except this lock must be released (it guards a repeatable critical
 * section, not a one-shot "first past the post" pin), and it must survive a
 * crashed owner: the lock file carries an ownership record (pid, token,
 * acquisition time) so a later publisher can reclaim it once it is provably
 * stale, via the atomic rename-to-claim in tryReclaimStaleLock. Returns the
 * ownership token, which releaseLock requires as proof.
 */
function acquireLock(dir: string, lockPath: string): string {
  const record: LockRecord = {
    pid: process.pid,
    token: randomBytes(8).toString('hex'),
    acquired: Date.now(),
  };
  let waited = 0;
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' });
      return record.token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (tryReclaimStaleLock(dir, lockPath)) {
        // We genuinely reclaimed the stale lock — retry the create at once.
        continue;
      }
      if (waited >= LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for review publish lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
      waited += LOCK_RETRY_DELAY_MS;
    }
  }
}

function releaseLock(lockPath: string, token: string): void {
  // Release only a lock we still own: if ours was reclaimed as stale and
  // another publisher has since taken it, unlinking would drop THEIR lock.
  const record = readLockRecord(lockPath);
  if (record === undefined || record.token !== token) return;
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// Match \d+, not \d{4}: reviewFileName pads to AT LEAST 4 digits, so a
// sequence past 9999 still produces a discoverable name. With \d{4} a 5-digit
// file was invisible to seq discovery, which then returned the same seq
// forever and let a replacing rename silently overwrite the earlier verdict.
const PUBLISHED_NAME_RE = /^(\d+)-[0-9a-f]{40}\.json$/;

/**
 * Sequence claim marker: `.seq-0001.claimed`. Claiming a seq by
 * exclusive-creating its marker is the ATOMIC allocation fence. The publish
 * lock serializes publishers in the normal case, but POSIX offers no
 * conditional unlink, so stale-lock reclamation can — in a vanishingly rare
 * multi-preemption corner — admit two publishers at once. The marker makes a
 * duplicate seq impossible even then: exactly one publisher can claim a given
 * seq and the loser rescans, and link(2) still guarantees no overwrite of the
 * verdict file itself. A marker is removed once the verdict carrying its seq
 * is durably linked (the filename then records the seq), so markers do not
 * accumulate; a marker left behind by a crash is a harmless, semantically
 * valid reservation of its seq.
 */
const MARKER_NAME_RE = /^\.seq-(\d+)\.claimed$/;

function markerPathFor(dir: string, seq: number): string {
  return join(dir, `.seq-${String(seq).padStart(4, '0')}.claimed`);
}

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
function allocateSeq(dir: string, taskId: string): number {
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
      writeFileSync(markerPathFor(dir, candidate), '', { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another publisher claimed this seq first — rescan and retry.
    }
  }
}

/**
 * Test-only fault injection: when HYDRA_REVIEW_STORE_FAULT names a publish
 * stage, throw a synthetic error at that stage. Nothing in production sets
 * the variable; it exists so the temp-leak regression tests can reach every
 * failure path of the temp-file lifecycle deterministically.
 */
function maybeInjectFault(stage: string): void {
  if (process.env.HYDRA_REVIEW_STORE_FAULT === stage) {
    throw new Error(`injected fault at review-store publish stage: ${stage}`);
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
  mkdirSync(dir, { recursive: true });
  const lockPath = lockPathFor(dir);

  const lockToken = acquireLock(dir, lockPath);
  try {
    const seq = allocateSeq(dir, taskId);
    const markerPath = markerPathFor(dir, seq);
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
    try {
      maybeInjectFault('open');
      const fd = openSync(tmpPath, 'w');
      try {
        try {
          maybeInjectFault('write');
          writeFileSync(fd, verdictBytes);
          maybeInjectFault('fsync-file');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        maybeInjectFault('link');
        linkSync(tmpPath, finalPath);
        maybeInjectFault('unlink-tmp');
        unlinkSync(tmpPath);
        published = true;
        maybeInjectFault('dir-fsync');
        const dirFd = openSync(dir, 'r');
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } finally {
        if (!published) {
          // A failure left the temp behind: remove it. The PRIMARY error
          // must win — published === false means one is already in flight —
          // so a cleanup failure is swallowed rather than allowed to mask
          // it; ENOENT simply means the temp never got created or is
          // already gone.
          try {
            unlinkSync(tmpPath);
          } catch {
            // Deliberately swallowed (see above).
          }
        }
      }
    } finally {
      if (!published) {
        // The seq claim went unfulfilled (no verdict carries it): release
        // it so the next publish can reuse the seq. Same primary-error
        // preservation as above.
        try {
          unlinkSync(markerPath);
        } catch {
          // Deliberately swallowed (see above).
        }
      }
    }

    // The verdict carrying this seq is now durably linked and discoverable,
    // so the claim marker is redundant — drop it. A failure here leaves only
    // a harmless seq reservation behind, so it must not fail the publish.
    try {
      unlinkSync(markerPath);
    } catch {
      // Leftover marker: harmless (see MARKER_NAME_RE comment).
    }

    const sha256 = createHash('sha256').update(verdictBytes).digest('hex');
    return { seq, path: finalPath, sha256 };
  } finally {
    releaseLock(lockPath, lockToken);
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
