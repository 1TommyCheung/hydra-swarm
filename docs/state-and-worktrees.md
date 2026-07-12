# Hydra-Swarm — State and Worktrees

## 1. Three storage domains

### Domain 1 — Tracked in Git (reusable orchestration implementation)

```text
<repo>/
├── AGENTS.md
├── CLAUDE.md
├── .claude/{agents/, hooks/, skills/hydra-protocol/}
├── .codex/config.toml
├── hydra/
│   ├── README.md
│   ├── schemas/          # run, task, result, review JSON schemas
│   ├── templates/        # run.example.yaml, task.example.yaml
│   ├── scripts/          # create-worktree.sh, dispatch.sh, verify.sh,
│   │                     #   audit-ownership.sh, promote.sh, integrate.sh
│   ├── adapters/         # claude.sh, codex.sh  (opencode.sh, kimi.sh in Wave 1/2)
│   ├── policies/         # ownership.yaml, permissions.yaml, verification.yaml
│   └── tasks/planned/    # human-reviewed task definitions (pre-run)
└── docs/hydra-reports/   # selected final reports only (optional)
```

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
