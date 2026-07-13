import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildOtelEnv, formatOtelEnv, otelEnvShell } from '../src/otel-env.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-otel-env');

function ensureTmp(): void {
  mkdirSync(TEST_TMP, { recursive: true });
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function withEndpoint(value: string | undefined, fn: () => void): void {
  const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (value === undefined) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  } else {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
    }
  }
}

describe('buildOtelEnv', () => {
  after(cleanTmp);

  it('builds the default OTel env map', () => {
    withEndpoint(undefined, () => {
      const env = buildOtelEnv();
      assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
      assert.equal(env.OTEL_METRICS_EXPORTER, 'otlp');
      assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp');
      assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/protobuf');
      assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318');
      assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'service.name=hydra-swarm');
    });
  });

  it('respects OTEL_EXPORTER_OTLP_ENDPOINT override', () => {
    withEndpoint('http://custom:4318', () => {
      const env = buildOtelEnv();
      assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://custom:4318');
    });
  });

  it('falls back to default when OTEL_EXPORTER_OTLP_ENDPOINT is empty', () => {
    withEndpoint('', () => {
      const env = buildOtelEnv();
      assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318');
    });
  });
});

describe('formatOtelEnv', () => {
  it('formats an env map as shell export statements', () => {
    const shell = formatOtelEnv({
      KEY1: 'value1',
      KEY2: 'value two',
    });
    assert.equal(shell, 'export KEY1=value1\nexport KEY2=value two\n');
  });
});

describe('otelEnvShell', () => {
  after(cleanTmp);

  it('emits eval-able shell output matching the bash script', () => {
    withEndpoint(undefined, () => {
      ensureTmp();
      const shell = otelEnvShell();
      const scriptPath = join(TEST_TMP, 'otel-env.sh');
      writeFileSync(scriptPath, shell, 'utf8');
      const out = execFileSync(
        'bash',
        [
          '-c',
          `source "${scriptPath}" && env | grep -E '^(CLAUDE_CODE_ENABLE_TELEMETRY|OTEL_)'`,
        ],
        { encoding: 'utf8' },
      );
      assert.match(out, /CLAUDE_CODE_ENABLE_TELEMETRY=1/);
      assert.match(out, /OTEL_METRICS_EXPORTER=otlp/);
      assert.match(out, /OTEL_LOGS_EXPORTER=otlp/);
      assert.match(out, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/protobuf/);
      assert.match(out, /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/localhost:4318/);
      assert.match(out, /OTEL_RESOURCE_ATTRIBUTES=service\.name=hydra-swarm/);
    });
  });

  it('propagates a custom endpoint into shell output', () => {
    withEndpoint('http://collector:4318', () => {
      const shell = otelEnvShell();
      assert.match(shell, /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/collector:4318/);
    });
  });
});
