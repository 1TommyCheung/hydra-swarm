import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// TEST FIXTURE ONLY: offline deterministic stub vendor adapter.
//
// TypeScript port of hydra/adapters/stub.sh. Implements the same
// dispatch-compatible `start` verb (and `resume`, treated identically) as the
// other TS adapters so dispatch.ts drives it uniformly:
//   adapter-stub.ts start <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]
//
// Makes ZERO network or real-vendor-CLI calls. Every Git claim in its result
// drop is observed from the assigned worktree. STUB_MODE selects deterministic
// fixture behavior for promote-gate coverage:
//   success   -> commit, status "completed"
//   fail      -> commit, status "failed"                (not_completed)
//   no_commit -> no commit, status "completed"          (no_commit)
// ---------------------------------------------------------------------------

/** Injectable synchronous git runner (mirrors child_process.execFileSync). */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: string; cwd?: string; stdio?: unknown; env?: NodeJS.ProcessEnv },
) => string | Buffer;

/** Options that make the side-effectful adapter function testable. */
export interface StubOptions {
  /** Working directory used to resolve relative paths; defaults to process.cwd(). */
  cwd?: string;
  /** Injected git runner; defaults to a real execFileSync. */
  exec?: ExecLike;
}

/** Result drop shape written to inbox/result.json. */
export interface StubResult {
  task_id: string;
  run_id: string;
  spec_version: number;
  vendor: 'stub';
  session_id: string;
  status: 'completed' | 'failed';
  branch: string;
  base_commit: string;
  head_commit: string;
  summary: string;
  files_changed: string[];
  verification_claims: never[];
  risks: string[];
  unresolved_questions: never[];
  suggested_additional_checks: never[];
}

const DETERMINISTIC_DATE = '2000-01-01T00:00:00Z';

function runGit(exec: ExecLike, worktree: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return String(
    exec('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }),
  ).trim();
}

function commitFixtureChange(exec: ExecLike, worktree: string, agentRunId: string): void {
  writeFileSync(resolve(worktree, 'stub-output.txt'), `stub worker marker for ${agentRunId}\n`);
  runGit(exec, worktree, ['add', '--', 'stub-output.txt']);
  runGit(
    exec,
    worktree,
    ['commit', '-qm', `stub: deterministic commit for ${agentRunId}`],
    {
      ...process.env,
      GIT_AUTHOR_DATE: DETERMINISTIC_DATE,
      GIT_COMMITTER_DATE: DETERMINISTIC_DATE,
    },
  );
}

/**
 * Run the stub adapter for the given verb.
 *
 * Implements the adapter `start` and `resume` verbs from stub.sh (the two are
 * treated identically — the stub never produces a real session_id, so there is
 * nothing to resume from).
 *
 * @returns the agent_run_id that was passed in, after printing it to stdout.
 */
export function stub(
  verb: string,
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  options: StubOptions = {},
): string {
  if (!verb) {
    die('usage: stub.sh start|resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]');
  }
  if (verb !== 'start' && verb !== 'resume') {
    die(`stub.sh: unknown verb '${verb}'`);
  }
  if (!taskSpec) die('task_spec required');
  if (!worktree) die('worktree required');
  if (!inbox) die('inbox required');
  if (!sessions) die('sessions required');
  if (!agentRunId) die('agent_run_id required');

  const cwd = options.cwd ?? process.cwd();
  const worktreeAbs = resolve(cwd, worktree);
  const inboxAbs = resolve(cwd, inbox);
  const sessionsAbs = resolve(cwd, sessions);

  mkdirSync(inboxAbs, { recursive: true });
  mkdirSync(sessionsAbs, { recursive: true });

  const taskId = yamlScalar(taskSpec, 'task_id');
  const runId = yamlScalar(taskSpec, 'run_id');
  const specVersionRaw = yamlScalar(taskSpec, 'spec_version');
  const specVersion = Number(specVersionRaw || '1');

  // Resolve all Git fields from the repository rather than copying claimed
  // state from the task YAML. promote() independently checks these
  // observations against that task specification.
  const exec = options.exec ?? ((file, args, opts) => execFileSync(file, args, opts as Parameters<typeof execFileSync>[2]));
  const declaredBase = yamlScalar(taskSpec, 'base_commit');
  const baseCommit = runGit(exec, worktreeAbs, ['rev-parse', declaredBase]);
  const branch = runGit(exec, worktreeAbs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

  const mode = process.env.STUB_MODE ?? 'success';
  if (mode === 'success' || mode === 'fail') {
    commitFixtureChange(exec, worktreeAbs, agentRunId);
  } else if (mode === 'no_commit') {
    // Deliberately make no commit.
  } else {
    die(`stub.sh: unknown STUB_MODE '${mode}'`);
  }

  const headCommit = runGit(exec, worktreeAbs, ['rev-parse', 'HEAD']);
  const filesChanged = runGit(
    exec,
    worktreeAbs,
    ['diff', '--name-only', `${baseCommit}...${headCommit}`],
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let status: 'completed' | 'failed' = 'completed';
  let summary = 'stub deterministic commit';
  let risk = '';
  if (mode === 'fail') {
    status = 'failed';
    summary = 'stub committed but simulated a failed worker report';
    risk = 'stub fail mode after commit';
  } else if (mode === 'no_commit') {
    summary = 'stub simulated completed report without a commit';
    risk = 'stub produced no commit';
  }

  const result: StubResult = {
    task_id: taskId,
    run_id: runId,
    spec_version: specVersion,
    vendor: 'stub',
    session_id: '',
    status,
    branch,
    base_commit: baseCommit,
    head_commit: headCommit,
    summary,
    files_changed: filesChanged,
    verification_claims: [],
    risks: risk === '' ? [] : [risk],
    unresolved_questions: [],
    suggested_additional_checks: [],
  };

  writeFileSync(resolve(inboxAbs, 'result.json'), `${JSON.stringify(result)}\n`);

  const session = {
    agent_run_id: agentRunId,
    vendor: 'stub',
    session_id: '',
  };
  writeFileSync(resolve(sessionsAbs, `${agentRunId}.json`), `${JSON.stringify(session)}\n`);

  process.stdout.write(`${agentRunId}\n`);
  return agentRunId;
}

export default { stub };

// ---------------------------------------------------------------------------
// CLI entry point — node --experimental-strip-types hydra-ts/src/adapter-stub.ts
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const [verb, taskSpec, worktree, inbox, sessions, agentRunId] = process.argv.slice(2);
    stub(verb, taskSpec, worktree, inbox, sessions, agentRunId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
