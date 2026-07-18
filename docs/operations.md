# Hydra-Swarm — Operations Runbook

**Status:** Wave 2. This is the day-to-day guide to *operating* a run (Waves 0–2
documented *building*). It assumes the lead protocol in
`skills/hydra-swarm/SKILL.md`.

> Golden rule: you drive `kit/hydra/scripts/*.sh`; you never hand-edit
> `~/.local/state/<repo-id>-hydra/authoritative/**`. Read promoted results, never
> raw inbox drops. Merge/push/deploy is human-authorized.

## The loop, in commands

```bash
export HYDRA_WAVE=2                       # gates conditional bootstrap (gitnexus analyze)
bash kit/hydra/scripts/run-init.sh 0042       # -> run_started; creates the state tree
# write runs/run-0042/tasks/<task>.yaml per lane (template: kit/hydra/templates/task.example.yaml)
bash kit/hydra/scripts/create-worktree.sh 0042 <task>          # worktree + branch + bootstrap + PORT
bash kit/hydra/scripts/dispatch.sh 0042 <task>                 # runs the assigned vendor worker
bash kit/hydra/scripts/status.sh 0042 <task>                   # one-shot read-only task status
bash kit/hydra/scripts/cancel-task.sh 0042 <task>              # clean cancellation of a running task
bash kit/hydra/scripts/promote.sh 0042 <task> \
     ~/.local/state/<repo>-hydra/runs/run-0042/inbox/0042-<task>-v1/result.json   # THE trust boundary
bash kit/hydra/scripts/review-dispatch.sh 0042 <rev> <vendor> <prompt-file>   # cross-vendor review (read-only)
bash kit/hydra/scripts/record-review.sh 0042 <task> <verdict.json>            # record accept/revise/reject
bash kit/hydra/scripts/squash.sh 0042 <task>                   # accepted candidates only
bash kit/hydra/scripts/integrate.sh 0042 <task-in-dep-order>...# cherry-pick + smoke + combined gate
```

Only `accept` candidates enter `squash`/`integrate`. `revise`/`reject` return to
the same worktree (amend the spec + re-dispatch).

## Harness runtime selection

The command surface did not change during the TypeScript cutover or the later
Bash retirement: continue to invoke `bash kit/hydra/scripts/<name>.sh ...`.
Every operational entry point is a small launcher. By default (unset
`HYDRA_HARNESS`) it prefers a pinned compiled binary (`bin`), falling back
SILENTLY to the TypeScript implementation in `kit/hydra-ts/src/` (`ts`) only
when no binary is resolvable yet (no `HYDRA_BIN`, no `npm run build:bin`
output) — a fresh checkout with nothing pre-built still works out of the box.

```bash
bash kit/hydra/scripts/run-init.sh 0042                 # bin if resolvable, else ts (default)
HYDRA_HARNESS=ts bash kit/hydra/scripts/run-init.sh 0042   # force the TypeScript/Node lane
HYDRA_HARNESS=bin HYDRA_BIN=<pinned-binary> bash kit/hydra/scripts/run-init.sh 0042   # force bin, hard error if unusable
```

`HYDRA_HARNESS` accepts `ts` and `bin` (default: prefer `bin`, silent fallback
to `ts` only for the *implicit* unset case). `HYDRA_HARNESS=bash` is
**retired** (run 0045, `docs/bash-lane-retirement-plan.md`): it now fails loudly
with an explicit retirement error and does **not** silently coerce to `ts`.
The same applies to the adapter-layer override `HYDRA_ADAPTER_RUNTIME=bash`
(rejected by `dispatch.ts`'s `resolveAdapterRuntime`), which also rejects any
other unrecognized non-empty value. The Bash shell adapters under
`kit/hydra/adapters/` were deleted; vendor dispatch is the TypeScript
`adapter-<vendor>.ts` or the compiled `adapter-<vendor>` route only.

**No-Node rollback / explicit `bin`.** `HYDRA_HARNESS=bin` execs a prebuilt
`bun build --compile` single binary selected by `HYDRA_BIN` (it must be
absolute, regular, and executable). Unlike the implicit default, an
EXPLICITLY requested `bin` never falls back to `ts` — an unusable `HYDRA_BIN`
is a hard error, so a broken rollback path is never masked. A retained
checksummed known-good artifact is installed as the recovery path:

```bash
# Current pinned rollback artifact (see the manifest alongside it for the SHA):
HYDRA_BIN=~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64

# Recover any command with no Node.js on PATH:
HYDRA_HARNESS=bin \
  HYDRA_BIN=~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64 \
  bash kit/hydra/scripts/dispatch.sh 0042 my-task
```

The wrapper strips `BUN_BE_BUN` at the exec boundary so a leaked
`BUN_BE_BUN=1` cannot hijack the binary, in both the implicit-default and
explicit-`bin` paths. Rebuild from source with
`cd kit/hydra-ts && npm run build:bin` (requires `bun`) — that output
(`kit/hydra-ts/dist/hydra-cli`) is also the implicit default's fallback
lookup location when `HYDRA_BIN` is unset.

A lower-level `HYDRA_ADAPTER_RUNTIME` override (`ts` or `compiled`) takes
precedence inside TypeScript dispatch for the adapter only; leave it unset for
normal operation.

## Environment variables (the operational surface)

| Var | Purpose |
|---|---|
| `HYDRA_HARNESS` | Harness runtime. Unset: prefer `bin`, silently fall back to `ts` if no binary is resolvable. `ts`: force the Node lane. `bin`: force the pinned compiled-binary rollback (`HYDRA_BIN`), hard error if unusable. `bash` is **retired** and fails loudly. |
| `HYDRA_BIN` | Absolute, regular, executable compiled binary for the `bin` lane (implicit or explicit); defaults to `kit/hydra-ts/dist/hydra-cli`. Pinned rollback artifact: `~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64`. |
| `HYDRA_ADAPTER_RUNTIME` | Advanced adapter-only override for TypeScript dispatch: `ts` or `compiled`. `bash` is **retired** (rejected); any other unrecognized value is also rejected. Normally leave unset. |
| `HYDRA_WAVE` | Wave level; ≥1 activates the `wave_1` bootstrap (gitnexus analyze). Or set `kit/hydra/WAVE`. |
| `HYDRA_STATE_ROOT` | Override the external state root entirely (takes precedence over `XDG_STATE_HOME` and the default). |
| `XDG_STATE_HOME` | Base dir for state; when set and `HYDRA_STATE_ROOT` is unset, the state root resolves to `${XDG_STATE_HOME}/<repo-id>-hydra` (default `~/.local/state/<repo-id>-hydra`). |
| `HYDRA_WORKTREE_ROOT`, `HYDRA_REPO_ID` | Override worktree parent / repo id. |
| `HYDRA_VERIFY_POLICY` | Path to the verification policy `promote.sh`/`integrate.sh` re-run (combined gate). |
| `HYDRA_SMOKE_POLICY` | Per-candidate smoke policy for `integrate.sh` (task-specific; no cross-component tests). |
| `HYDRA_DELIVERY` | `start` (default) or `resume` — resume uses the captured session id where the adapter supports it. |
| `HYDRA_MAX_CONCURRENCY` | Dispatch slot cap (default `min(16, cores-2)`). The slot is acquired unconditionally before a dispatch proceeds, so both foreground (blocking) and backgrounded dispatches queue behind it and can emit `concurrency_wait`. |
| `HYDRA_HARD_CAP_MIN` | Absolute hard-cap minutes for both plain and pane-hosted dispatch (overrides the default `timeout_minutes * 6`). Status reports this value as `hard_cap_minutes`. |
| `HYDRA_GITNEXUS_REPO` | Override the code-intelligence repository id passed to `gitnexus` (default is the derived repo id; see `kit/hydra/scripts/code-intel.sh`). |
| `HYDRA_HERDR_PANE` | Fallback lead pane id for `herdr-push.sh` when no live pane matches the repo root (see `kit/hydra/scripts/herdr-push.sh`). |
| `HYDRA_LOOP_DETECTOR` | Loop-thinking detector. Enabled by default (`1` or unset); set to `0` to disable for a task/session where false positives are expected (e.g., legitimately long silent reasoning phases). |
| `HYDRA_HERDR_PANES` | Host each worker/reviewer in a herdr pane (Layer-1 live monitor). Enabled by default (`1` or unset) when herdr is live; set to `0` to force headless subprocess hosting. |
| `HYDRA_HERDR_KEEP_PANE=1` | Don't auto-close panes on completion (for inspection). |
| `HYDRA_REVIEW_TIMEOUT_MIN` | Harness timeout for a pane-hosted review (default 15). |
| `HYDRA_OPENCODE_MODEL` | e.g. `zai-coding-plan/glm-5.2` (the working id; NOT `zhipu/…`). |
| `MOONSHOT_API_KEY` / `ANTHROPIC_API_KEY` | Graphify semantic pass (`graphify-baseline.sh`). |
| `GRAPHIFY_KIMI_BASE_URL`, `GRAPHIFY_KIMI_MODEL`, `GRAPHIFY_KIMI_USER_AGENT` | Point Graphify's kimi backend at the coding endpoint (`https://api.kimi.com/coding/v1`, `kimi-for-coding`, `kimi-code-cli/0.23.6`). |

**Always dispatch detached** for anything slow, so an interactive tool/tmux
timeout can't SIGTERM the dispatch mid-run:

```bash
nohup bash kit/hydra/scripts/dispatch.sh 0042 <task> >/tmp/d.log 2>&1 </dev/null & disown
```

(If a dispatch *is* killed, it's safe: the trap records `agent_cancelled`, reaps
the worker tree, and closes the pane — no dangling `running` task.)

## TypeScript runtime and tests

The TypeScript harness requires Node.js 22.6 or newer. Entry points call
`hydra_resolve_node()` before starting TypeScript: it accepts a qualifying
`node` on `PATH`, otherwise checks nvm-managed installs and common Homebrew
locations, and fails with an actionable message when none qualifies.

The resolver matters on machines where a stale `/usr/local/bin/node` shadows
nvm's newer Node in login-shell or non-interactive contexts. That exact layout
made the first shell-to-TypeScript hop fail with Node 17 even though an
interactive shell selected Node 22. Do not diagnose this from an interactive
`node --version` alone; reproduce it in the same shell context as the failing
command. `hydra_resolve_node()` protects Hydra's shell entry points, but npm's
own scripts still require the invoking shell to resolve Node 22.6+.

From `kit/hydra-ts/`, the standard suite is deliberately split:

```bash
npm test                 # test:concurrent, then test:promote
npm run test:concurrent  # all test files except promote.test.ts
npm run test:promote     # promote.test.ts alone
```

Keep `promote.test.ts` isolated. Its subprocess-heavy cases exhibited a
load-dependent concurrency flake in which the concurrent run could silently
omit the file; isolating it preserves concurrency for the rest of the suite
while making the promotion gate's 26 tests explicit.

## Monitoring with herdr (Layer-1)

herdr is the terminal *host*, never the orchestrator (the harness still owns
worktrees, timeout, cancellation, the ledger). Pane text is never read as truth.

```bash
herdr status                    # server up? socket path
herdr agent list                # live agents + status, attributed to this lead
herdr pane list                 # panes; hydra workers labelled hydra:<run>:<task>:<vendor>
bash kit/hydra/scripts/herdr-push.sh 0042 --notify   # push ledger-derived state + reconcile
```

`herdr-push.sh` also **reconciles** the live view against the ledger and emits an
`observability_anomaly` event on disagreement (the ledger wins). That check
caught a real dangling-task bug the first time it ran.

Note: `codex exec` / `kimi -p` emit no session-lifecycle events, so the harness
pushes pane state itself (`hydra_herdr_state`). opencode still draws a formatted
display to a tty; for fully TUI-free runs use `opencode serve` + `--attach`.

## Authoritative view (Layer-2)

```bash
bash kit/hydra/scripts/ledger-view.sh 0042   # self-contained HTML from the ledger alone
```

## Recovery drill (lead-kill)

Standing test, run it any time:

```bash
bash kit/hydra/tests/recovery-drill.sh       # builds a mid-run state, reconstructs from ledger+Git only
```

Live procedure if a lead session dies: **do not rely on memory.** Read
`run.yaml` + `authoritative/ledger/events.jsonl` + Git to reconstruct which tasks
are planned/running/promoted/accepted/integrated, then resume from the last
recorded checkpoint. A promoted head is a real Git commit — verify with
`git cat-file -t <head>`.

## Capability profiles + allocation

```bash
bash kit/hydra/scripts/aggregate-usage.sh                    # writes agents/profiles/<vendor>.measured.json
bash kit/hydra/scripts/allocate.sh implementer feature high  # recommendation (never an auto-pin)
```

Allocation ranks on `measured` at n≥8, else seeded priors (`kit/hydra/profiles/`).
It's recommend-only — a human pins the role.

## Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| TypeScript entry point reports `bad option: --experimental-strip-types`, or `npm test` exits 9 | A stale Node (observed: `/usr/local/bin/node` v17.4.0) shadows nvm's Node in a login/non-interactive shell | Current entry points use `hydra_resolve_node()`; update to current code. For npm, invoke it from an environment where `node --version` is ≥22.6, or use the no-Node rollback: `HYDRA_HARNESS=bin HYDRA_BIN=~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64`. |
| Worker "completed" but no new commit; head == a prior commit | **Empty objective** (block-scalar not read) — historical, now fixed | `build-worker-prompt` uses `hydra_yaml_block`. If you see it again, dump the prompt: `node --experimental-strip-types kit/hydra-ts/src/build-worker-prompt.ts <spec>` |
| **Multiple vendors fail identically** | Suspect the harness, not the vendors | Dump the actual worker prompt first; check the drop and stderr under `sessions/` |
| opencode/GLM: `Unexpected server error` immediately | Transient Z.AI coding-endpoint 500 | Retry; if persistent, `allocate.sh` route around; GLM read-only reviews usually still work |
| opencode worker hangs on a permission prompt | Missing `--auto` | The adapter passes `--auto`; for manual runs use `opencode run --format json --auto` |
| Kimi: `fatal: could not open '/dev/null'` | `sandbox-exec` denied `/dev/null` | `kimi.sh` allows `/dev/null` + the herdr socket dir; out-of-lane writes still denied |
| Kimi: `Cannot combine --prompt with --yolo` | `-y` is redundant (print mode auto-approves) | `kimi.sh` omits `-y`; the OS sandbox is the boundary |
| Candidate rejected `verification_failed` on a `.mjs`/`.js` mismatch | Vendor chose a different extension than the policy globs | Broaden the policy glob (`*.test.{js,mjs,cjs}`) or make filenames hard acceptance criteria |
| `git worktree add failed: branch already exists` | Prior worktree removed but branch kept (forensics) | `git branch -D hydra/<run>/<task>` then re-create, or resume on the existing branch |
| `command not found: timeout` | macOS has no GNU `timeout` | `hydra_timeout` falls back to a perl shim; `brew install coreutils` gives `gtimeout` |
| Codex: `Reading additional input from stdin...` (hang) | non-TTY stdin | adapters close stdin (`</dev/null`) |
| Codex/Kimi can't `git commit` in-sandbox | linked worktree's `.git` is in the git-common-dir, outside the worktree | adapters add the git-common-dir to writable roots (resolved via `pwd -P`) |
| A running task needs to be cancelled | Operator needs to stop a dispatched worker | Use `bash kit/hydra/scripts/cancel-task.sh <run> <task>`. This is the only supported clean cancellation path. Never `kill -9` a dispatch process directly: it bypasses the clean path and can leave a dangling `running` ledger entry. |

## Concurrent runs

- **Isolation:** every writer gets its own worktree + branch; no two writers
  share a tree (enforced by disjoint `writable_paths` and separate worktrees).
- **Slots:** `dispatch.sh` uses a per-run slot dir (`runs/run-<id>/.slots`) capped
  at `HYDRA_MAX_CONCURRENCY`; the slot is acquired unconditionally before a
  dispatch proceeds, so both foreground (blocking) and backgrounded dispatches
  can wait and emit `concurrency_wait`. There is **no per-task mutex** yet — do
  not dispatch the same `(run, task)` twice concurrently (open item, roadmap).
- **Stale base:** if primary moves mid-run, do not silently rebase candidates.
  Finish against the recorded base; integrate; then update-to-latest as a
  separate re-verified step (architecture §8).
- **Second merger:** the integration worktree re-runs the combined gate after
  each applied candidate — a later candidate that invalidates an earlier one is
  caught there, not at merge.

## Health checks

```bash
bash kit/scripts/doctor.sh                   # Wave 3 preflight check (PASS/WARN/FAIL)
bash kit/scripts/doctor.sh --json            # structured output for tooling/automation
bash kit/scripts/doctor-fix.sh <check-name>  # single-fix executor (used by /hydra-doctor's opt-in remediation; never run standalone without understanding what it will execute)
bash kit/hydra/tests/run-boundary-tests.sh   # the trust boundary's unit tests (expect 9/9)
bash kit/hydra/tests/recovery-drill.sh       # lead-kill reconstruction (expect 3/3)
```
Run both after any change to `promote.sh`, `lib.sh`, or an adapter.


## Worktree retention policy

Worktrees are audit artifacts while a task is in flight — vendor per-commit
history, session captures, the promote divergence baseline. Once the run's
lifecycle is captured by `run-log` (docs/hydra-dev-logs/run-<id>.md) and the
squash commit is on the default branch, the worktree is redundant.

- **At run close** (post-merge): `run-log.sh <run-id>` then
  `gc.sh --apply --keep-last 3`. Keep-last covers amend/re-entry flows.
- **gc proves before it deletes**: authoritative result + a recorded
  integration SHA reachable from the default branch, proof paired to the
  current branch tip via the same squash-record evidence chain, clean tree
  beyond the known-junk set, path validated against `git worktree list`,
  atomic compare-and-delete (`update-ref --no-deref -d <ref> <expected>`).
  Anything unprovable is skipped with a reason — including worktrees
  integrated via GitHub PR squash-merges, which git cannot tie back to the
  candidate SHA; remove those manually after the PR merges.
- **Every removal is audited**: `worktree_reaped` (or `worktree_reap_partial`
  with rerun recovery) in the run ledger.
- **Monthly hygiene**: `git worktree prune` clears stale admin data for
  directories removed outside gc.
