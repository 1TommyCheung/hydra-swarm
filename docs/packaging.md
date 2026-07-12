# Hydra-Swarm — Packaging and Multi-Repo Deployment (Wave 3)

Applies only after Wave 2 exit criteria pass on the first repository. Waves 0–2 are the de-risking sequence for building Hydra-Swarm **once**; subsequent repositories install the proven kit at full capability.

## 1. The kit

`hydra-kit` is its own Git repository containing everything project-agnostic, version-tagged:

```text
hydra-kit/
├── kit.manifest.yaml        # version, file checksums, min tested CLI versions
├── schemas/  scripts/  adapters/  templates/
├── policies/
│   ├── verification.yaml.template
│   ├── ownership.yaml.template
│   └── bootstrap.yaml.template
├── claude/{skills/hydra-protocol, skills/hydra-setup, hooks/, agents/}
├── AGENTS.md
├── CLAUDE.md
└── profiles-seeded/          # seeded priors only — never measured data
```

**Ships in the kit:** scripts, schemas, adapters, skills, hooks, universal rules, seeded vendor profiles.
**Never ships in the kit:** the three per-project policy files (templates only), measured ledger data, run history, credentials, session state.

## 2. Deploying to a new repository

### Step 1 — Install (mechanical)
`hydra-setup` skill, install mode: copy kit → `hydra/` + `.claude/`; create `~/.local/state/<repo-id>-hydra/` (full Domain-2 layout); link the global agents ledger (§4); write `hydra/WAVE = 2` and `hydra/VERSION = <kit-version>`; add `.gitignore` entries; commit; tag `hydra-wave-2`.

### Step 2 — Per-project inputs (the only real work)
1. `policies/verification.yaml` — this repo's definition of "passed". Skill may propose from build files; human approves.
2. `policies/ownership.yaml` — this repo's module boundaries as globs. **Human-reviewed, always** — it is the gate everything else trusts.
3. Bootstrap block — dependency install, unique-port needs, project setup.

### Step 3 — Install-time self-checks (automatic, non-negotiable)
- The six boundary rejection tests, run in this environment: fake SHA · false "passed" claim · out-of-scope diff · untracked file outside ownership · symlink escape · stale spec version.
- Headless smoke check per configured vendor CLI.
- Any failure ⇒ install remains incomplete; skill reports the specific gap. Rationale: trust the code, verify the deployment — OS setup, monorepo layout, submodules, and CLI versions differ per machine and repo.

### Step 4 — Supervised shakedown run
One trivial task, one worker, human watching. This tests Step 2, not the kit: the dominant new-repo failures are ownership globs that are too tight/too loose and verification commands that behave differently inside a worktree (missing env files, path-dependent config). Full parallel runs from the next run onward.

## 3. What transfers vs. what stays local

| Transfers with the kit / global ledger | Stays per-repo |
|---|---|
| Scripts, schemas, adapters, skills, hooks | verification.yaml |
| Trust boundaries, gates, wave machinery | ownership.yaml |
| `AGENTS.md` universal rules | bootstrap block |
| Seeded profiles + global measured evidence | planned tasks, run history, reports |

## 4. Global capability ledger

Measured evidence moves to machine-global scope so it compounds across repositories:

```text
~/.local/state/hydra/global/agents/
├── availability.yaml          # machine-level slots/cooldowns/budget
├── usage.jsonl                # events tagged with repo_id
└── profiles/                  # measured blocks aggregate across repos
<per-repo state>/agents/overrides/    # optional repo-specific pins
```

Rules: usage events carry `repo_id`; the `task_type` + `risk_mix` confound guards apply **more strictly** cross-repo (a vendor that only saw easy tasks in repo A must not look superior in repo B); rolling windows and per-event model versions unchanged; allocation reads global measured stats with repo overrides winning.

## 5. Upgrade protocol

Kit evolves in its own repo (model releases, CLI flag changes → adapters + seeded profiles are the two designed drift points). Per project: `"upgrade hydra to kit vX.Y.Z"` — the skill:

1. Refuses if any run is open in the ledger.
2. Diffs manifests; applies kit changes only.
3. **Never modifies** the three per-project policy files.
4. Re-runs the install-time self-checks.
5. Bumps `hydra/VERSION`; commits `hydra-swarm: kit vX.Y.Z`; tags.

Rollback = git revert of that commit (state layout is versioned in the manifest; migrations, if ever needed, ship as kit scripts).

## 6. Honest limits

The kit compounds the *system and its evidence*; it does not compound judgment about a new codebase. Expect the first 2–3 runs on any new repo to surface ownership and verification gaps — the kit makes these cheap to fix, not impossible to make. Keep the shakedown run supervised.

## 7. Trajectory

Kit + installer skill + global ledger ≈ the standalone `hydra` CLI (`hydra init`, `hydra upgrade`, `hydra doctor`) on the roadmap — and beyond that, the shape of a distributable product rather than a personal tool.
