import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from '../dispatch.ts';
import { ledgerAppend, now, runDir, yamlScalar } from '../lib.ts';
import { promote } from '../promote.ts';
import { recordReview } from '../record-review.ts';
import { runInit } from '../run-init.ts';
import { verify, type VerifyResult } from '../verify.ts';
import type { DaemonOperation } from './protocol.ts';

export interface DaemonOperationDeps {
  runInit: typeof runInit;
  dispatch: typeof dispatch;
  promote: typeof promote;
  verify: typeof verify;
  recordReview: typeof recordReview;
  ledgerAppend: typeof ledgerAppend;
  now: typeof now;
}

export interface OperationContext {
  payload: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

export type OperationHandler = (
  context: OperationContext,
  deps: DaemonOperationDeps,
) => Promise<Record<string, unknown>>;

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing required string field: ${key}`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`invalid string field: ${key}`);
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`invalid boolean field: ${key}`);
  return value;
}

function assertRunExists(runId: string): string {
  const dir = runDir(runId);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`run does not exist: ${runId}`);
  }
  return dir;
}

async function handleCreateRun(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const baseCommit = optionalString(context.payload, 'base_commit');
  const runPath = deps.runInit(runId, baseCommit);
  return { run_id: runId, run_dir: runPath };
}

async function handleRegisterTask(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const taskId = requiredString(context.payload, 'task_id');
  const specYaml = requiredString(context.payload, 'spec_yaml');
  const runPath = assertRunExists(runId);
  const taskSpecPath = join(runPath, 'tasks', `${taskId}.yaml`);
  mkdirSync(join(runPath, 'tasks'), { recursive: true });
  writeFileSync(taskSpecPath, specYaml.endsWith('\n') ? specYaml : `${specYaml}\n`, 'utf8');
  const specVersion = yamlScalar(taskSpecPath, 'spec_version') || '1';
  deps.ledgerAppend(runId, 'task_registered', 'task_id', taskId, 'spec_version', specVersion);
  return {
    run_id: runId,
    task_id: taskId,
    task_spec: taskSpecPath,
    spec_version: specVersion,
  };
}

async function handleRecordDispatch(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const taskId = requiredString(context.payload, 'task_id');
  const background = optionalBoolean(context.payload, 'background') ?? false;
  const handle = await deps.dispatch(runId, taskId, { background });
  if (!background) {
    await handle.finished;
  }
  return { run_id: runId, task_id: taskId, agent_run_id: handle.agentRunId, background };
}

async function handlePromoteResult(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const taskId = requiredString(context.payload, 'task_id');
  const dropPath = requiredString(context.payload, 'drop_path');
  const result = await deps.promote(runId, taskId, dropPath);
  return {
    run_id: runId,
    task_id: taskId,
    promoted_path: result.promoted,
    divergence: result.divergence,
  };
}

async function handleRecordVerification(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const taskId = requiredString(context.payload, 'task_id');
  const worktree = requiredString(context.payload, 'worktree');
  const policy = requiredString(context.payload, 'policy');
  const runPath = assertRunExists(runId);
  const outPath = optionalString(context.payload, 'out_path')
    ?? join(runPath, 'authoritative', 'verification', `${taskId}.json`);

  mkdirSync(join(runPath, 'authoritative', 'verification'), { recursive: true });
  const observed: VerifyResult[] = await deps.verify(worktree, policy, outPath);
  const status = observed.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
  deps.ledgerAppend(runId, 'verification_executed', 'task_id', taskId, 'status', status);
  return {
    run_id: runId,
    task_id: taskId,
    status,
    out_path: outPath,
    commands: observed.length,
  };
}

async function handleRecordReview(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const taskId = requiredString(context.payload, 'task_id');
  const verdictPath = requiredString(context.payload, 'verdict_path');
  const recordedPath = deps.recordReview(runId, taskId, verdictPath);
  return {
    run_id: runId,
    task_id: taskId,
    review_path: recordedPath,
  };
}

function updateRunYamlState(runYamlPath: string, stateValue: string): void {
  const content = readFileSync(runYamlPath, 'utf8');
  const lines = content.split('\n');
  let updated = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('state:')) {
      lines[index] = `state: ${stateValue}`;
      updated = true;
      break;
    }
  }
  if (!updated) {
    lines.push(`state: ${stateValue}`);
  }
  const normalized = lines.join('\n');
  writeFileSync(runYamlPath, normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8');
}

async function handleCloseRun(
  context: OperationContext,
  deps: DaemonOperationDeps,
): Promise<Record<string, unknown>> {
  const runId = requiredString(context.payload, 'run_id');
  const status = optionalString(context.payload, 'status') ?? 'closed';
  const reason = optionalString(context.payload, 'reason') ?? '';
  const runPath = assertRunExists(runId);
  updateRunYamlState(join(runPath, 'run.yaml'), status);
  deps.ledgerAppend(runId, 'run_closed', 'status', status, 'reason', reason, 'closed_at', deps.now());
  return { run_id: runId, status };
}

async function handleHealth(): Promise<Record<string, unknown>> {
  return { status: 'ok', protocol: 1 };
}

export const DAEMON_OPERATION_HANDLERS: Record<DaemonOperation, OperationHandler> = {
  'create-run': handleCreateRun,
  'register-task': handleRegisterTask,
  'record-dispatch': handleRecordDispatch,
  'promote-result': handlePromoteResult,
  'record-verification': handleRecordVerification,
  'record-review': handleRecordReview,
  'close-run': handleCloseRun,
  health: handleHealth,
  shutdown: async () => ({ status: 'shutting_down' }),
};

export function defaultDaemonDeps(): DaemonOperationDeps {
  return {
    runInit,
    dispatch,
    promote,
    verify,
    recordReview,
    ledgerAppend,
    now,
  };
}
