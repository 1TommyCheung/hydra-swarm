// blackbox-compiled.ts — Stage 1 Phase 3 black-box test harness for compiled
// hydra-cli binaries (docs/bun-migration-stage3-blackbox.md).
//
// Usage:
//   node --experimental-strip-types scripts/blackbox-compiled.ts <path-to-binary> [--keep-scratch] [--timeout-ms=N]
//
// The binary under test is treated as an OPAQUE EXECUTABLE: it is only ever
// invoked as a child process with argv/env/cwd, exactly as an operator would
// run it. Nothing about the host OS is assumed (this same harness runs
// unchanged against the macOS build here and against the Linux cross-compiled
// builds inside the lead's container), and the binary is never given access
// to Node or Bun dev tooling: every invocation runs with a scrubbed
// environment whose PATH is an EMPTY directory (no node, no bun, no git, no
// vendor CLIs, no /bin/sh resolution via PATH).
//
// Suite (per docs/bun-migration-plan-codex.md "CI gates" and the Stage 2 fix
// docs):
//   1. smoke[<name>]        — every routed subcommand invoked with no args
//                             from a checkout-free scratch cwd must produce
//                             its own expected usage/help/dependency error
//                             and expected exit code — no crash, no hang, no
//                             unhandled rejection, and CRITICALLY no output
//                             from any OTHER subcommand (regression test for
//                             the isMain-guard cascade fixed in
//                             docs/bun-migration-stage2-guard-neutralization.md).
//   2. cwd-independence[…]  — a COPY of the binary in the scratch dir, run
//                             from an empty cwd with the checkout absent:
//                             embedded assets (seed profiles, schemas) must
//                             still be found and enforced; checkout-relative
//                             assets (policy YAMLs, WAVE) must fail loudly
//                             with a repoRoot()-style error, not a crash or a
//                             silent wrong default
//                             (docs/bun-migration-stage2-assets.md).
//   3. unknown-subcommand   — full usage listing on stderr + exit 1.
//   4. enoent[…]            — subcommand paths that spawn an external command
//                             with a deliberately-missing dependency must
//                             report the missing executable cleanly (correct
//                             non-zero exit + clear error, no hang, no wrong
//                             code) — docs/bun-migration-stage2-spawn-audit.md.
//   5. Final summary table; exit non-zero if anything failed.
//
// Subcommand list source of truth: when the source tree is available (this
// script lives at kit/hydra-ts/scripts/), the routed subcommand NAMES are
// read live from src/cli.ts's `routes` object by text-parsing it (never by
// importing cli.ts) and checked for drift against the expectation table
// below — a mismatch is a hard FAIL, so the table cannot silently drift from
// the real routing table. When the source tree is absent the harness falls
// back to the embedded table and says so.
//
// EXPECTATION TABLE DERIVATION (keep in sync when cli.ts/modules change!):
// derived empirically at commit 90f146e0 (base of run 0040) by invoking each
// subcommand with no args under EXACTLY this harness's scrubbed env, and
// cross-checked byte-for-byte against the Node source lane
// (`node --experimental-strip-types src/cli.ts <name>`): 34/34 identical.
// The table records that reference behavior. To regenerate: run each routed
// subcommand with no args under the scrubbed env and update exit/signature.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HYDRA_TS_ROOT = dirname(SCRIPT_DIR);
const SRC_CLI = join(HYDRA_TS_ROOT, 'src', 'cli.ts');
const CHECKOUT_PROFILES_DIR = join(HYDRA_TS_ROOT, '..', 'hydra', 'profiles');

// ---------------------------------------------------------------------------
// Expectation table (see derivation note in the header comment).
// `exit`: expected process exit code with no arguments.
// `signature`: literal substring that MUST appear in the subcommand's own
// combined output and (because signatures are mutually distinctive) never in
// any other subcommand's output — that exclusivity is what makes the
// guard-cascade regression detectable.
// ---------------------------------------------------------------------------

interface Expectation {
  exit: number;
  signature: string;
  /** Extra literal strings that must all appear on stdout (rare; otel-env). */
  stdoutAll?: string[];
}

const EXPECTATIONS: Record<string, Expectation> = {
  'adapter-claude': { exit: 1, signature: 'usage: claude.sh start|resume <task_spec>' },
  'adapter-codex': { exit: 1, signature: 'usage: codex.sh start <task_spec>' },
  // requireKimi() gates before the usage error when the kimi CLI is absent
  // (scrubbed PATH): a dependency error, not a usage error — still exit 1.
  'adapter-kimi': { exit: 1, signature: 'kimi CLI not found (Wave 2 dependency)' },
  'adapter-opencode': { exit: 1, signature: 'usage: opencode.sh explore|review|start ...' },
  'adapter-stub': { exit: 1, signature: 'usage: stub.sh start|resume <task_spec>' },
  // No-arg success by design: writes an empty measured-profiles report under
  // HYDRA_STATE_ROOT and says so. NOT a usage-error subcommand.
  'aggregate-usage': { exit: 0, signature: 'measured profiles written for: none' },
  'allocate': { exit: 1, signature: 'usage: allocate <role> <task_type> [risk]' },
  'amend-task': { exit: 1, signature: 'usage: amend-task.sh <run_id>' },
  'audit-ownership': { exit: 1, signature: 'usage: audit-ownership.sh <worktree>' },
  'build-worker-prompt': { exit: 1, signature: 'usage: build-worker-prompt.sh <task_spec>' },
  'cancel-task': { exit: 1, signature: 'usage: cancel-task <run_id> <task_id>' },
  'code-intel': { exit: 1, signature: 'usage: code-intel changed [--base <ref>]' },
  'create-worktree': { exit: 1, signature: 'usage: create-worktree.ts <run_id> <task_id>' },
  'dispatch': { exit: 1, signature: 'usage: dispatch <run_id> <task_id> [--background]' },
  'freshness-gate': { exit: 1, signature: 'usage: freshness-gate.sh <run_id> <task_id>' },
  'graph-impact': { exit: 1, signature: 'usage: graph-impact.sh <run_id> <task_id>' },
  'graphify-baseline': { exit: 1, signature: 'usage: graphify-baseline.sh <run_id>' },
  'graphify-investigate': { exit: 1, signature: 'usage: graphify-investigate.sh <run_id> <task_id>' },
  // findExecutable('graphify') gates before verb parsing (scrubbed PATH).
  'graphify-repo': { exit: 1, signature: 'graphify CLI not found (Wave 2 dependency)' },
  'herdr-push': { exit: 1, signature: 'usage: herdrPush <run_id> [--notify]' },
  'index-candidate': { exit: 1, signature: 'usage: index-candidate.ts <run_id> <task_id>' },
  'integrate': { exit: 1, signature: 'usage: integrate.ts <run_id> <task_id_in_order>' },
  'ledger-view': { exit: 1, signature: 'usage: ledger-view.sh <run_id> [out.html]' },
  'measure-divergence': { exit: 1, signature: 'no runs found under ' },
  // No-arg success by design: prints the OTel export lines, exit 0.
  'otel-env': {
    exit: 0,
    signature: 'export OTEL_METRICS_EXPORTER=otlp',
    stdoutAll: [
      'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
      'export OTEL_METRICS_EXPORTER=otlp',
      'export OTEL_LOGS_EXPORTER=otlp',
      'export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
      'export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318',
      'export OTEL_RESOURCE_ATTRIBUTES=service.name=hydra-swarm',
    ],
  },
  // promote's usage error exits 2, not 1 — pre-existing ts-lane behavior,
  // documented in docs/bun-migration-stage2-bash-preamble.md.
  'promote': { exit: 2, signature: 'usage: promote(run_id, task_id, inbox_result.json)' },
  'record-review': { exit: 1, signature: 'usage: record-review.sh <run_id> <task_id> <verdict.json>' },
  'record-usage': { exit: 1, signature: 'usage: record-usage.sh <run_id> <task_id> <vendor>' },
  'review-dispatch': { exit: 1, signature: 'usage: reviewDispatch <run_id> <review_id> <vendor>' },
  'review-required': { exit: 1, signature: 'usage: review-required.sh <implementer_vendor> <risk>' },
  'run-init': { exit: 1, signature: 'usage: run-init.sh <run_id> [base_commit]' },
  'squash': { exit: 1, signature: 'usage: squash.sh <run_id> <task_id>' },
  'status': { exit: 1, signature: 'usage: status <run_id> <task_id> [--lines N] [--json]' },
  'verify': { exit: 1, signature: 'usage: verify.sh <worktree> <policy.yaml> [out.json]' },
};

const CRASH_MARKERS = [
  'Segmentation fault',
  'SIGSEGV',
  'SIGABRT',
  'Abort trap',
  'panic(',
  'UnhandledPromiseRejection',
  'unhandled promise rejection',
  'error: unknown',
];

// ---------------------------------------------------------------------------
// Small framework.
// ---------------------------------------------------------------------------

interface CheckResult { name: string; pass: boolean; detail: string }
const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}  — ${detail}\n`);
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  ms: number;
}

function run(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): RunResult {
  const started = Date.now();
  const res = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = res.error !== undefined
    && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const spawnError = res.error !== undefined && !timedOut ? String(res.error) : null;
  return {
    code: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
    spawnError,
    ms: Date.now() - started,
  };
}

/** Read the routed subcommand names live from src/cli.ts (text parse only). */
function readRoutesFromSource(): string[] | null {
  if (!existsSync(SRC_CLI)) return null;
  const text = readFileSync(SRC_CLI, 'utf8');
  const block = text.match(/export const routes[^=]*=\s*\{([\s\S]*?)\};/);
  if (block === null) return null;
  const names = [...block[1].matchAll(/'([a-z0-9-]+)':/g)].map((m) => m[1]);
  return names.length > 0 ? names.sort() : null;
}

/** cost_hint values from the checkout's seed profiles (for the embed check). */
function readCheckoutCostHints(): Record<string, string> | null {
  const files: Record<string, string> = {
    claude: 'claude-fable-5.yaml',
    codex: 'codex-gpt-5.6-sol.yaml',
    opencode: 'opencode-glm-5.2.yaml',
    kimi: 'kimi-k2.7-code.yaml',
  };
  const hints: Record<string, string> = {};
  try {
    for (const [vendor, file] of Object.entries(files)) {
      const text = readFileSync(join(CHECKOUT_PROFILES_DIR, file), 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('cost_hint:'));
      if (line === undefined) return null;
      let value = line.slice('cost_hint:'.length).replace(/\s+#.*$/, '').trim();
      value = value.replace(/^"|"$/g, '');
      if (value === '') return null;
      hints[vendor] = value;
    }
    return hints;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const keepScratch = argv.includes('--keep-scratch');
  const timeoutArg = argv.find((a) => a.startsWith('--timeout-ms='));
  const timeoutMs = timeoutArg === undefined ? 30_000 : Number(timeoutArg.slice('--timeout-ms='.length));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write('blackbox: error: --timeout-ms must be a positive number\n');
    return 2;
  }
  if (positional.length !== 1) {
    process.stderr.write('usage: blackbox-compiled.ts <path-to-binary> [--keep-scratch] [--timeout-ms=N]\n');
    return 2;
  }

  const binary = resolve(positional[0]);
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    process.stderr.write(`blackbox: error: binary not found: ${binary}\n`);
    return 2;
  }
  const binarySize = statSync(binary).size;
  const binarySha = createHash('sha256').update(readFileSync(binary)).digest('hex');
  process.stdout.write(
    `blackbox-compiled: binary=${binary}\n  size=${binarySize} sha256=${binarySha}\n  timeout=${timeoutMs}ms per invocation\n\n`,
  );

  // Drift guard: subcommand names must match src/cli.ts's routes object.
  const tableNames = Object.keys(EXPECTATIONS).sort();
  const sourceNames = readRoutesFromSource();
  let names = tableNames;
  if (sourceNames === null) {
    process.stdout.write(
      'note: src/cli.ts not reachable from this script; using the embedded expectation\n'
      + '      table as-is (drift between table and routing table cannot be detected).\n\n',
    );
  } else {
    const missing = sourceNames.filter((n) => !tableNames.includes(n));
    const extra = tableNames.filter((n) => !sourceNames.includes(n));
    if (missing.length > 0 || extra.length > 0) {
      record('routes-drift', false,
        `expectation table does not match src/cli.ts routes (missing from table: [${missing}], not routed: [${extra}]) — update EXPECTATIONS in scripts/blackbox-compiled.ts`);
    } else {
      record('routes-drift', true, `table matches all ${sourceNames.length} routes in src/cli.ts`);
      names = sourceNames;
    }
  }

  // Scratch world: everything the binary can write lives under here.
  const scratch = mkdtempSync(join(tmpdir(), 'hydra-blackbox-'));
  const dirs = ['home', 'state', 'xdg', 'worktrees', 'tmp', 'empty-path', 'cwd', 'cwd2', 'bin'];
  for (const d of dirs) mkdirSync(join(scratch, d), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: join(scratch, 'empty-path'), // deliberately empty: no node/bun/git/vendor CLIs
    HOME: join(scratch, 'home'),
    HYDRA_STATE_ROOT: join(scratch, 'state'),
    HYDRA_WORKTREE_ROOT: join(scratch, 'worktrees'),
    XDG_STATE_HOME: join(scratch, 'xdg'),
    TMPDIR: join(scratch, 'tmp'),
    TERM: 'dumb',
    NO_COLOR: '1',
    LANG: 'C',
  };
  const cwd = join(scratch, 'cwd');

  try {
    // ------------------------------------------------------------------
    // Check 1 — no-network smoke: every subcommand, no args, hostile env.
    // (No network is possible: no API keys in env, and usage/dependency
    // paths perform no network I/O by construction.)
    // ------------------------------------------------------------------
    for (const name of names) {
      const exp = EXPECTATIONS[name];
      if (exp === undefined) continue; // routes-drift already failed loudly
      const r = run(binary, [name], { cwd, env, timeoutMs });
      const combined = `${r.stdout}\n${r.stderr}`;
      const problems: string[] = [];
      if (r.timedOut) problems.push(`timed out after ${timeoutMs}ms (hang)`);
      if (r.spawnError !== null) problems.push(`spawn error: ${r.spawnError}`);
      if (r.signal !== null) problems.push(`killed by signal ${r.signal}`);
      if (r.code !== exp.exit) problems.push(`exit ${r.code} != expected ${exp.exit}`);
      if (!combined.includes(exp.signature)) problems.push(`missing own signature ${JSON.stringify(exp.signature)}`);
      for (const other of names) {
        if (other === name) continue;
        const otherSig = EXPECTATIONS[other]?.signature;
        if (otherSig !== undefined && combined.includes(otherSig)) {
          problems.push(`contains OTHER subcommand's signature (${other}: ${JSON.stringify(otherSig)}) — guard-cascade regression`);
        }
      }
      for (const marker of CRASH_MARKERS) {
        if (combined.includes(marker)) problems.push(`crash marker ${JSON.stringify(marker)} in output`);
      }
      for (const line of exp.stdoutAll ?? []) {
        if (!r.stdout.includes(line)) problems.push(`stdout missing ${JSON.stringify(line)}`);
      }
      record(
        `smoke[${name}]`,
        problems.length === 0,
        problems.length === 0
          ? `exit ${r.code}, signature ok, no cross-subcommand output (${r.ms}ms)`
          : `${problems.join('; ')} | output: ${JSON.stringify(combined.slice(0, 300))}`,
      );
    }

    // ------------------------------------------------------------------
    // Check 2 — CWD independence: relocated binary copy, empty cwd, no
    // checkout. Embedded assets must work; checkout-relative assets must
    // fail loudly (repoRoot-style), never crash or silently default.
    // ------------------------------------------------------------------
    const relocated = join(scratch, 'bin', 'hydra-cli');
    copyFileSync(binary, relocated);
    chmodSync(relocated, 0o755);
    const cwd2 = join(scratch, 'cwd2');
    const repoError = 'not inside a git repository';

    // 2a. EMBED: allocate reads the 4 embedded seed profiles.
    {
      const r = run(relocated, ['allocate', 'implementer', 'code_review', 'high'], { cwd: cwd2, env, timeoutMs });
      const hints = readCheckoutCostHints() ?? {
        // Fallback literals recorded at commit 90f146e0 (kit/hydra/profiles/).
        claude: 'subscription_or_api',
        codex: '5.0/30.0',
        kimi: '0.95/4.00 (0.19 cached)',
        opencode: 'free_tier_or_cheap',
      };
      const problems: string[] = [];
      if (r.code !== 0) problems.push(`exit ${r.code} != 0`);
      if (!r.stdout.includes('"recommendation": "')) problems.push('no recommendation in JSON output');
      for (const vendor of ['claude', 'codex', 'kimi']) {
        if (!r.stdout.includes(`"cost_hint": "${hints[vendor]}"`)) {
          problems.push(`stdout missing embedded seed cost_hint for ${vendor} (${JSON.stringify(hints[vendor])})`);
        }
      }
      record('cwd-independence[allocate-embeds-profiles]', problems.length === 0,
        problems.length === 0
          ? 'exit 0 with seeded ranking from EMBEDDED profiles, checkout absent'
          : `${problems.join('; ')} | output: ${JSON.stringify((r.stdout + r.stderr).slice(0, 300))}`);
    }

    // 2b. EMBED: record-review loads and ENFORCES the embedded review schema.
    {
      const validVerdict = join(cwd2, 'verdict-ok.json');
      const invalidVerdict = join(cwd2, 'verdict-invalid.json');
      writeFileSync(validVerdict, JSON.stringify({
        task_id: 't', verdict: 'accept', reviewed_base: 'b', reviewed_head: 'h',
        reviewer: 'codex', risk: 'low',
        blocking_findings: [], non_blocking_findings: [], required_integration_checks: [],
      }));
      writeFileSync(invalidVerdict, JSON.stringify({ task_id: 't' }));
      const okRun = run(relocated, ['record-review', '1', 't', validVerdict], { cwd: cwd2, env, timeoutMs });
      const okCombined = `${okRun.stdout}\n${okRun.stderr}`;
      const recorded = okRun.code === 0 && okCombined.includes('review recorded');
      record('cwd-independence[record-review-embeds-schema]', recorded,
        recorded
          ? 'valid verdict recorded via EMBEDDED review.schema.json, checkout absent'
          : `exit ${okRun.code} | output: ${JSON.stringify(okCombined.slice(0, 300))}`);
      const badRun = run(relocated, ['record-review', '1', 't', invalidVerdict], { cwd: cwd2, env, timeoutMs });
      const enforced = badRun.code === 5 && badRun.stderr.includes('review verdict rejected (schema)');
      record('cwd-independence[record-review-schema-enforced]', enforced,
        enforced
          ? 'invalid verdict rejected (exit 5) — embedded schema is enforced, not skipped'
          : `exit ${badRun.code} | output: ${JSON.stringify((badRun.stdout + badRun.stderr).slice(0, 300))}`);
    }

    // 2c–2f. CHECKOUT-RELATIVE: policy YAMLs / WAVE must fail loudly outside
    // a repo (repoRoot()-style error), not crash and not silently default.
    const loudCases: Array<{ name: string; args: string[]; exit: number }> = [
      { name: 'review-required', args: ['review-required', 'codex', 'high'], exit: 1 },
      { name: 'create-worktree', args: ['create-worktree', '1', 't'], exit: 1 },
      { name: 'integrate', args: ['integrate', '1', 't'], exit: 1 },
      { name: 'promote', args: ['promote', '1', 't', 'result.json'], exit: 2 },
    ];
    for (const c of loudCases) {
      const r = run(relocated, c.args, { cwd: cwd2, env, timeoutMs });
      const combined = `${r.stdout}\n${r.stderr}`;
      const problems: string[] = [];
      if (r.code !== c.exit) problems.push(`exit ${r.code} != expected ${c.exit}`);
      if (!combined.includes(repoError)) problems.push(`missing loud ${JSON.stringify(repoError)} error`);
      for (const marker of CRASH_MARKERS) {
        if (combined.includes(marker)) problems.push(`crash marker ${JSON.stringify(marker)}`);
      }
      if (r.timedOut || r.signal !== null) problems.push('hang/signal instead of clean failure');
      record(`cwd-independence[${c.name}-loud-outside-repo]`, problems.length === 0,
        problems.length === 0
          ? `exit ${c.exit} with clear repoRoot()-style error (checkout-relative asset)`
          : `${problems.join('; ')} | output: ${JSON.stringify(combined.slice(0, 300))}`);
    }

    // ------------------------------------------------------------------
    // Check 3 — unknown subcommand: full usage listing + exit 1.
    // ------------------------------------------------------------------
    {
      const r = run(binary, ['definitely-not-a-subcommand'], { cwd, env, timeoutMs });
      const problems: string[] = [];
      if (r.code !== 1) problems.push(`exit ${r.code} != 1`);
      if (r.stdout !== '') problems.push(`stdout not empty: ${JSON.stringify(r.stdout.slice(0, 120))}`);
      if (!r.stderr.startsWith('Usage: hydra <subcommand> [args...]')) problems.push('stderr does not start with the usage banner');
      for (const name of names) {
        if (!r.stderr.includes(`  ${name}\n`)) problems.push(`usage listing missing ${name}`);
      }
      record('unknown-subcommand', problems.length === 0,
        problems.length === 0
          ? `exit 1, empty stdout, usage banner + all ${names.length} names on stderr`
          : problems.join('; '));
    }

    // ------------------------------------------------------------------
    // Check 4 — ENOENT process semantics: a subcommand that spawns an
    // external command whose dependency is deliberately missing (scrubbed
    // PATH) must fail with the correct non-zero exit + clear error, never
    // a hang and never a wrong code.
    // ------------------------------------------------------------------
    const enoentCases: Array<{ name: string; args: string[]; message: string }> = [
      {
        name: 'adapter-kimi-start',
        args: ['adapter-kimi', 'start', 'spec.yml', 'wt', 'inbox', 'sessions', 'run1'],
        message: 'kimi CLI not found (Wave 2 dependency)',
      },
      {
        name: 'graphify-repo',
        args: ['graphify-repo'],
        message: 'graphify CLI not found (Wave 2 dependency)',
      },
    ];
    for (const c of enoentCases) {
      const r = run(binary, c.args, { cwd, env, timeoutMs });
      const combined = `${r.stdout}\n${r.stderr}`;
      const problems: string[] = [];
      if (r.timedOut) problems.push(`timed out after ${timeoutMs}ms (hang on missing executable)`);
      if (r.signal !== null) problems.push(`killed by signal ${r.signal}`);
      if (r.code !== 1) problems.push(`exit ${r.code} != 1 (wrong code for missing executable)`);
      if (!combined.includes(c.message)) problems.push(`missing clear error ${JSON.stringify(c.message)}`);
      record(`enoent[${c.name}]`, problems.length === 0,
        problems.length === 0
          ? `missing dependency reported cleanly: exit 1, ${JSON.stringify(c.message)}, no hang (${r.ms}ms)`
          : `${problems.join('; ')} | output: ${JSON.stringify(combined.slice(0, 300))}`);
    }
  } finally {
    if (keepScratch) {
      process.stdout.write(`\nscratch kept at ${scratch}\n`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------
  // Check 5 — summary table.
  // ------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  process.stdout.write('\n=== black-box summary ===\n');
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail.split('|')[0].trim()}\n`);
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) {
    process.stderr.write(`blackbox: error: ${failed.length} check(s) failed\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
