# Hydra-Swarm — Operations Runbook

**Status:** Wave 2. This is the day-to-day guide to *operating* a run (Waves 0–2
documented *building*). It assumes the lead protocol in
`../../.claude/skills/hydra-protocol/SKILL.md`.

> Golden rule: you drive `hydra/scripts/*.sh`; you never hand-edit
> `~/.local/state/<repo-id>-hydra/authoritative/**`. Read promoted results, never
> raw inbox drops. Merge/push/deploy is human-authorized.

## The loop, in commands

```bash
export HYDRA_WAVE=2                       # gates conditional bootstrap (gitnexus analyze)
bash hydra/scripts/run-init.sh 0042       # -> run_started; creates the state tree
# write runs/run-0042/tasks/<task>.yaml per lane (template: hydra/templates/task.example.yaml)
bash hydra/scripts/create-worktree.sh 0042 <task>          # worktree + branch + bootstrap + PORT
bash hydra/scripts/dispatch.sh 0042 <task>                 # runs the assigned vendor worker
bash hydra/scripts/status.sh 0042 <task>                   # one-shot read-only task status
bash hydra/scripts/cancel-task.sh 0042 <task>              # clean cancellation of a running task
bash hydra/scripts/promote.sh 0042 <task> \
     ~/.local/state/<repo>-hydra/runs/run-0042/inbox/0042-<task>-v1/result.json   # THE trust boundary
bash hydra/scripts/review-dispatch.sh 0042 <rev> <vendor> <prompt-file>   # cross-vendor review (read-only)
bash hydra/scripts/record-review.sh 0042 <task> <verdict.json>            # record accept/revise/reject
bash hydra/scripts/squash.sh 0042 <task>                   # accepted candidates only
bash hydra/scripts/integrate.sh 0042 <task-in-dep-order>...# cherry-pick + smoke + combined gate
```

Only `accept` candidates enter `squash`/`integrate`. `revise`/`reject` return to
the same worktree (amend the spec + re-dispatch).

## Harness runtime selection

The command surface did not change during the TypeScript cutover: continue to
invoke `bash hydra/scripts/<name>.sh ...`. Every operational shell entry point
now selects the TypeScript implementation in `hydra-ts/src/` by default.

```bash
bash hydra/scripts/run-init.sh 0042                 # TypeScript (default)
HYDRA_HARNESS=ts bash hydra/scripts/run-init.sh 0042
HYDRA_HARNESS=bash bash hydra/scripts/run-init.sh 0042  # frozen Bash fallback
```

`HYDRA_HARNESS` supports `ts` and `bash`; unset means `ts`. The switch covers
the harness and, through dispatch, the vendor-adapter runtime. A lower-level
`HYDRA_ADAPTER_RUNTIME` override takes precedence inside TypeScript dispatch;
leave it unset for a whole-harness rollback. The Bash bodies remain in place as
frozen reference/rollback implementations. Their retirement is a separate
future decision, not part of the cutover.

## Environment variables (the operational surface)

| Var | Purpose |
|---|---|
| `HYDRA_HARNESS` | Harness runtime: `ts` (default) or `bash` (frozen reference/rollback fallback). |
| `HYDRA_ADAPTER_RUNTIME` | Advanced mixed-runtime override for TypeScript dispatch: `ts` or `bash`; takes precedence over `HYDRA_HARNESS` for the adapter only. Normally leave unset. |
| `HYDRA_WAVE` | Wave level; ≥1 activates the `wave_1` bootstrap (gitnexus analyze). Or set `hydra/WAVE`. |
| `HYDRA_STATE_ROOT` | Override the external state root (tests point this at a throwaway dir). |
| `HYDRA_WORKTREE_ROOT`, `HYDRA_REPO_ID` | Override worktree parent / repo id. |
| `HYDRA_VERIFY_POLICY` | Path to the verification policy `promote.sh`/`integrate.sh` re-run (combined gate). |
| `HYDRA_SMOKE_POLICY` | Per-candidate smoke policy for `integrate.sh` (task-specific; no cross-component tests). |
| `HYDRA_DELIVERY` | `start` (default) or `resume` — resume uses the captured session id where the adapter supports it. |
| `HYDRA_MAX_CONCURRENCY` | Backgrounded-dispatch slot cap (default `min(16, cores-2)`). |
| `HYDRA_LOOP_DETECTOR` | Loop-thinking detector. Enabled by default (`1` or unset); set to `0` to disable for a task/session where false positives are expected (e.g., legitimately long silent reasoning phases). |
| `HYDRA_HERDR_PANES=1` | Host each worker/reviewer in a herdr pane (Layer-1 live monitor). |
| `HYDRA_HERDR_KEEP_PANE=1` | Don't auto-close panes on completion (for inspection). |
| `HYDRA_REVIEW_TIMEOUT_MIN` | Harness timeout for a pane-hosted review (default 15). |
| `HYDRA_OPENCODE_MODEL` | e.g. `zai-coding-plan/glm-5.2` (the working id; NOT `zhipu/…`). |
| `MOONSHOT_API_KEY` / `ANTHROPIC_API_KEY` | Graphify semantic pass (`graphify-baseline.sh`). |
| `GRAPHIFY_KIMI_BASE_URL`, `GRAPHIFY_KIMI_MODEL`, `GRAPHIFY_KIMI_USER_AGENT` | Point Graphify's kimi backend at the coding endpoint (`https://api.kimi.com/coding/v1`, `kimi-for-coding`, `kimi-code-cli/0.23.6`). |

**Always dispatch detached** for anything slow, so an interactive tool/tmux
timeout can't SIGTERM the dispatch mid-run:

```bash
nohup bash hydra/scripts/dispatch.sh 0042 <task> >/tmp/d.log 2>&1 </dev/null & disown
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

From `hydra-ts/`, the standard suite is deliberately split:

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
bash hydra/scripts/herdr-push.sh 0042 --notify   # push ledger-derived state + reconcile
```

`herdr-push.sh` also **reconciles** the live view against the ledger and emits an
`observability_anomaly` event on disagreement (the ledger wins). That check
caught a real dangling-task bug the first time it ran.

Note: `codex exec` / `kimi -p` emit no session-lifecycle events, so the harness
pushes pane state itself (`hydra_herdr_state`). opencode still draws a formatted
display to a tty; for fully TUI-free runs use `opencode serve` + `--attach`.

## Authoritative view (Layer-2)

```bash
bash hydra/scripts/ledger-view.sh 0042   # self-contained HTML from the ledger alone
```

## Recovery drill (lead-kill)

Standing test, run it any time:

```bash
bash hydra/tests/recovery-drill.sh       # builds a mid-run state, reconstructs from ledger+Git only
```

Live procedure if a lead session dies: **do not rely on memory.** Read
`run.yaml` + `authoritative/ledger/events.jsonl` + Git to reconstruct which tasks
are planned/running/promoted/accepted/integrated, then resume from the last
recorded checkpoint. A promoted head is a real Git commit — verify with
`git cat-file -t <head>`.

## Capability profiles + allocation

```bash
bash hydra/scripts/aggregate-usage.sh                    # writes agents/profiles/<vendor>.measured.json
bash hydra/scripts/allocate.sh implementer feature high  # recommendation (never an auto-pin)
```

Allocation ranks on `measured` at n≥8, else seeded priors (`hydra/profiles/`).
It's recommend-only — a human pins the role.

## Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| TypeScript entry point reports `bad option: --experimental-strip-types`, or `npm test` exits 9 | A stale Node (observed: `/usr/local/bin/node` v17.4.0) shadows nvm's Node in a login/non-interactive shell | Current entry points use `hydra_resolve_node()`; update to current code. For npm, invoke it from an environment where `node --version` is ≥22.6, or temporarily use `HYDRA_HARNESS=bash` for Hydra commands. |
| Worker "completed" but no new commit; head == a prior commit | **Empty objective** (block-scalar not read) — historical, now fixed | `build-worker-prompt.sh` uses `hydra_yaml_block`. If you see it again, dump the prompt: `bash hydra/adapters/build-worker-prompt.sh <spec>` |
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
| A running task needs to be cancelled | Operator needs to stop a dispatched worker | Use `bash hydra/scripts/cancel-task.sh <run> <task>`. This is the only supported clean cancellation path. Never `kill -9` a dispatch process directly: it bypasses the clean path and can leave a dangling `running` ledger entry. |

## Concurrent runs

- **Isolation:** every writer gets its own worktree + branch; no two writers
  share a tree (enforced by disjoint `writable_paths` and separate worktrees).
- **Slots:** `dispatch.sh` uses a per-run slot dir (`runs/run-<id>/.slots`) capped
  at `HYDRA_MAX_CONCURRENCY`; backgrounded dispatches wait and emit
  `concurrency_wait`. There is **no per-task mutex** yet — do not dispatch the
  same `(run, task)` twice concurrently (open item, roadmap).
- **Stale base:** if primary moves mid-run, do not silently rebase candidates.
  Finish against the recorded base; integrate; then update-to-latest as a
  separate re-verified step (architecture §8).
- **Second merger:** the integration worktree re-runs the combined gate after
  each applied candidate — a later candidate that invalidates an earlier one is
  caught there, not at merge.

## Health checks

```bash
bash hydra/tests/run-boundary-tests.sh   # the trust boundary's unit tests (expect 9/9)
bash hydra/tests/recovery-drill.sh       # lead-kill reconstruction (expect 3/3)
```
Run both after any change to `promote.sh`, `lib.sh`, or an adapter.
