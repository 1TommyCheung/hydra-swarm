export const DAEMON_PROTOCOL_VERSION = 1;

export const DAEMON_OPERATIONS = [
  'create-run',
  'register-task',
  'record-dispatch',
  'promote-result',
  'record-verification',
  'record-review',
  'close-run',
  'health',
  'shutdown',
] as const;

export type DaemonOperation = (typeof DAEMON_OPERATIONS)[number];

export interface DaemonRequestEnvelope {
  version: number;
  id: string;
  op: DaemonOperation;
  payload?: Record<string, unknown>;
}

export interface DaemonError {
  code:
    | 'validation_error'
    | 'not_found'
    | 'precondition_failed'
    | 'conflict'
    | 'internal_error';
  message: string;
}

export interface DaemonResponseEnvelope {
  version: number;
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: DaemonError;
}

export function isDaemonOperation(value: unknown): value is DaemonOperation {
  return typeof value === 'string' && (DAEMON_OPERATIONS as readonly string[]).includes(value);
}

export function parseDaemonRequestLine(line: string): DaemonRequestEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object');
  }
  const envelope = parsed as Partial<DaemonRequestEnvelope>;
  if (envelope.version !== DAEMON_PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version: ${String(envelope.version ?? '')}`);
  }
  if (typeof envelope.id !== 'string' || envelope.id.trim() === '') {
    throw new Error('missing or invalid id');
  }
  if (!isDaemonOperation(envelope.op)) {
    throw new Error(`unknown operation: ${String(envelope.op ?? '')}`);
  }
  if (
    envelope.payload !== undefined
    && (typeof envelope.payload !== 'object' || envelope.payload === null || Array.isArray(envelope.payload))
  ) {
    throw new Error('payload must be an object');
  }
  return {
    version: DAEMON_PROTOCOL_VERSION,
    id: envelope.id,
    op: envelope.op,
    payload: envelope.payload,
  };
}

export function successResponse(
  requestId: string,
  result: Record<string, unknown> = {},
): DaemonResponseEnvelope {
  return {
    version: DAEMON_PROTOCOL_VERSION,
    id: requestId,
    ok: true,
    result,
  };
}

export function errorResponse(
  requestId: string,
  code: DaemonError['code'],
  message: string,
): DaemonResponseEnvelope {
  return {
    version: DAEMON_PROTOCOL_VERSION,
    id: requestId,
    ok: false,
    error: { code, message },
  };
}
