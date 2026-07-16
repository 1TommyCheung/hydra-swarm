# hydra/ — Hydra-Swarm harness (Wave 0)

Deterministic command launchers, schemas, policies, and templates that
implement the Hydra-Swarm integration loop. Design docs live in
`../docs/hydra-swarm/`. This directory is the **harness surface**: trusted,
human-reviewed, tracked in Git. The lead *calls* these scripts; it is not a
component.

**Runtime (run 0045):** every `scripts/<name>.sh` is a small launcher that
execs the TypeScript implementation in `../hydra-ts/src/` (`ts`, the default)
or a pinned compiled binary (`HYDRA_HARNESS=bin` + `HYDRA_BIN`, the no-Node
rollback). The Bash implementation lane — the script Bash bodies and the
`adapters/*.sh` shell vendor adapters — was retired in run 0045
(`../../docs/bash-lane-retirement-plan.md`): `HYDRA_HARNESS=bash` fails loudly
rather than coercing to `ts`, and this directory no longer contains an
`adapters/` folder.

**Reserved-prefix rule:** no human or agent creates branches under `hydra/` or
`hydra-integration/` outside these scripts.

## Layout

```
hydra/
├── schemas/       run|task|result|review JSON schemas
├── templates/     run.example.yaml, task.example.yaml
├── policies/      ownership.yaml, permissions.yaml, verification.yaml
└── scripts/       ts/bin launchers (no Bash bodies since run 0045)
    ├── lib.sh              shared launcher API (node/bin resolution, logging)
    ├── run-init.sh         create external run state (Domain 2)
    ├── create-worktree.sh  worktree + branch + bootstrap + PORT (Domain 3)
    ├── dispatch.sh         adapter selection + timeout + session capture
    ├── promote.sh          THE TRUST BOUNDARY (schema→git→ownership→verify→promote)
    ├── verify.sh           sandboxed verification (called by promote + integrate)
    ├── audit-ownership.sh  authoritative ownership audit (§5 rule set)
    ├── squash.sh           harness-created integration squash
    ├── integrate.sh        cherry-pick loop + combined verification gate
    └── jsonschema.mjs      dependency-free JSON Schema validator
```

## State lives OUTSIDE this repo

Runtime state is never tracked and never inside a worktree
(`state-and-worktrees.md` §1):

```
~/.local/state/<repo-id>-hydra/runs/run-<id>/
├── run.yaml  tasks/  inbox/            (inbox = UNTRUSTED worker drops)
├── authoritative/ledger|results|reviews|verification    (harness-written ONLY)
└── sessions/
```

Worktrees live at `~/worktrees/<repo-id>/run-<id>-<task>/`. Override locations
for testing with `HYDRA_STATE_ROOT`, `HYDRA_WORKTREE_ROOT`, `HYDRA_REPO_ID`.

## Every script is runnable standalone

```bash
hydra/scripts/run-init.sh 0042
hydra/scripts/create-worktree.sh 0042 my-task
hydra/scripts/dispatch.sh 0042 my-task
hydra/scripts/promote.sh 0042 my-task \
  ~/.local/state/webtrail-hydra/runs/run-0042/inbox/0042-my-task-v1/result.json
hydra/scripts/squash.sh 0042 my-task
hydra/scripts/integrate.sh 0042 my-task
```

## Trust boundary rejection tests

`tests/run-boundary-tests.sh` proves `promote.sh` rejects the six ways a worker
drop can lie (nonexistent SHA, false "passed" claim, out-of-lane write, untracked
file outside ownership, symlink escape, stale spec version). Run them before
trusting any live agent:

```bash
hydra/tests/run-boundary-tests.sh
```

## Scope

Wave 0 only: Claude + Codex workers and the core evidence-gated loop. No
GitNexus, Graphify, capability profiles, other adapters, monitors, or OTel — see
`../docs/hydra-swarm/README.md`.
