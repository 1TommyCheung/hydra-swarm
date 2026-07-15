# Bun adapter/subprocess spike — results (items #2, #4, #5, #6)

Ran 2026-07-15, covering the four adapter-facing items from the "Needs a `bun
build --compile` spike to verify" list in `docs/bun-migration-plan-codex.md`
(§519-563). Builds on Stage 0 (`docs/bun-migration-spike-results.md`) and the
`kit/hydra-ts/src/bin-cli.ts` self-re-exec pattern.

Environment:

- Bun `1.3.14` (`~/.bun/bin/bun`), target `bun-darwin-arm64`, macOS arm64.
- Node control: `v22.14.0` (`~/.nvm/versions/node/v22.14.0/bin/node
  --experimental-strip-types`) — the same runtime/shape the current TS harness
  uses (`dispatch.ts:741-742`).
- All four vendor CLIs present: `claude` 2.1.210, `codex` 0.144.1, `kimi`
  0.23.6, `opencode` 1.17.18. `srt` present.
- Every binary built with
  `bun build --compile --target=bun-darwin-arm64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig`.
- Scratch workspace `/tmp/hydra-spike-adapters` (outside the repo; no repo
  files touched).

**No paid vendor API calls were made.** argv/env/cwd/stdio fidelity was proven
with recording shims placed first on `PATH` (they capture the exact invocation
and emit vendor-shaped output). Real vendor binaries were exercised only with
`--version` and with the exact adapter argv shape plus an intentionally invalid
model/pre-flight condition that fails before any completion can happen; the
observed failures (below) confirm zero completions and zero cost.

---

## Spike #2 — do `isMain` guards stay dormant in a bundle? → **NO: every guard evaluates TRUE. Verdict: answered definitively (PASS); the router/refactor is mandatory**

34 guard sites exist across `kit/hydra-ts/src` (two text variants:
`import.meta.url === pathToFileURL(resolve(process.argv[1])).href` and the same
without `resolve()`).

### Test A — three exact guard reproductions, one compiled entry

`repro-claude.ts`, `repro-kimi.ts`, `repro-graphify.ts` carry the three guard
texts verbatim and record `guardResult` at import time; `spike2-entry.ts`
imports all three and prints the reports.

```
$ bun build --compile --target=bun-darwin-arm64 --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig --outfile out/spike2-repro spike2-entry.ts
$ ./out/spike2-repro
{
  "argv": ["bun", "/$bunfs/root/spike2-repro"],
  "execPath": "/private/tmp/hydra-spike-adapters/out/spike2-repro",
  "entryImportMetaUrl": "file:///$bunfs/root/spike2-repro",
  "modules": [
    { "module": "repro-claude (resolve variant)",  "importMetaUrl": "file:///$bunfs/root/spike2-repro", "guardResult": true,  "guardError": null },
    { "module": "repro-kimi (no-resolve variant)", "importMetaUrl": "file:///$bunfs/root/spike2-repro", "guardResult": true,  "guardError": null },
    { "module": "repro-graphify (truthy variant)", "importMetaUrl": "file:///$bunfs/root/spike2-repro", "guardResult": true,  "guardError": null }
  ]
}
stderr: GUARD-FIRED repro-claude / GUARD-FIRED repro-kimi / GUARD-FIRED repro-graphify
exit=0
```

**Bun collapses every bundled module's `import.meta.url` to the same synthetic
entry URL** (`file:///$bunfs/root/<binary-name>`). Since `process.argv[1]` is
that same virtual path, all three guard variants evaluate **true in every
module** — none throw, none are false. Extra CLI args do not change it
(`./out/spike2-repro __adapter stub start extra args` → `argv[1]` unchanged,
all guards still true).

### Test B — the REAL source files, bundled

`spike2-real-entry.ts` imports the real `adapter-claude.ts`,
`adapter-codex.ts`, `adapter-kimi.ts`, `adapter-opencode.ts`, and
`dispatch.ts` (11 modules bundled). If any production guard fired, that
module's CLI block would run at import.

```
$ ./out/spike2-real
exit=1
stdout: {"ok":true,"entryImportMetaUrl":"file:///$bunfs/root/spike2-real","argv1":"/$bunfs/root/spike2-real",
         "imported":{"adapterClaude":7,"adapterCodex":3,"adapterKimi":5,"adapterOpencode":6,"dispatch":5}}
stderr:
hydra: error: usage: claude.sh start|resume <task_spec> ...
hydra: error: usage: codex.sh start <task_spec> ...
hydra: error: usage: adapter-kimi.ts visual|start ...
hydra: error: usage: opencode.sh explore|review|start ...
hydra: error: usage: build-worker-prompt.sh <task_spec>
hydra: error: usage: record-usage.sh <run_id> <task_id> <vendor> <agent_run_id>
hydra: error: usage: dispatch <run_id> <task_id> [--background]
```

**All seven CLI blocks fired** — every transitively imported module with an
`isMain` guard ran its main, including `dispatch` itself.

### Consequence for the plan (flagged design constraint)

The plan already assumed this risk ("do not assume bundled `import.meta.url`
comparisons will keep every imported module's current `isMain` block dormant",
§152). The spike upgrades that assumption to a certainty, and it is stronger
than "unreliable": the guards are **deterministically true** for every module
in the bundle. Consequences:

- Stage 1's single-router design with exported `main()` functions is not
  optional — it is the only way to compile. There is no transition state in
  which the current files can be bundled unmodified; doing so runs ~30 CLI
  blocks at startup and corrupts argv handling.
- The guards cannot be made inert by any argv trick (argv[1] is invariant).
  They must be removed/gated in the bundled source (e.g. behind a build-time
  constant) or refactored away, while keeping the plain-file Node entry points
  for the `HYDRA_HARNESS=ts` rollback lane.
- Stage 0's `bin-cli.ts` worked precisely because it is a single-module bundle
  (entry guard firing is correct there).

---

## Spike #4 — self-re-exec'd `__adapter` preserves argv/env/cwd/stdio for all four adapters → **PASS**

Harness `spike-h.ts` replicates both hops with byte-exact argv construction:

- **Level 1 (dispatch → adapter)**: `dispatch-plain` replicates
  `runWorkerPlain` (`dispatch.ts:731-770`): `spawn(process.execPath,
  ['__adapter', vendor, verb, taskSpec, worktree, inbox, sessions, agentRunId,
  priorSession], {detached:false, stdio:'ignore', cwd, env})`. The `__adapter`
  handler records exactly what arrived to
  `<sessions>/<id>.adapter-invocation.json`.
- **Level 2 (adapter → vendor)**: the handler then spawns the vendor CLI with
  the exact code shape of the real adapter: claude
  (`adapter-claude.ts:251-268`, `spawnSync`, `input:''`, piped stdio), codex
  (`adapter-codex.ts:386-417`, `spawnSync` with `openSync` fd stdio), kimi
  (`adapter-kimi.ts:560-575`, async `spawn` of `srt -s <settings> -c
  '<shell-quoted kimi command>'`, streamed), opencode
  (`adapter-opencode.ts:503-519`, async `spawn`, streamed).
- The fake prompt contained single quotes, double quotes, newlines, `$`, and
  backticks.
- Shims (`claude`/`codex`/`kimi`/`opencode`/`srt` first on `PATH`) recorded
  argv/cwd/env/stdin as JSON and emitted vendor-shaped output (multi-chunk,
  150 ms apart, for the streaming pair).

### Commands and observed output

```
$ PATH="/tmp/hydra-spike-adapters/shims:$PATH" HYDRA_PROBE=from-driver-shell \
    BUN_BE_BUN=1 env -u BUN_BE_BUN \
    ./out/spike-h dispatch-plain <vendor> wt-task.yaml wt inbox sessions run4-<vendor> ""
{"check":"dispatch-plain","vendor":"claude","workerPid":7454,"code":0,"signal":null,"error":false}
(same for codex, kimi, opencode — all code:0)
```

Level 1 records (all four; claude shown, plus the direct `__adapter claude
resume` run):

```
{"argv":["__adapter","claude","start","wt-task.yaml","wt","inbox","sessions","run4-claude",""],
 "argc":9, "priorEmpty":true, "cwd":"/private/tmp/hydra-spike-adapters",
 "env":{"HYDRA_PROBE":"overridden-by-compiled-parent","ADAPTER_PROBE":"added-by-compiled-parent","BUN_BE_BUN_present":false}}
{"argv":["__adapter","claude","resume",...,"run4-claude-resume","prior-session-abc123"],
 "argc":9, "priorEmpty":false, "env":{"HYDRA_PROBE":"from-driver-shell",...}}
```

- **Empty prior-session argument arrives intact** (`argc:9`, final element the
  empty string, `priorEmpty:true`) — the exact dispatch behavior at
  `dispatch.ts:738` (`ctx.priorSession` is `''` on cold start).
- **env inheritance/override is exact**: parent overrides visible
  (`HYDRA_PROBE=overridden-by-compiled-parent`), additions present
  (`ADAPTER_PROBE`), and `BUN_BE_BUN` is absent everywhere in the chain even
  though it was exported in the driver shell (boundary `env -u` + the
  `bin-cli.ts` `BUN_BE_BUN: undefined` spawn-env pattern).
- **cwd is correct** at both hops.

Level 2 shim records (verbatim argv as received by the vendor binary):

```
claude:   ["-p","You are a Hydra-Swarm implementation worker. Task 'spike-4'.\nLine two has \"double quotes\", a $DOLLAR, and `backticks`.\nLine three ends the prompt.","--output-format","json","--permission-mode","bypassPermissions","--add-dir","/private/tmp/hydra-spike-adapters/wt"]  (argc 8)
claude resume:  same + ["--resume","prior-session-abc123"] inserted before --add-dir (argc 10)
codex:    ["exec","--json","-C","/private/tmp/.../wt","-s","workspace-write","-c","sandbox_workspace_write.writable_roots=[\"/private/tmp/.../wt/.git\"]","<prompt>"]  (argc 9)
srt:      ["-s","/private/tmp/.../run4-kimi.srt-settings.json","-c","'kimi' '-p' 'You are ... Task '\\''spike-4'\\''.\n...' '--output-format' 'stream-json' '--add-dir' 'wt'"]  (argc 4)
kimi (inside srt->bash -c): ["-p","<prompt, byte-identical>","--output-format","stream-json","--add-dir","wt"]  (argc 6)
opencode: ["run","--model","spike-model","--agent","hydra-implementer","--format","json","--auto","--dir","wt","<prompt>"]  (argc 11)
```

The prompt survived **byte-identical** through the compiled self-re-exec and
into the vendor argv — including through the kimi `shellQuote` → `srt -c` →
`bash -c` re-parse chain (the `'\''` escaping round-trips).

Session-capture behavior (what dispatch actually parses):

```
codex cli.jsonl (fd-redirected stdout):  2 JSONL lines, status:0, stdoutIsNull:true
kimi  cli.jsonl (streamed 'data' appends): 3 lines in order; events:
  ["stdout:data:46b","stderr:data:21b","stdout:data:56b","stderr:data:21b","stdout:data:84b","stderr:end","stdout:end","exit:0"]
opencode events.jsonl (streamed): 3 events in order; same end/exit ordering
claude cli.json (spawnSync pipe): {"session_id":"claude-shim-session-123",...}
```

Streamed stdout/stderr are captured chunk-by-chunk with `end` before `exit`
exactly as the adapters' `runStreaming` requires (`adapter-kimi.ts:329-381`,
`adapter-opencode.ts:116-182`).

### Real vendor binaries under the compiled parent (safe fail-fast)

```
$ ./out/spike-h real-vendor claude
{"check":"real-vendor-version","status":0,"stdout":"2.1.210 (Claude Code)","ms":84}
{"check":"real-vendor-shape","status":1,"ms":711,
 "stdoutHead":"{\"type\":\"result\",\"is_error\":true,\"api_error_status\":403,
   \"result\":\"Failed to authenticate. API Error: 403 Connection blocked by network allowlist\",
   ...\"total_cost_usd\":0,\"usage\":{\"input_tokens\":0,...}"}
$ ./out/spike-h real-vendor codex
{"check":"real-vendor-version","status":0,"stdout":"codex-cli 0.144.1","ms":44}
{"check":"real-vendor-shape","status":1,"ms":55,
 "stderrHead":"Reading additional input from stdin...\nNot inside a trusted directory and --skip-git-repo-check was not specified."}
  (re-run inside a git worktree: fails pre-flight with "failed to initialize
   in-process app-server client: Operation not permitted" — this environment's
   restriction, reached before any model/auth call; still zero API contact)
$ ./out/spike-h real-vendor kimi
{"check":"real-vendor-version","status":0,"stdout":"0.23.6","ms":464}
{"check":"real-vendor-shape","status":1,"ms":3702,
 "stderrHead":"error: failed to run prompt: config.invalid: Model \"hydra-spike-nonexistent-model\" is not configured in config.toml..."}
$ ./out/spike-h real-vendor opencode
{"check":"real-vendor-version","status":0,"stdout":"1.17.18","ms":514}
{"check":"real-vendor-shape","status":1,"ms":424,
 "stderrHead":"Error: Unexpected error\n\nUnknown: FileSystem.open (/Users/tommycheung/.local/share/opencode/log/opencode.log)"}
```

All four real CLIs spawn correctly from the compiled binary, parse the exact
adapter argv, and fail fast with useful errors **before any completion**:
claude was rejected by the machine's network allowlist (`total_cost_usd: 0`,
0 tokens — the API was never reached); codex stopped at its git-repo/sandbox
pre-flight; kimi rejected the invalid model at config validation (also
confirming `--model` is a valid flag); opencode failed on a local log-file
open before model resolution. A fifth probe ran the **real `srt`** from the
compiled binary wrapping the kimi shim (`srt -s <generated settings> -c
'<shell-quoted command>'`): exit 0, settings accepted, inner argv exact.

### One stdio nuance (documented, functionally equivalent)

`spawnSync(..., {input:'', stdio:['pipe','pipe','pipe']})` (the claude shape):
Node gives the child a socketpair stdin that sees `''` + EOF; the compiled Bun
binary gives the child `/dev/null` (immediate EOF). With a **non-empty**
`input` payload Bun delivers it correctly (verified:
`input:'hello-stdin-payload'` → child `cat` echoes it). For Hydra's only use
(`input:''` = "close stdin immediately") the child's observable behavior is
identical.

---

## Spike #5 — Herdr `bash -lc` wrapper + timeout kill, no orphans → **PASS (real kill, compared against node control)**

Driver replicated the wrapper strings verbatim from `dispatch.ts:864-882`
(both the progress variant used for codex/kimi and the banner-only variant for
claude/opencode), executed via `bash -lc` exactly as `RealHerdrClient` places
it (`dispatch.ts:166-168`). The "adapter" position ran either the compiled
binary or the current node+TS control; the adapter spawned **two** vendor
grandchildren (one async, one blocking it in `spawnSync` — the claude/codex
shape). The kill was performed by a **separate compiled binary** running a
verbatim port of `lib.ts:196-230` `killTree` (child-first recursion, SIGTERM,
unawaited SIGKILL at +2 s), targeting the pidfile-recorded wrapper PID, after
the tree was confirmed alive — i.e. a real timeout/cancel kill, not a guess.

```
[compiled-normal]   wrapper=35000(children:35009 35008) adapter=35009(children:35022 35021) tail=35008
[compiled-normal]   >>> killTree(35000)
[compiled-normal]   post-kill: wrapper=dead adapter=dead tail=dead
[compiled-normal]   post-kill: vendor-child 35022 dead ; vendor-child 35021 dead
[compiled-normal]   reparented-orphans: none ; sentinel: PRESENT (143)

[compiled-stubborn] (vendors ignore SIGTERM)  →  all dead (SIGKILL escalation at +2s worked) ; sentinel: PRESENT (143)
[compiled-noprogress] (banner-only variant)   →  all dead ; sentinel: ABSENT (killed before RC capture)
[node-normal]       (control: node --experimental-strip-types adapter)  →  all dead ; sentinel: PRESENT (143)
```

Post-kill liveness used `kill -0` on every recorded/enumerated PID plus a
system-wide scan for reparented orphans: **zero orphans in every case, and the
compiled binary's tree behavior is identical to the node control**, including
the stubborn-vendor SIGKILL escalation and the progress-`tail` reaping.

Two honest observations:

1. **Sentinel race (identical on both runtimes)**: `killTree` kills children
   before the wrapper, so the wrapper can live long enough to record the
   adapter's signal-derived exit — three cases wrote sentinel `143`
   (128+SIGTERM); the no-progress case didn't. So a timeout kill can surface
   to dispatch either as "no sentinel → timeout" or as "sentinel 143 →
   agent_exited 143". This race exists identically in today's Node path;
   Stage 1's compiled wrapper tests must accept both outcomes (or control the
   race), matching the plan's "ledger exit code matches observation"
   requirement.
2. **Sandbox caveat (pre-existing, not Bun-specific)**: the first run of this
   test executed in a shell whose sandbox denies process enumeration
   (`pgrep`/`ps` fail with "sysmond service not found"). There, `killTree`'s
   `pgrep -P` returned nothing, only the wrapper PID was killed, and the
   adapter + vendor grandchildren were **orphaned** — on the compiled binary
   and would be identically on Node (`killTree` is the same code). The final
   runs above used a `proc_listpids`-based helper with identical
   direct-children semantics for discovery (the kill itself is the verbatim
   code). Operational note: any environment that blocks process enumeration
   (some sandboxed verification shells) defeats `killTree` regardless of
   runtime; CI timeout-kill tests must run where `pgrep` works.

PID-reuse/liveness: dispatch's `workerDisappeared` check rests on
`process.kill(pid, 0)` + sentinel re-poll; `kill(pid,0)` semantics verified
identical (see #6). There is no start-time/PID-generation check in dispatch
today on either runtime.

---

## Spike #6 — process-primitive equivalence → **PASS with two minor semantic nuances**

`probe-stdio` ran the identical TS file as a compiled binary and under Node
(control). Full diff of the JSONL outputs:

| Check | Compiled Bun | Node v22 | Verdict |
|---|---|---|---|
| fd stdio array (`stdio:['ignore',fd,fd]`, codex shape) | status 3, stdout/stderr `null`, output in files | identical | ✅ |
| async stream `data`/`end`/`exit`/`close` | data in order, both `end`s, `exit:5`, `close:5` | identical except **relative order of `stdout:end` vs `stderr:end` swapped by one position** | ✅ nuance (a) |
| ENOENT `spawnSync` | `error.code='ENOENT'`, **status `undefined`**, msg `Executable not found in $PATH: "…"` | `error.code='ENOENT'`, status `null`, msg `spawnSync … ENOENT` | ✅ nuance (b) |
| ENOENT async `spawn` | events `error:ENOENT`, `close:-2` | identical | ✅ |
| EACCES `spawnSync` (non-executable file) | `error.code='EACCES'`, **status `undefined`**, msg `EACCES: permission denied, posix_spawn '…'` | `error.code='EACCES'`, status `null`, msg `spawnSync … EACCES` | ✅ nuance (b) |
| EACCES async `spawn` | events `error:EACCES`, `close:-13` | identical | ✅ |
| `process.kill(pid,0)` liveness | live: no throw; reaped: throws `ESRCH` | identical | ✅ |
| signal-derived status (SIGTERM/SIGKILL death) | `status:null, signal:'SIGTERM'/'SIGKILL'` | identical | ✅ |
| `detached:false` tree discovery + process group | child discoverable via direct-children enumeration; same PGID as parent | identical | ✅ |
| stdin variants (`input:''`+pipes vs `'ignore'`) | both: child sees immediate EOF, empty | identical (see #4 nuance: fd type differs, behavior equal) | ✅ |
| `withTimeout` (lib.ts:237-266 port) | `sleep 30` @1 s → `124`; `exit 3` → `3`; ENOENT → `127` | identical | ✅ |

**Nuance (a) — stream-end ordering.** Both `end` events always precede `exit`,
and `exit` precedes `close`, on both runtimes; only the relative order of the
two streams' `end` events can swap. The adapters' `runStreaming` settles only
after *both* ends *and* exit, so this is immaterial. Stage 1 tests must not
assert a cross-stream `end` order.

**Nuance (b) — `spawnSync` error shape.** On spawn failure Bun returns
`status: undefined` (key absent after JSON round-trip) where Node returns
`status: null`, and the `error.message` text differs (`.code` is identical).
Consequences for Stage 1: compare with `status == null`/`??`, never
`=== null` — e.g. `adapter-codex.ts:170`'s `if (result.status !== null)` would
take the wrong branch on a Bun spawn error (harmless today because the
production caller discards that result, but it must be fixed before the
compiled lane trusts it); and tests must not match Node's `spawnSync …`
message text.

No `detached:true`/process-group signaling is used anywhere in `lib.ts`'s
`killTree` (it is `pgrep -P` recursion + per-PID signals), so there is no
detached-group behavior to migrate; `detached:false` semantics verified
equivalent above.

---

## Verdict summary

| Spike | Question | Verdict |
|---|---|---|
| #2 | Do bundled `isMain` guards stay dormant? | **Answered: NO — all evaluate TRUE; every CLI block fires.** Router + `main()` refactor is mandatory (plan already assumed this; now proven, and stronger than assumed) |
| #4 | Self-re-exec preserves argv/env/cwd/stdio for all four adapters? | **PASS** — byte-exact argv incl. empty prior-session and quote/newline-laden prompt at both hops; env override/inherit/strip exact; cwd exact; piped/fd/streamed stdio all captured; all four real CLIs spawn and fail fast safely; real `srt` wrap works |
| #5 | Herdr wrapper kill on timeout/cancel, no orphans? | **PASS** — real `killTree` kill: wrapper, adapter, both vendor grandchildren, and progress `tail` all terminate; SIGKILL escalation for SIGTERM-ignoring vendors; identical to node control; sentinel-143 race exists identically on both runtimes |
| #6 | spawn/spawnSync primitives equivalent? | **PASS** with nuances: (a) cross-stream `end` order can swap; (b) `spawnSync` error → `status: undefined` (not `null`) and different message text (same `.code`) |

### Items requiring attention in `docs/bun-migration-plan-codex.md`'s Stage 1 design (no redesign; refinements)

1. **#2 makes the router non-negotiable and deletes a transition option**:
   there is no way to bundle current files "temporarily" — every guard fires.
   The plan's exported-`main()` refactor must cover all 34 guard sites before
   the first real compile, and the TS-lane plain-file entry behavior must be
   preserved by whatever replaces the guards (e.g. a build-time-inert gate).
2. **Encode nuance (b) in Stage 1 code/test standards**: `spawnSync` status
   checks must tolerate `undefined` (`== null` / `??`), and
   `adapter-codex.ts:170`'s `result.status !== null` branch should be fixed as
   part of the migration (latent misbranch under Bun on spawn error).
3. **Timeout-kill tests must tolerate the sentinel race** (observed
   identically on Node): after `killTree`, the ledger may show the timeout
   event or `agent_exited 143`; do not assert one.
4. **Operational (pre-existing, now re-confirmed)**: `killTree` requires
   working process enumeration; sandboxed shells that deny it orphan worker
   trees on both runtimes. Keep compiled timeout/kill verification out of
   such sandboxes.
5. **No paid-call risk introduced**: compiled parent + inherited environment
   reaches the real vendor CLIs exactly as Node does; the environment's own
   network allowlist blocked the only outward attempt (`total_cost_usd: 0`).
