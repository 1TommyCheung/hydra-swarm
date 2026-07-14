# Documentation accuracy audit: Hydra harness

Audit date: 2026-07-15  
Scope: `skills/hydra-swarm/SKILL.md`, all four files under
`skills/hydra-swarm/references/`, `docs/operations.md`, and
`docs/architecture.md`, checked against the current TypeScript harness, Bash
entry points/fallbacks, and task template.

## Summary

The audit found 18 issues. The most operationally significant are the stale
pre-extraction command paths in `docs/operations.md`, a second stale path in the
worktree bootstrap implementation that makes the documented bootstrap silently
skip its policy, an invalid relative inbox path in the skill's promotion
example, and legacy `--background` guidance that does not describe the default
TypeScript dispatcher's process lifetime. The cancellation syntax and clean
SIGTERM path, TypeScript status syntax, loop-detector event names, detector
vendor set, and run-init event were confirmed against source.

## Findings

### 1. High — `docs/operations.md` still uses pre-extraction executable paths

**Documentation claim.** The golden rule and command loop use
`hydra/scripts/*.sh`, the runtime implementation is said to live in
`hydra-ts/src/`, and later examples use `hydra/templates`, `hydra/tests`,
`hydra/profiles`, and `hydra/adapters`: `docs/operations.md:7-8`,
`docs/operations.md:15-26`, `docs/operations.md:35-41`,
`docs/operations.md:57`, `docs/operations.md:76`,
`docs/operations.md:97`, `docs/operations.md:119`,
`docs/operations.md:133`, `docs/operations.md:141`,
`docs/operations.md:153-157`, `docs/operations.md:165`,
`docs/operations.md:176`, and `docs/operations.md:196-197`.

**Source cross-check.** The entry points are under `kit/hydra/scripts/` and
exec TypeScript from `kit/hydra-ts/src/`; see
`kit/hydra/scripts/dispatch.sh:17-22`, `kit/hydra/scripts/status.sh:11-16`,
`kit/hydra/scripts/cancel-task.sh:7-12`, and
`kit/hydra/scripts/create-worktree.sh:20-25`. The standard tests are defined
from `kit/hydra-ts/` in `kit/hydra-ts/package.json:8-12`.

**Impact.** From the repository root, the examples fail because there is no
top-level `hydra/` or `hydra-ts/` directory. All of these paths need the `kit/`
prefix (or `${CLAUDE_PLUGIN_ROOT}/kit/...`). The lead-protocol pointer at
`docs/operations.md:5` is stale too: the scoped protocol is now
`skills/hydra-swarm/SKILL.md`, not
`../../.claude/skills/hydra-protocol/SKILL.md`.

### 2. High — the prescribed task template contains stale extraction-era paths and vendor scope

**Documentation claim.** Operators are told to instantiate tasks from the
current template and are told that `assigned_vendor` supports all four vendors:
`skills/hydra-swarm/SKILL.md:30-32` and `docs/operations.md:16-18`.

**Source cross-check.** The template still identifies itself and its schema
with `hydra-swarm-plugin/...`, limits its vendor comment to `claude | codex
(Wave 0)`, and makes only `hydra-swarm-plugin/**` inaccessible:
`kit/hydra/templates/task.example.yaml:1`,
`kit/hydra/templates/task.example.yaml:7-8`,
`kit/hydra/templates/task.example.yaml:16`, and
`kit/hydra/templates/task.example.yaml:23-26`. Current dispatch actually reads
the arbitrary `assigned_vendor` and resolves an adapter for it at
`kit/hydra-ts/src/dispatch.ts:211-220` and
`kit/hydra-ts/src/dispatch.ts:1120-1123`.

**Impact.** Following the documented template copies obsolete path protection
and misleading vendor guidance into every new task spec.

### 3. High — the documented worktree bootstrap is silently skipped after extraction

**Documentation claim.** `create-worktree.sh` is said to perform bootstrap, and
`HYDRA_WAVE >= 1` is said to activate the `wave_1` bootstrap:
`skills/hydra-swarm/SKILL.md:31` and `docs/operations.md:14-17`,
`docs/operations.md:57`.

**Source cross-check.** Both implementations still look for the policy at the
removed top-level path `hydra/policies/bootstrap.yaml`:
`kit/hydra/scripts/create-worktree.sh:68-85` and
`kit/hydra-ts/src/create-worktree.ts:276-283`. The actual policy is
`kit/hydra/policies/bootstrap.yaml`. Because both implementations guard the
bootstrap with a file-exists check, the current extracted repository skips it
without an error.

**Impact.** The documented run-loop guarantee is false in this checkout even
when `HYDRA_WAVE=2`; common and Wave-1 bootstrap steps do not run.

### 4. High — the skill documents Bash adapter routing as the default

**Documentation claim.** Dispatch is described as routing every vendor to
`${CLAUDE_PLUGIN_ROOT}/kit/hydra/adapters/<vendor>.sh`:
`skills/hydra-swarm/SKILL.md:32`.

**Source cross-check.** The default runtime is TypeScript unless the resolved
adapter runtime is exactly `bash`, and the selected paths are
`adapter-<vendor>.ts` for TypeScript versus `<vendor>.sh` for Bash:
`kit/hydra-ts/src/dispatch.ts:1105-1123`.

**Impact.** The routing description is wrong for normal operation. It should
name `kit/hydra-ts/src/adapter-<vendor>.ts` as the default and the Bash adapter
as the forced fallback.

### 5. High — the skill's promotion command uses an inbox path that is not resolvable as written

**Documentation claim.** The run loop gives
`promote.sh <run-id> <task> inbox/<agent-run-id>/result.json` as the promotion
command: `skills/hydra-swarm/SKILL.md:33`.

**Source cross-check.** Promotion tests the supplied path directly; it does not
resolve `inbox/...` relative to the run directory:
`kit/hydra-ts/src/promote.ts:252-275` and
`kit/hydra/scripts/promote.sh:33-44`. The inbox is actually under the external
run state assembled by dispatch at `kit/hydra-ts/src/dispatch.ts:1130-1135`.

**Impact.** From the repository root, the example fails with “inbox drop not
found.” It needs the absolute state-root path, as the separate example in
`docs/operations.md:21-22` already demonstrates.

### 6. High — `--background` guidance describes the Bash fallback, not the default TypeScript CLI

**Documentation claim.** `--background` is said to control whether the
`dispatch.sh` CLI waits for the worker before returning, and the reference gives
legacy pipe/redirection guidance for that mode:
`skills/hydra-swarm/references/background-dispatch.md:3-13` and
`skills/hydra-swarm/references/background-dispatch.md:22-30`.

**Source cross-check.** TypeScript background mode returns an in-process
completion handle without awaiting it, but the same CLI process retains the
live child process and polling timers until work completes:
`kit/hydra-ts/src/dispatch.ts:818-879` and
`kit/hydra-ts/src/dispatch.ts:1242-1265`. The immediate parent-exit behavior
described by the reference exists only in the Bash fallback, which backgrounds
`run_worker` at `kit/hydra/scripts/dispatch.sh:402-411`.

**Impact.** With the default TypeScript harness, a shell invoking
`dispatch.sh ... --background` remains resident as the supervisor; the shell
does not regain control merely because the exported `dispatch()` promise has
resolved. The recommended caller-backgrounded blocking command is still sound,
but the explanation and “legacy flag” section need to distinguish runtimes.

### 7. High — the universal ledger-field contract is false

**Documentation claim.** Every event is said to carry `task_id`,
`agent_run_id`, and `dispatch_instance_id`, with the last field “always present”
on TypeScript events:
`skills/hydra-swarm/references/ledger-and-recovery.md:9-18`.

**Source cross-check.** The shared TypeScript appender creates only `time`,
`event`, and `run_id` unless a caller supplies more fields:
`kit/hydra-ts/src/lib.ts:104-119`. For example, TypeScript run initialization
emits `run_started` with only `base_commit` added:
`kit/hydra-ts/src/run-init.ts:51-60`. `dispatch_instance_id` is injected only by
dispatch's private appender at `kit/hydra-ts/src/dispatch.ts:1158-1164`.
Likewise, the Bash appender has no automatic attempt or dispatch fields:
`kit/hydra/scripts/lib.sh:180-198`.

**Impact.** Readers built to the documented schema will reject valid run,
review, promotion, integration, and other non-dispatch events. The reference
should separate universal fields from task-event and dispatch-event fields.

### 8. Medium — the claimed TypeScript/Bash behavioral parity excludes new loop/status behavior

**Documentation claim.** The skill says the implementations have the same
argument/stdout/exit-code contract and that every Codex/Kimi/OpenCode dispatch
is monitored, with suspicion surfaced by `status.sh`:
`skills/hydra-swarm/SKILL.md:25`, `skills/hydra-swarm/SKILL.md:49`, and
`skills/hydra-swarm/SKILL.md:63-69`.

**Source cross-check.** The TypeScript path invokes the detector and exposes
`loop_suspicion` at `kit/hydra-ts/src/dispatch.ts:551-579` and
`kit/hydra-ts/src/status.ts:400-425`. The frozen Bash worker loops contain no
detector call (`kit/hydra/scripts/dispatch.sh:326-399`), and Bash status renders
no loop-suspicion field (`kit/hydra/scripts/status.sh:142-224`).

**Impact.** `HYDRA_HARNESS=bash` silently disables the documented detector and
changes status stdout. The docs should qualify these as TypeScript-only or stop
claiming full fallback contract parity.

### 9. Medium — `status.sh`'s `failed` state is materially narrower than the docs imply

**Documentation claim.** Status is documented as reporting the ledger-derived
states `running`, `completed`, `failed`, `cancelled`, `timed_out`, or `unknown`:
`skills/hydra-swarm/SKILL.md:49`.

**Source cross-check.** Any normal `agent_exited` event is classified as
`completed` regardless of a nonzero `exit_code`; `failed` is reserved only for
`reason=worker_disappeared`: `kit/hydra-ts/src/status.ts:118-131`. Dispatch
records ordinary adapter failures as `agent_exited` plus the exit code at
`kit/hydra-ts/src/dispatch.ts:362-366` and
`kit/hydra-ts/src/dispatch.ts:881-887`.

**Impact.** An adapter exit code of 1 is displayed as `completed`, which an
operator can reasonably read as success. The docs need to define the state
mapping and tell operators to inspect `exit_code`, or the implementation needs
a failure mapping.

### 10. Medium — `HYDRA_HARD_CAP_MIN` is a public control but is missing from the environment table

**Documentation claim.** The table at `docs/operations.md:51-70` presents the
operational environment surface, and status is documented as showing a hard-cap
budget at `skills/hydra-swarm/SKILL.md:49`.

**Source cross-check.** `HYDRA_HARD_CAP_MIN` changes both plain and pane-hosted
dispatch limits at `kit/hydra-ts/src/dispatch.ts:846-861` and
`kit/hydra-ts/src/dispatch.ts:992-1017`, and status reports the same override at
`kit/hydra-ts/src/status.ts:369-371`.

**Impact.** Operators cannot discover how to configure the displayed absolute
cap from the runbook. The default is `timeout_minutes * 6`.

### 11. Medium — two additional operator-facing overrides are undocumented

**Documentation claim.** The operational environment surface is enumerated at
`docs/operations.md:51-70`.

**Source cross-check.** `HYDRA_GITNEXUS_REPO` overrides the code-intelligence
repository id at `kit/hydra/scripts/code-intel.sh:34-40`, and
`HYDRA_HERDR_PANE` supplies the fallback lead pane at
`kit/hydra/scripts/herdr-push.sh:63-70`. Neither appears anywhere in the scoped
documentation.

**Impact.** Two supported operational controls are invisible to operators.
Internal transient variables such as `HYDRA_PANE`, `HYDRA_VENDOR`,
`HYDRA_STATE`, and `HYDRA_SOCK` were not counted as omissions because scripts
set them for their own subprocesses rather than exposing them as operator
configuration.

### 12. Medium — the concurrency cap is not limited to background dispatches

**Documentation claim.** `HYDRA_MAX_CONCURRENCY` is described as a
“Backgrounded-dispatch slot cap,” and the concurrency section likewise says
backgrounded dispatches wait:
`docs/operations.md:63` and `docs/operations.md:182-184`.

**Source cross-check.** Slot acquisition is unconditional and occurs before the
code branches on `options.background`: `kit/hydra-ts/src/dispatch.ts:1236-1256`.
The Bash fallback also calls `acquire_slot` in both branches:
`kit/hydra/scripts/dispatch.sh:402-409`.

**Impact.** Foreground/blocking dispatches also queue behind the cap and emit
`concurrency_wait`; the docs understate where queueing can occur.

### 13. Medium — the documented authoritative-state location ignores `XDG_STATE_HOME`

**Documentation claim.** Authoritative state is stated to live under
`~/.local/state/<repo-id>-hydra/...`:
`skills/hydra-swarm/references/ledger-and-recovery.md:3` and
`skills/hydra-swarm/SKILL.md:10`.

**Source cross-check.** The state helper uses `HYDRA_STATE_ROOT` when set, then
`${XDG_STATE_HOME}`, and only then defaults to `$HOME/.local/state`:
`kit/hydra/scripts/lib.sh:140-149`.

**Impact.** Recovery instructions can point to the wrong ledger on systems
with XDG state configured. The reference should express the default as
`${XDG_STATE_HOME:-$HOME/.local/state}/<repo-id>-hydra` and mention the already
documented `HYDRA_STATE_ROOT` override.

### 14. Medium — the reference's “full test suite” command is stale

**Documentation claim.** The full suite is given as
`cd hydra-swarm-plugin/kit/hydra-ts && node --experimental-strip-types --test
'test/**/*.test.ts'`, followed by historical advice about a 26-test promotion
flake: `skills/hydra-swarm/references/ts-bash-switch.md:23-29`.

**Source cross-check.** The current package is already rooted at
`kit/hydra-ts/`, and its supported full-suite command is `npm test`, which runs
the non-promotion files and then `promote.test.ts` explicitly:
`kit/hydra-ts/package.json:8-12`.

**Impact.** The documented `cd` fails from this repository root, while the raw
glob bypasses the package's deliberate flake workaround. The reference should
use `cd ${CLAUDE_PLUGIN_ROOT}/kit/hydra-ts && npm test`.

### 15. Low — the Herdr pane “default” is actually opt-in

**Documentation claim.** Operators are told to keep
`HYDRA_HERDR_PANES=1` “as the default”:
`skills/hydra-swarm/references/vendor-dispatch.md:3`.

**Source cross-check.** TypeScript enables panes only when the variable is
explicitly equal to `1`: `kit/hydra-ts/src/dispatch.ts:1072-1088`. The Bash
fallback uses the same explicit opt-in at
`kit/hydra/scripts/dispatch.sh:326-363`.

**Impact.** Unset does not mean enabled. If this is a recommended operating
default rather than a harness default, the wording should say so explicitly.

### 16. Low — the OpenCode monitor displays a model id the runbook says is invalid

**Documentation claim.** The working OpenCode id is documented as
`zai-coding-plan/glm-5.2`, explicitly not `zhipu/...`:
`docs/operations.md:68`.

**Source cross-check.** The actual TypeScript adapter agrees and defaults to the
documented id (`kit/hydra-ts/src/adapter-opencode.ts:37`), but dispatch's monitor
banner defaults to `zhipu/glm-5.2` at `kit/hydra-ts/src/dispatch.ts:732-737`.
The Bash monitor has the same stale display default at
`kit/hydra/scripts/dispatch.sh:274-286`.

**Impact.** Worker execution uses the right default, but the operator-facing
monitor reports the wrong one, directly contradicting the runbook.

### 17. Medium — architecture's task-state vocabulary is not the implemented status/event model

**Documentation claim.** Task states are enumerated as `planned`, `ready`,
`running`, `blocked`, `completed_unreviewed`, `revision_required`, `accepted`,
`rejected`, `integrated`, and `verified`, with every transition said to be a
ledger event: `docs/architecture.md:121`.

**Source cross-check.** The implemented task status vocabulary is `running`,
`completed`, `failed`, `cancelled`, `timed_out`, and `unknown`:
`kit/hydra-ts/src/status.ts:29-45`. It is reconstructed specifically from
`task_started`, `agent_exited`, `agent_cancelled`, and `agent_timed_out` at
`kit/hydra-ts/src/status.ts:54-55` and `kit/hydra-ts/src/status.ts:118-132`.
The architecture's own drift note concedes that state is inferred rather than
asserted, but discusses the run state field rather than correcting this task
list: `docs/architecture.md:154-161`.

**Impact.** Consumers cannot observe the named architecture states through
`status.sh`, and there are no one-for-one transition events with those names.
The normative vocabulary should be labeled conceptual and mapped to concrete
events, or updated to match the implemented view.

### 18. High — the skill's absolute worker/state-store boundary is false for Claude

**Documentation claim.** The skill says workers “cannot reach the state store
at all,” and architecture's normative section repeats that as a real worker
boundary: `skills/hydra-swarm/SKILL.md:10` and
`docs/architecture.md:62-64`.

**Source cross-check.** The default Claude adapter launches with
`--permission-mode bypassPermissions` and no OS sandbox:
`kit/hydra-ts/src/adapter-claude.ts:249-268`; the Bash adapter says its real
boundary is the post-hoc audit at `kit/hydra/adapters/claude.sh:34-48`.
Architecture later acknowledges exactly this exception at
`docs/architecture.md:139-148`, but the skill does not.

**Impact.** The lead protocol overstates confinement for one of the four
vendors. It should carry the same vendor-asymmetric caveat as architecture's
drift note.

## Confirmed claims

The following high-risk claims in scope matched current source:

| Documentation claim | Documentation | Source confirmation |
|---|---|---|
| `status.sh <run> <task> [--lines N] [--json]`, default 20 progress lines, last five attempt events | `skills/hydra-swarm/SKILL.md:43-49` | `kit/hydra-ts/src/status.ts:356-425`, `kit/hydra-ts/src/status.ts:429-467` |
| `cancel-task.sh <run> <task> [--wait-seconds N]`, default 15 seconds, SIGTERM then guarded SIGKILL, and no fabricated ledger event | `skills/hydra-swarm/SKILL.md:53-61` | `kit/hydra-ts/src/cancel-task.ts:250-266`, `kit/hydra-ts/src/cancel-task.ts:336-441`, `kit/hydra-ts/src/cancel-task.ts:448-475` |
| Detector vendors are Codex, Kimi, and OpenCode; Claude is excluded | `skills/hydra-swarm/SKILL.md:63-69` | `kit/hydra-ts/src/loop-detector.ts:99-120`, `kit/hydra-ts/src/loop-detector.ts:701-720` |
| Detector event names are `agent_loop_suspected`, `agent_loop_confirmed`, and `agent_loop_cleared` | `skills/hydra-swarm/references/ledger-and-recovery.md:24-31` | `kit/hydra-ts/src/loop-detector.ts:639-653`, `kit/hydra-ts/src/loop-detector.ts:938-982`, `kit/hydra-ts/src/loop-detector.ts:985-1018` |
| Confirmation auto-cancels through the dispatch recorder | `skills/hydra-swarm/SKILL.md:67-71` | `kit/hydra-ts/src/dispatch.ts:551-573`, `kit/hydra-ts/src/dispatch.ts:330-370` |
| `run-init.sh <run-id>` creates run state and emits `run_started` | `skills/hydra-swarm/SKILL.md:29` | `kit/hydra/scripts/run-init.sh:21-51` |
| TypeScript is selected for every `HYDRA_HARNESS` value except exactly `bash`; adapter override precedence is as documented | `skills/hydra-swarm/references/ts-bash-switch.md:1-13` | `kit/hydra/scripts/dispatch.sh:17-23`, `kit/hydra-ts/src/dispatch.ts:1105-1110` |
| OpenCode runs as a plain subprocess with a separate monitor pane | `skills/hydra-swarm/references/vendor-dispatch.md:12-14` | `kit/hydra-ts/src/dispatch.ts:732-798`, `kit/hydra-ts/src/dispatch.ts:1072-1089` |

## Scope disposition

- `skills/hydra-swarm/SKILL.md`: issues found (findings 2, 4, 5, 8, 9, 13,
  and 18).
- `skills/hydra-swarm/references/background-dispatch.md`: issue found
  (finding 6).
- `skills/hydra-swarm/references/ledger-and-recovery.md`: issues found
  (findings 7 and 13); event names confirmed.
- `skills/hydra-swarm/references/ts-bash-switch.md`: issue found (finding 14);
  runtime-selection semantics confirmed.
- `skills/hydra-swarm/references/vendor-dispatch.md`: issue found (finding 15);
  vendor hosting shapes confirmed.
- `docs/operations.md`: issues found (findings 1-3, 10-12, 14, and 16).
- `docs/architecture.md`: issues found (findings 17 and 18); its later drift note
  already correctly documents the Claude confinement exception.
