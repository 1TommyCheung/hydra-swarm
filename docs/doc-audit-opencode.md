# Documentation Accuracy Audit — opencode (run 0021)

**Auditor:** opencode (GLM 5.2) · **Date:** 2026-07-15
**Scope:** `docs/roadmap.md`, `README.md`, `docs/README.md`,
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, plus a
general pre-extraction-path + stale-language sweep over `docs/`, `skills/`,
`kit/hydra/`, `kit/hydra-ts/`.
**Method:** every doc claim was re-derived from source by reading the actual
files; no prior doc-writing session was trusted. Line numbers are from the
working tree at base `55f7386`.

---

## Verdict at a glance

| Scope area | Result |
|---|---|
| `docs/roadmap.md` — Task #31 entry accuracy | **PASS** — every code claim verified true |
| `docs/roadmap.md` — stale pre-extraction paths | **FAIL** — several (§2) |
| `README.md` (root) | **PASS w/ minor** (§3) |
| `docs/README.md` | **FAIL** — dense cluster of stale paths (§4) |
| `plugin.json` version `0.4.0` | **PASS** (§5) |
| `marketplace.json` vs `plugin.json` + `/plugin install` | **PASS** (§5) |
| General pre-extraction-path sweep | **FAIL** — normative docs use bare `hydra/scripts/`; design/review docs are clean (§6) |
| TODO/FIXME/"coming soon" sweep | **PASS** — no stale markers; "not built" claims verified true (§7) |

---

## 1. `docs/roadmap.md` — Task #31 entry (lines 169–197): ACCURATE

The entry's claims were checked one-by-one against `kit/hydra-ts/src/` and
`kit/hydra/scripts/`. **No overstatement or understatement found.**

| Roadmap claim | Source evidence | Verdict |
|---|---|---|
| `status.sh` exists at `kit/hydra/scripts/status.sh` | file present (`kit/hydra/scripts/status.sh`, 8285 B) + TS `kit/hydra-ts/src/status.ts` | ✅ |
| `cancel-task.sh` exists at `kit/hydra/scripts/cancel-task.sh` | file present (6301 B) + TS `kit/hydra-ts/src/cancel-task.ts` | ✅ |
| cancel-task resolves via pidfile/process-discovery, SIGTERM → wait → SIGKILL last resort, never mutates state | `cancel-task.ts:337` ("The command never mutates the ledger itself"); SIGTERM at `:353`, escalation to SIGKILL at `:420` after a re-read/wait window (`:388`–`:420`) | ✅ |
| `dispatch.sh --background` only selects whether the CLI awaits the worker, not how the worker runs | `kit/hydra/scripts/dispatch.sh:402-409` — `--background` branch just appends `&` to `run_worker`; comment at `:270` ("the adapter always runs as a plain background subprocess"); TS `dispatch.ts:1281` sets `background` flag | ✅ |
| two-stage monitoring: `agent_loop_suspected` then `agent_loop_confirmed` | event strings at `loop-detector.ts:1003` (`agent_loop_suspected`) and `:967` (`agent_loop_confirmed`); `status.ts:135-136` surfaces both; `CONFIRMATION_WINDOW_MS` (`loop-detector.ts:102`) is the confirmation window | ✅ |
| auto-cancels via the same clean path as manual cancellation | on `confirmed`, dispatch tick calls `recorder.cancel()` (`dispatch.ts:570-572`) | ✅ |
| monitors Codex/Kimi/OpenCode; Claude excluded | `STREAMING_VENDORS = new Set(['codex','kimi','opencode'])` (`loop-detector.ts:119`); tick short-circuits when vendor not in set (`:707`) | ✅ |
| Claude excluded **because it has no streaming capture** | Claude adapter writes only a final snapshot `${id}.cli.json` (`adapter-claude.ts:271`) + `.stderr`; the detector tails streaming `${id}.cli.jsonl` (codex/kimi, `adapter-codex.ts:394`) or `${id}.events.jsonl` (opencode). No `.cli.jsonl` is produced for Claude. | ✅ rationale confirmed |
| `HYDRA_LOOP_DETECTOR=0` disables | `loop-detector.ts:707` and `dispatch.ts:552` both early-return on that value | ✅ |

### 1.1 `docs/roadmap.md` date / self-consistency

Dates are chronological and internally consistent: Wave 0 `2026-07-12`
(`:12`), Waves 1–2 + TS cutover + Wave-3 preflight `2026-07-13`
(`:24,:47,:82,:105,:125`), License + Task #31 `2026-07-14` (`:155,:169`).
No entry contradicts another. ✅

---

## 2. `docs/roadmap.md` — stale pre-extraction paths (FINDINGS)

### F-ROADMAP-1 · non-existent evidence paths · `docs/roadmap.md:103`
**Claim:** cutover evidence lives in ``../hydra-reports/wave2-ts-cutover.md``
and ``../../hydra-ts/migration/``.
**Reality:** neither path exists in this standalone repo. No `hydra-reports/`
directory and no `migration/` directory exist anywhere in the tree
(`find . -type d -name 'migration'` → empty; no `*hydra-reports*` files).
These are leftovers from the pre-extraction mono-repo sibling-directory layout.
**Fix direction:** drop or rewrite to in-repo locations (e.g. the design docs
under `docs/`), or mark as "lived in the pre-extraction tree."

### F-ROADMAP-2 · bare `hydra/scripts/` · `docs/roadmap.md:85`
**Claim:** "ran the unchanged `bash hydra/scripts/<name>.sh` command surface."
**Reality:** the scripts live at `kit/hydra/scripts/` (no `hydra/` at repo
root — `ls hydra` → no such directory). **Confirms** `kit/hydra/scripts/`
exists (30 scripts, incl. `dispatch.sh`).

### F-ROADMAP-3 · bare `hydra/scripts/` shorthand · `docs/roadmap.md:329`
**Claim:** doc-maintenance checklist says reconcile claims "against
`hydra/scripts/` reality." Same stale prefix as F-ROADMAP-2.

### F-ROADMAP-4 · `docs/hydra-reports/` referenced as existing · `docs/roadmap.md:6` and `:333`
**Claim:** "`docs/hydra-reports/` for the per-wave evidence" (`:6`) and the
exit report goes "into `docs/hydra-reports/`" (`:333`).
**Reality:** `docs/hydra-reports/` does not exist (`ls docs/` has no such
entry). The directory is referenced as a home for evidence that is not
committed in this repo.

### F-ROADMAP-5 · `hydra-swarm-plugin/` prefix on root-relative paths · `docs/roadmap.md:113-117, :231`
**Claim:** Wave-3 preflight artifact paths are written as
`hydra-swarm-plugin/.claude-plugin/plugin.json` (`:115`),
`hydra-swarm-plugin/commands/hydra-doctor.md` (`:116`),
`hydra-swarm-plugin/kit/scripts/doctor.sh` (`:117`), and "`hydra doctor` …
command in `hydra-swarm-plugin/`" (`:231`).
**Reality:** in this standalone repo those artifacts live at the **repo root**
(`.claude-plugin/plugin.json`, `commands/hydra-doctor.md`,
`kit/scripts/doctor.sh` — all verified present). The repo is named
`hydra-swarm` (remote `github.com/1TommyCheung/hydra-swarm.git`) and the
plugin `name` is `hydra-swarm`. The `hydra-swarm-plugin/` prefix is a
pre-extraction subdirectory name that no longer reflects the layout.

---

## 3. `README.md` (repo root) — mostly accurate, two minor findings

### F-README-1 · layout tree root label · `README.md:75`
**Claim:** the layout tree is rooted at `hydra-swarm-plugin/`.
**Reality:** the repo/plugin is named `hydra-swarm` (see F-ROADMAP-5).
Structurally the listed children (`.claude-plugin/`, `commands/`, `skills/`,
`docs/`, `kit/hydra/`, `kit/hydra-ts/`) **do** all exist at the root, so this
is a labeling/naming nit, not a structural error. Severity: low.

### F-README-2 · `kit/` omits `kit/scripts/` · `README.md:79-83`
**Claim:** the layout tree lists only `kit/hydra/` and `kit/hydra-ts/` under
`kit/`.
**Reality:** `kit/scripts/doctor.sh` also exists (the same file
`commands/hydra-doctor.md` wraps — `commands/hydra-doctor.md:3,8` references
`${CLAUDE_PLUGIN_ROOT}/kit/scripts/doctor.sh`, and the file is present, 5201 B).
The tree omits it. Severity: low.

**Otherwise accurate:** the four vendors, `/hydra-doctor` requirement table,
`hydra doctor` non-zero-only-on-fatal semantics, and the loop description
match the source. ✅

---

## 4. `docs/README.md` — dense cluster of stale pre-extraction paths (FINDINGS)

This file was clearly written for the pre-extraction mono-repo and was not
updated when the kit moved under `kit/`. It is the most stale doc in scope.

### F-DOCSREADME-1 · harness path · `docs/README.md:11`
**Claim:** "The harness implementation now lives in `hydra-ts/src/*.ts`."
**Reality:** `hydra-ts/` does not exist at the root; the implementation is at
`kit/hydra-ts/src/` (39 `.ts` files verified). **Confirming code:** the
correct path is used elsewhere, e.g. `skills/hydra-swarm/SKILL.md:25`
(`${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts/src/`).

### F-DOCSREADME-2 · operator command surface · `docs/README.md:12`
**Claim:** "Operators continue to call the stable `hydra/scripts/<name>.sh`
entry points." **Reality:** stable surface is `kit/hydra/scripts/*.sh`
(30 scripts verified; `hydra/` does not exist at root).

### F-DOCSREADME-3 · non-existent migration dir · `docs/README.md:15`
**Claim:** "migration findings … are in `../../hydra-ts/migration/`."
**Reality:** no `migration/` directory exists anywhere (`find . -type d -name
migration` → empty).

### F-DOCSREADME-4 · naming-conventions table, three stale rows · `docs/README.md:22-23,29`
| Line | Claimed | Actual |
|---|---|---|
| `:22` | Tracked repo directory `hydra/` | no `hydra/` at root → `kit/hydra/` |
| `:23` | Default impl `hydra-ts/src/` (via `hydra/scripts/*.sh`) | `kit/hydra-ts/src/` via `kit/hydra/scripts/` |
| `:29` | Wave marker `hydra/WAVE` | `kit/hydra/WAVE` (verified present) |

### F-DOCSREADME-5 · skill locations · `docs/README.md:24-25`
**Claim:** Lead skill `.claude/skills/hydra-protocol/`, setup skill
`.claude/skills/hydra-setup/`.
**Reality:** there is **no `.claude/` directory** in this repo at all. The
lead skill is `skills/hydra-swarm/SKILL.md` (verified). `hydra-setup` does
not exist anywhere — which is *consistent* with roadmap `:123` ("still not
built"), so the setup-skill row is doubly wrong (wrong path **and** the
thing it points to is unbuilt).

### F-DOCSREADME-6 · lead-skill read path · `docs/README.md:55`
**Claim:** first reading item is `../../.claude/skills/hydra-protocol/SKILL.md`.
Non-existent path (same root cause as F-DOCSREADME-5).

### F-DOCSREADME-7 · non-existent evidence/reports paths · `docs/README.md:5, :31, :80`
**Claim:** "`../hydra-reports/`" (`:5`), "Committed reports |
`docs/hydra-reports/`" (`:31`), "see `../hydra-reports/wave2-exit-report.md`"
(`:80`).
**Reality:** no `hydra-reports/` directory exists (see F-ROADMAP-1).

### F-DOCSREADME-N (note, not a defect) · version label · `docs/README.md:3`
"**Version:** 3.2" is a *doc-set* version, independent of the plugin version
`0.4.0` in `plugin.json`. No direct contradiction, but the two unconnected
version numbers could confuse a reader expecting them to track.

---

## 5. `plugin.json` + `marketplace.json` — PASS

### Version `0.4.0` is justified.
History (`git log -p -- .claude-plugin/plugin.json`): the file was `0.3.0` at
commit `4342833` ("enrich plugin.json metadata"), then bumped to `0.4.0` in
the run-0018 squash (`38a7d80`). The intervening squashes (runs 0008–0017)
delivered the Task #31 feature set (cancel-task, status, loop-detector, async
trigger). A minor bump 0.3.0 → 0.4.0 for that feature set is appropriate. ✅

### marketplace.json ↔ plugin.json consistency.
- `description` strings are **identical** (`marketplace.json:10` ==
  `plugin.json:4`). ✅
- marketplace plugin-entry `name` (`hydra-swarm`) == `plugin.json` `name`
  (`hydra-swarm`). ✅

### `/plugin install hydra-swarm@hydra-swarm` is viable against the current layout.
- `.claude-plugin/plugin.json` is at the **repo root** (correct location for a
  Claude Code plugin). ✅
- `marketplace.json` `source: "./"` resolves to the repo root, where
  `plugin.json` lives. ✅
- `marketplace.json` sits at `.claude-plugin/marketplace.json` (the location
  Claude Code discovers for a marketplace repo). ✅
- `commands/hydra-doctor.md` + `skills/hydra-swarm/` are at the root, matching
  what the plugin advertises. ✅

No findings in this section.

---

## 6. General sweep — pre-extraction paths (FINDINGS)

The sweep confirms a clean split: **design/review docs written during Task #31
use the correct `kit/`-prefixed paths**, while the **older normative docs still
use bare pre-extraction paths**.

### 6.1 Bare `hydra/scripts/` (should be `kit/hydra/scripts/`) — normative docs
These files use the bare prefix with **zero** correct `kit/hydra/scripts/`
occurrences:

- **`docs/operations.md`** — 21 stale occurrences: `:7, :15, :17, :18, :19,
  :20, :21, :23, :24, :25, :26, :35, :39, :40, :41, :76, :119, :133, :153,
  :154, :176`. (e.g. `:15` `bash hydra/scripts/run-init.sh 0042`).
- **`docs/vendor-adapters.md:24`** — "TypeScript adapters by default through
  the normal `hydra/scripts/*.sh` command…"
- **`docs/state-and-worktrees.md:29`** — "`hydra/scripts/<name>.sh` remains
  the stable operator command surface…"
- (Plus the roadmap/README instances already cited in §2–§3.)

### 6.2 `.claude/skills/…` references — non-existent (no `.claude/` dir in repo)
- **`docs/operations.md:5`** — "`../../.claude/skills/hydra-protocol/SKILL.md`"
  (the runbook's assumed lead-protocol entry point does not exist).
- **`docs/vendor-adapters.md:151`** — "Lead orchestration & usage-ledger skill
  (`.claude/skills/hydra-protocol/`)."
- **`docs/wave0-implementation.md:30`** — "`.claude/skills/hydra-protocol/`".
- (Plus the `docs/README.md` instances already cited in §4.)

### 6.3 Confirmed-clean (correct `kit/`-prefixed paths) — no action
These Task #31-era docs already use the post-extraction paths and need no
change (listed so the sweep is demonstrably complete, not skipped):
`docs/async-trigger-design-codex.md`, `docs/async-trigger-design-kimi.md`,
`docs/loop-detector-design-codex.md`, `docs/loop-detector-design-kimi.md`,
`docs/loop-detector-design-opencode.md`, `docs/opencode-review-async-trigger.md`,
`docs/opencode-review-cancel-task.md`, `docs/opencode-review-cancel-task-fix.md`,
and `skills/hydra-swarm/**` (uses `${CLAUDE_PLUGIN_ROOT}/kit/…` throughout).

---

## 7. Stale-language sweep (TODO/FIXME/"coming soon") — PASS

- **TODO/FIXME/XXX in code/docs:** none. The only `XXX` hits are
  `mktemp -d …XXXXXX` templates in `kit/hydra/tests/run-boundary-tests.sh:20`
  and `kit/hydra/tests/recovery-drill.sh:17` (false positives, not markers).
- **"still not built" / "designed but not built"** (`docs/roadmap.md:123, :221`)
  were **verified true**, not stale:
  - `bundle-export.sh`/`bundle-import.sh` — absent ✅ (claim correct)
  - `hydra-setup` skill — absent ✅
  - global ledger dir `~/.local/state/hydra/global` — absent ✅; no `global`
    mode in `aggregate-usage.{sh,ts}` ✅
  - `kit.manifest.yaml` — absent ✅
  - `verification.yaml.template` — absent ✅
- No "coming soon", "placeholder", or "not yet implemented" language that is
  contradicted by built code was found.

---

## Summary of actionable findings

| ID | Severity | Location | One-line |
|---|---|---|---|
| F-ROADMAP-1 | medium | `docs/roadmap.md:103` | `../hydra-reports/` + `../../hydra-ts/migration/` don't exist |
| F-ROADMAP-2 | low | `docs/roadmap.md:85` | bare `hydra/scripts/` (→ `kit/hydra/scripts/`) |
| F-ROADMAP-3 | low | `docs/roadmap.md:329` | bare `hydra/scripts/` shorthand |
| F-ROADMAP-4 | low | `docs/roadmap.md:6,333` | `docs/hydra-reports/` doesn't exist |
| F-ROADMAP-5 | low | `docs/roadmap.md:113-117,231` | `hydra-swarm-plugin/` prefix (now at repo root) |
| F-README-1 | low | `README.md:75` | layout root labeled `hydra-swarm-plugin/` (repo is `hydra-swarm`) |
| F-README-2 | low | `README.md:79-83` | `kit/` tree omits `kit/scripts/` |
| F-DOCSREADME-1 | high | `docs/README.md:11` | `hydra-ts/src/` (→ `kit/hydra-ts/src/`) |
| F-DOCSREADME-2 | high | `docs/README.md:12` | `hydra/scripts/` (→ `kit/hydra/scripts/`) |
| F-DOCSREADME-3 | medium | `docs/README.md:15` | `../../hydra-ts/migration/` doesn't exist |
| F-DOCSREADME-4 | high | `docs/README.md:22-23,29` | naming table: `hydra/`, `hydra-ts/src/`, `hydra/WAVE` all wrong |
| F-DOCSREADME-5 | high | `docs/README.md:24-25` | `.claude/skills/hydra-protocol` + `hydra-setup` don't exist |
| F-DOCSREADME-6 | medium | `docs/README.md:55` | `../../.claude/skills/hydra-protocol/SKILL.md` doesn't exist |
| F-DOCSREADME-7 | medium | `docs/README.md:5,31,80` | `hydra-reports/` paths don't exist |
| §6.1 | high | `docs/operations.md` (21×), `docs/vendor-adapters.md:24`, `docs/state-and-worktrees.md:29` | bare `hydra/scripts/` throughout |
| §6.2 | medium | `docs/operations.md:5`, `docs/vendor-adapters.md:151`, `docs/wave0-implementation.md:30` | `.claude/skills/` paths don't exist |

**Root cause (single):** `docs/README.md`, `docs/operations.md`,
`docs/vendor-adapters.md`, `docs/state-and-worktrees.md`, `docs/wave0-implementation.md`,
and `docs/roadmap.md` still describe the pre-extraction mono-repo layout
(`hydra/`, `hydra-ts/`, `.claude/skills/`, sibling `hydra-reports/`). The
Task #31-era design/review docs and `skills/hydra-swarm/**` were written after
extraction and already use the correct `kit/`-prefixed, `${CLAUDE_PLUGIN_ROOT}`
-relative paths. The fix is a mechanical sweep of those six normative docs.

**No defects found in:** the Task #31 roadmap entry (§1), roadmap date/consistency
(§1.1), the `/hydra-doctor` README section, `plugin.json` version (§5), or
`marketplace.json`/install viability (§5).
