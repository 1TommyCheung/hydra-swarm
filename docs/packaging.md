# Hydra-Swarm — Packaging and Multi-Repo Deployment (Wave 3)

> **Status: `hydra doctor` preflight and compiled-binary distribution via
> GitHub Releases are built and live (v0.7.2+); kit extraction / `hydra-setup`
> install / upgrade / global-ledger machinery is still design-only.** Wave 2
> is operational; the binary release mechanism (below) is the first real
> packaging artifact. The rest of this doc remains the plan for kit-style
> multi-repo deployment. Scope and the preflight matrix are informed by a
> portability audit of what actually pins Hydra to the first machine
> (roadmap → Wave 3). `last_verified: 2026-07-19`.

Applies only after Wave 2 exit criteria pass on the first repository. Waves 0–2 are the de-risking sequence for building Hydra-Swarm **once**; subsequent repositories install the proven kit at full capability.

## 0. Binary distribution (live, v0.7.2+)

The compiled binary is the operational default runtime, and it ships via
GitHub Releases — not committed to git.

- **Release pipeline** (`.github/workflows/release.yml`, triggered by a `v*`
  tag): a 4-target build matrix compiles every release artifact
  (darwin-arm64/x64, linux-x64/arm64 — glibc; Windows via WSL) with pinned
  Bun 1.3.14, blackbox-verifies the runner-native artifact, asserts
  `tag == plugin.json version == binary self-report`, and uploads binaries +
  provenance manifests + SHA256SUMS.
- **`fetch-bin.sh`** downloads the release binary matching THIS plugin's
  version into a version-keyed cache
  (`~/.local/share/hydra-bin/v<version>/hydra-cli-<target>`), gated on:
  manifest SHA-256 match, binary self-reported version == plugin version, and
  target-triple match. Any gate fails → nothing installed, the `ts` lane is
  unaffected.
- **Resolution ladder** (`hydra_resolve_bin`): `HYDRA_BIN` → checkout `dist/`
  → version-keyed cache → `ts` fallback. The cache is keyed by the checkout's
  own plugin version, so a stale binary is structurally invisible rather than
  merely checked for.
- **Doctor** reports the resolved binary and warns on version drift or a
  pre-0.7.1 build (no `version` subcommand), with `fetch`/`rebuild` auto-fix
  commands.

This closes the "how does a fresh checkout get a binary" gap that was still
future work when this doc was first written. The kit-extraction / multi-repo
machinery in §1 onward remains design-only.

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

### Step 0 — Preflight (`hydra doctor`, non-negotiable)

The kit is trivially portable (zero hardcoded paths; all locations
env-overridable). The *ecosystem* is not — it must be present and authenticated
before install. `hydra doctor` checks, and refuses to proceed on any miss:

| Class | Requirement | Failure mode if absent |
|---|---|---|
| Shell | any bash (no minimum version — the retired Bash lane needed `mapfile`/bash≥4; the current `ts`/`bin` launchers are verified against real macOS bash 3.2) | none — `hydra doctor` reports the detected version informationally |
| Core | `jq`, `node`, `git` | harness can't run |
| Vendor CLIs + auth | `claude`, `codex`, `opencode` (+ Z.AI), `kimi` (+ OAuth) — headless smoke each | dispatch fails; adapter reports it |
| Code intelligence | `gitnexus`, `graphify` (+ `MOONSHOT_API_KEY`/`ANTHROPIC_API_KEY`) | Wave 1/2 code-intel omitted (advisory, non-fatal) |
| Observability | `herdr` + `herdr integration install {claude,codex,kimi,opencode}` (global, not cloned) | Layer-1 monitor absent (non-fatal) |
| **Platform sandbox** | `srt` (Anthropic `sandbox-runtime`, npm package `@anthropic-ai/sandbox-runtime`) — Seatbelt backend on macOS, bubblewrap backend on Linux, identical CLI/config | **Kimi/auto-approving write roles refused, on the record** — read-only roles still work |
| Timeout | `timeout`/`gtimeout` preferred; perl fallback otherwise | none (fallback is portable) |

Auth is machine-global (`~/.claude`, `~/.codex`, `~/.local/share/opencode`,
`~/.kimi-code/oauth`) and never ships in the kit.

> **As-built for the preflight only:** the repo root now contains a real,
> tested Claude Code plugin skeleton implementing exactly this table. The plugin
> manifest is at `.claude-plugin/plugin.json` (with `.claude-plugin/marketplace.json`
> for marketplace discovery); the slash command is `commands/hydra-doctor.md`; and
> the script it runs is `kit/scripts/doctor.sh`. The script performs the seven
> check classes shown above, distinguishes fatal `FAIL` from advisory `WARN`, and
> exits non-zero only when a fatal check fails (shell version, missing
> `jq`/`git`/Node, or a broken `srt` sandbox). It does **not** implement Steps
> 1–5; install, per-project inputs, self-checks, and shakedown remain pure design
> spec.

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

> **As-built (2026-07-13):** measured evidence is currently **per-repo** —
> `aggregate-usage.sh` writes `<state>/agents/profiles/<vendor>.measured.json`.
> The move to `~/.local/state/hydra/global/` with `repo_id` tagging is a Wave 3
> deliverable, not yet built. At Wave 2 exit n is small (Claude 5, Codex 4,
> Kimi 3), so nothing compounds cross-repo yet regardless.

## 4.1 Run bundles (multi-machine continuity)

External runtime state does **not** clone with the repo (by design). To carry a
run's history/evidence to another machine, export a sanitized bundle (the shape
in `state-and-worktrees` §2):

```text
run-<id>-recovery/  →  run.yaml · tasks/ · promoted-results/ · reviews/ ·
                       verification/ · events.jsonl
```

**Excludes** credentials, session tokens, raw environment values, sensitive
prompts, raw transcripts. `bundle-import.sh` reconstructs it under the target's
state root; the recovery drill is the acceptance test (a replacement lead
resumes from the imported bundle + Git alone).

> **As-built (2026-07-13):** the bundle shape is specified but the
> `bundle-export.sh` / `bundle-import.sh` scripts are **not yet built** — moving
> history today means `rsync`-ing `<state>/runs/run-<id>/` minus `sessions/`.
> Building these is a Wave 3 deliverable (closes the Tier-3 portability gap).

## 5. Upgrade protocol

Kit evolves in its own repo (model releases, CLI flag changes → adapters + seeded profiles are the two designed drift points). *This held in practice: Waves 1–2 saw exactly this drift — `zhipu/`→`zai-coding-plan/glm-5.2`, `opencode --auto`, `kimi` print-mode auto-approve, `--output-format stream-json` — all confined to the adapters. The design point is validated.* Per project: `"upgrade hydra to kit vX.Y.Z"` — the skill:

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
