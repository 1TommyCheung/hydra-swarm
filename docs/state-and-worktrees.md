# Hydra-Swarm — State and Worktrees

## 1. Three storage domains

### Domain 1 — Tracked in Git (reusable orchestration implementation)

```text
<repo>/
├── AGENTS.md
├── CLAUDE.md
├── .claude-plugin/      # plugin.json, marketplace.json
├── commands/            # slash commands (e.g. hydra-doctor.md)
├── kit/
│   ├── hydra/
│   │   ├── README.md
│   │   ├── WAVE                     # wave-level marker
│   │   ├── schemas/                 # run, task, result, review JSON schemas
│   │   ├── templates/               # run.example.yaml, task.example.yaml
│   │   ├── scripts/                 # ts/bin launchers: create-worktree.sh, dispatch.sh,
│   │   │                            #   verify.sh, audit-ownership.sh, promote.sh, integrate.sh
│   │   ├── policies/                # ownership.yaml, permissions.yaml, verification.yaml
│   │   ├── profiles/                # per-vendor capability profiles (Wave 2)
│   │   ├── runs-config/             # run-level configuration
│   │   └── tests/                   # boundary / recovery tests
│   ├── hydra-ts/
│   │   ├── src/                     # default harness + vendor-adapter implementations
│   │   └── test/                    # TypeScript harness tests
│   └── scripts/                     # plugin helper scripts (e.g. doctor.sh)
├── skills/hydra-swarm/  # lead orchestration skill (SKILL.md + references/)
└── docs/                # operations, architecture, vendor-adapters, etc.
```

`kit/hydra/scripts/<name>.sh` remains the stable operator command surface; each
is a small launcher that execs the corresponding module in `kit/hydra-ts/src/`
(`ts`, the default) or a pinned compiled binary (`bin`). The Bash body lane was
retired in run 0045 (`docs/bash-lane-retirement-plan.md`): `HYDRA_HARNESS=bash`
fails loudly and the `kit/hydra/adapters/*.sh` shell adapters were deleted.
This runtime change did not change the external state root, run-directory
schema, worktree paths, branch naming, or custody boundaries described below.

### Domain 2 — External runtime state (never in any worktree, never tracked)

```text
~/.local/state/<repo-id>-hydra/
├── runs/run-0042/
│   ├── run.yaml            # instantiated run plan
│   ├── tasks/              # instantiated, versioned task specs
│   ├── inbox/              # UNTRUSTED worker drops
│   │   └── <agent-run-id>/result.json
│   ├── authoritative/      # harness-written only
│   │   ├── ledger/events.jsonl
│   │   ├── results/        # promoted results
│   │   ├── reviews/
│   │   └── verification/
│   └── sessions/           # session ids, adapter state
├── agents/                 # availability.yaml, usage.jsonl, profiles/ (Wave 2)
└── indexes/                # gitnexus/<repo-id>/<commit-sha>/, graphify/ (Wave 1+)
```

Rationale: state inside the repo would be worker-readable/writable, would appear in diffs, would desynchronize across worktrees, and is a prompt-injection surface. Task specs are **copied read-only** into worker environments; workers never see the state store.

### Domain 3 — Worktrees (Git-managed, outside the main checkout, disposable)

```text
~/worktrees/<repo>/
├── run-0042-canvas-validation/
├── run-0042-video-export/
└── run-0042-integration/
```

```bash
git worktree add ~/worktrees/<repo>/run-0042-canvas-validation \
  -b hydra/0042/canvas-validation <base-commit>
```

Branch naming: `hydra/<run-id>/<task-id>`, `hydra-integration/<run-id>`. Deterministic paths; user-supplied text normalized before entering any path or branch name.

## 2. State location and portability (corrected)

| Location | Survives worktree removal | Shared by local worktrees | Travels with a clone |
|---|---:|---:|---:|
| `~/.local/state/...` | Yes | Yes | No |
| `<git-common-dir>/hydra/` | Yes | Yes | **No** |
| Tracked repository directory | Yes | Yes after commit | Yes |
| Exported run bundle (below) | Yes | Yes | Yes |

`<git-common-dir>/hydra/` keeps state associated with the local Git repository and shared among its worktrees, but **does not travel with a new clone** — nothing inside `.git` is cloned. Default location: `~/.local/state/`.

**Multi-machine continuation:** export a sanitized run bundle and transfer it explicitly:

```text
run-0042-recovery/
├── run.yaml
├── tasks/
├── promoted-results/
├── reviews/
├── verification/
└── events.jsonl
```

Exclude: credentials, session tokens, raw environment values, sensitive prompts, raw transcripts.

## 3. Task-spec classes

- **Planned** (Domain 1, tracked): human-reviewable product/architecture task definitions.
- **Instantiated** (Domain 2): run-specific specs with worktree paths, SHAs, vendor, budget, timestamps — operational state, not product source.

## 4. Worktree bootstrap lifecycle (harness-executed, before the worker exists)

```text
Harness creates worktree (Domain 3)
        ↓
Harness installs dependencies — approved network policy for this phase only
        ↓
Harness records bootstrap result (ledger event)
        ↓
[Wave 1+] Harness runs conditional indexing (see code-intelligence.md)
        ↓
Network disabled for the worktree environment
        ↓
Worker starts
```

```yaml
# per-project bootstrap config (tracked in policies/)
bootstrap:
  common:
    - pnpm install --frozen-lockfile
  wave_1:                       # conditional; absent in Wave 0
    - gitnexus analyze          # harness-run; see code-intelligence.md for index custody
env_per_worktree:
  PORT: "{auto_unique}"         # parallel worktrees must never contend for ports
timeout_minutes: 10
```

Notes: use pnpm's shared content-addressed store so N worktrees don't download N copies of dependencies; Python projects need per-worktree venvs (heavier — budget for it). Bootstrap network access is a *different* policy from worker network access (which is off).

## 5. Git-tracking decision table

| Item | Track? | Reason |
|---|---:|---|
| `AGENTS.md`, `CLAUDE.md`, `.claude/{agents,hooks,skills}` | Yes | Project engineering method |
| Hydra-Swarm schemas/scripts/adapters/policies/templates | Yes | Deterministic workflow implementation |
| Planned task definitions | Yes | Human-reviewable before runs |
| Active run ledger, sessions, usage logs | No | Volatile/sensitive runtime state |
| Raw prompts and outputs | No | Large, noisy, potentially sensitive |
| GitNexus / Graphify indexes | No | Derived and rebuildable |
| Worktree directories, `node_modules` | No | Git-managed copies / derived |
| Final integration report | Optional | Commit when it records an important decision |
| Accepted implementation commits | Yes | The actual product changes |

`.gitignore` additions: `.gitnexus/`, `*.agent-result.json`, `.env.agent`, `.env.worktree`.

## 6. End of run

After human approval:

```bash
git switch main
git merge --no-ff hydra-integration/0042
git worktree remove ~/worktrees/<repo>/run-0042-*   # each
```

Removing worktrees never deletes commits already on branches. Worktrees are preserved until the integration branch is accepted or the run is explicitly abandoned. Retention of external run state: open decision (roadmap §Open decisions).

## 7. As-built drift notes (audit 2026-07-13)

- **`.gitignore` additions — as-built.** Beyond `state-and-worktrees §5`, the
  repo ignores `.gitnexus/`, `.claude/skills/gitnexus/`, `.claude/skills/generated/`,
  and `graphify-out/` (all derived/rebuildable code-intelligence artifacts).
- **Per-worktree git excludes.** `create-worktree.sh` appends `.hydra-task.yaml`,
  `.env.worktree`, `.hydra-result.json`, and `.gitnexus/` to the worktree's
  `info/exclude`, so harness-injected files never appear as untracked in the
  ownership audit.
- **Linked-worktree git metadata.** A linked worktree's `.git` is the
  git-common-dir *outside* the worktree; OS-sandboxed vendors (Codex, Kimi) must
  be granted it as a writable root (resolved via `pwd -P`, since `sandbox-exec`
  and `git worktree` paths differ by the `/var`→`/private/var` symlink) or
  `git commit` fails in-sandbox.
- **Retention — still nothing pruned.** 15 runs and their worktrees are retained
  (open decision #7). No automatic cleanup exists yet.
- **Kimi write-role pnpm store (fixed field incident, ws9-import-plan
  2026-07-17).** srt's mandatory git-metadata protection blocks writes to
  `.git/config`/`.git/hooks/*` under ANY nested `.git` dir inside an allowed
  write root — including pnpm's ephemeral tmp clones of git-hosted
  dependencies — and that protection has no settings-file opt-out. `adapter-kimi.ts`
  (`kimiStart`) now sets `npm_config_store_dir` to a per-task directory under
  `TMPDIR` (already an allowed write root) before invoking `srt`, so pnpm's
  store — and its ephemeral git clones — never touches worktree `.git` dirs
  and never lands inside the worktree at all. Do **not** hand-symlink
  `node_modules` from the main checkout as a workaround: that trips
  `promote.sh`'s ownership audit (changes outside `writable_paths`). The
  global pnpm store (`~/Library/pnpm/store` and equivalents) stays outside
  `allowWrite` on purpose and is not a viable fallback.
- **State-root override.** `HYDRA_STATE_ROOT` / `HYDRA_WORKTREE_ROOT` /
  `HYDRA_REPO_ID` override the default locations (the boundary tests and recovery
  drill redirect all state into a throwaway dir this way).
