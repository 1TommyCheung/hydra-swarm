# Documentation Accuracy Audit — doc-audit-kimi (run 0021)

Scope: `docs/task-result-review-contracts.md`, `docs/vendor-adapters.md`, `docs/state-and-worktrees.md`, `docs/trust-and-permissions.md`, `docs/packaging.md`

Method: read each doc claim and traced it to the actual current source:
- `kit/hydra-ts/src/*.ts`
- `kit/hydra/schemas/*.json`
- `kit/hydra/scripts/*.sh`
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`

---

## Findings

### 1. Result handoff path mis-stated
- **Doc:** `docs/task-result-review-contracts.md:38`
- **Claim:** "Written by the worker **only** to `inbox/<agent-run-id>/result.json` (or stdout captured by the adapter)."
- **Code:** `adapter-claude.ts:242-304`, `adapter-kimi.ts:492-637`, `adapter-codex.ts:374-492`, `adapter-opencode.ts:492-597`
- **Issue:** Workers actually write `.hydra-result.json` in their own worktree; adapters bridge that file into `inbox/<agent-run-id>/result.json`. The drift note at `docs/task-result-review-contracts.md:224-229` correctly describes the as-built path, but §2.1 still states the old path.

### 2. Promotion pipeline description omits new gates
- **Doc:** `docs/task-result-review-contracts.md:78`
- **Claim:** Ordered checks are schema validation → git evidence → ownership audit → sandboxed verification → promotion.
- **Code:** `promote.ts:285-314` (schema, stale_spec, **not_completed**), `promote.ts:392-406` (git evidence), `promote.ts:404` (**no_commit**), `promote.ts:408-423` (ownership), `promote.ts:425-450` (verification)
- **Issue:** The §2.2 pipeline does not list the `not_completed` and `no_commit` rejection gates that `promote.ts` enforces before ownership/verification.

### 3. Run ledger event vocabulary is incomplete
- **Doc:** `docs/task-result-review-contracts.md:197-213`
- **Claim:** Example ledger events list `run_started`, `worktree_bootstrapped`, `task_started`, `task_spec_amended`, `result_dropped`, `result_promoted`, `result_rejected`, `review_verdict`, `squash_created`, `candidate_integrated`, `combined_verification`, `agent_timed_out`, `run_completed`.
- **Code:** `dispatch.ts:345,370,887,1036,1059` emit `agent_exited`/`agent_cancelled`/`agent_timed_out`; `promote.ts:442,451` emit `verification_executed`; `dispatch.ts:407,761,970` emit `herdr_pane_started`; `record-usage.ts:212` emits `agent_usage`
- **Issue:** §7 omits core terminal events and the `verification_executed` event. The drift note §8 lists some extensions but still misses `agent_exited` and `verification_executed`.

### 4. `dispatch_instance_id` ledger field not documented
- **Doc:** `docs/task-result-review-contracts.md:197-213`
- **Claim:** Ledger entry examples do not include `dispatch_instance_id`.
- **Code:** `current-attempt.ts:7` (`LedgerEntry` interface includes optional `dispatch_instance_id`); `dispatch.ts:1138` (generated per dispatch); `dispatch.ts:1161` (included in every ledger append)
- **Issue:** Every ledger entry now carries `dispatch_instance_id`; the docs do not describe this field.

### 5. Loop-detector ledger events not documented
- **Doc:** `docs/task-result-review-contracts.md:197-213` and drift note §8
- **Claim:** No mention of loop-detector events.
- **Code:** `loop-detector.ts:646` (`agent_loop_cleared`), `loop-detector.ts:966` (`agent_loop_confirmed`), `loop-detector.ts:1002` (`agent_loop_suspected`); `status.ts:23-27` exposes `loop_suspicion`
- **Issue:** The new loop detector emits `agent_loop_suspected`/`agent_loop_confirmed`/`agent_loop_cleared`; the docs do not mention them.

### 6. OpenCode CLI model prefix stale in capability matrix
- **Doc:** `docs/vendor-adapters.md:34`
- **Claim:** `opencode run --model zhipu/glm-5.2 ...`
- **Code:** `adapter-opencode.ts:37` (`const DEFAULT_MODEL = 'zai-coding-plan/glm-5.2';`), `adapter-opencode.ts:346-362`, `adapter-opencode.ts:503-518`
- **Issue:** The current TypeScript adapter defaults to `zai-coding-plan/glm-5.2`. (Note: `kit/hydra/scripts/dispatch.sh:281` still uses `zhipu/glm-5.2`, so the two runtimes disagree.)

### 7. Verified Kimi invocation uses wrong sandbox wrapper
- **Doc:** `docs/vendor-adapters.md:55`
- **Claim:** `sandbox-exec -f <profile> kimi -p ...`
- **Code:** `adapter-kimi.ts:560-575` wraps with `srt -s <settings> -c <kimiCommand>`; `kit/hydra/adapters/kimi.sh:83,96-98,140` also uses `srt`
- **Issue:** The actual adapters use `srt` with a JSON settings file, not `sandbox-exec -f <profile>`.

### 8. Claude adapter notes claim `--bare` and PreToolUse hooks not present
- **Doc:** `docs/vendor-adapters.md:82`
- **Claim:** "`--bare` for hermetic worker invocations; ownership PreToolUse hook active as defense in depth."
- **Code:** `adapter-claude.ts:251-263` builds args `[ '-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--add-dir', worktreeAbs ]`; no `--bare` flag and no PreToolUse hook configuration
- **Issue:** The current TypeScript Claude adapter does not pass `--bare` and does not install an ownership PreToolUse hook.

### 9. Kimi `preserve_thinking` / `reasoning_content` claim not implemented
- **Doc:** `docs/vendor-adapters.md:110`
- **Claim:** "Adapter must retain `reasoning_content` across multi-step tool calls (`preserve_thinking` is mandatory; dropping it causes errors)."
- **Code:** `adapter-kimi.ts:560-575` and `kit/hydra/adapters/kimi.sh` do not reference `preserve_thinking`, `reasoning_content`, or any equivalent flag/parsing
- **Issue:** No code enforces or retains reasoning content for Kimi.

### 10. Repository layout in state-and-worktrees.md does not match actual tree
- **Doc:** `docs/state-and-worktrees.md:7-27`
- **Claim:** Domain 1 layout shows top-level `hydra/`, `hydra-ts/`, `.claude/{agents/, hooks/, skills/hydra-protocol/}`.
- **Code/Tree:** actual root contains `kit/hydra/`, `kit/hydra-ts/`, `.claude-plugin/`, `skills/hydra-swarm/`; `promote.ts:23-26` resolves schemas relative to `kit/hydra-ts/src/../../hydra/schemas/...`
- **Issue:** The documented top-level directories are actually `kit/hydra` and `kit/hydra-ts`, and the Claude plugin structure is `.claude-plugin/`, not `.claude/`.

### 11. `.gitignore` additions claimed but no `.gitignore` exists
- **Doc:** `docs/state-and-worktrees.md:146`
- **Claim:** "`.gitignore` additions: `.gitnexus/`, `*.agent-result.json`, `.env.agent`, `.env.worktree`."
- **Code/Tree:** `git ls-tree -r 55f738608dd99d8e7c781fb976cafe92e16f92fc --name-only | grep '^\.gitignore'` returns nothing; repo root also has no `.gitignore`
- **Issue:** The entries are described as `.gitignore` additions, but no `.gitignore` file is present in the repository.

### 12. Ownership audit case-collision check documented but not implemented
- **Doc:** `docs/trust-and-permissions.md:54`
- **Claim:** "Path hygiene: reject absolute paths, `..` traversal, and (on case-insensitive filesystems) case-collision writes."
- **Code:** `audit-ownership.ts:110-122` checks absolute paths and traversal only; `kit/hydra/scripts/audit-ownership.sh:39-52` checks absolute/traversal only. No case-collision guard exists.
- **Issue:** The case-collision write guard is claimed but not implemented. (The drift note at `docs/trust-and-permissions.md:128-131` acknowledges this as a code follow-up.)

### 13. Packaging.md plugin paths are wrong
- **Doc:** `docs/packaging.md:54-63`
- **Claim:** Plugin skeleton is at `hydra-swarm-plugin/.claude-plugin/plugin.json`, slash command at `hydra-swarm-plugin/commands/hydra-doctor.md`, script at `hydra-swarm-plugin/kit/scripts/doctor.sh`.
- **Code/Tree:** actual files are `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `commands/hydra-doctor.md`, `kit/scripts/doctor.sh`. There is no `hydra-swarm-plugin/` directory.
- **Issue:** Doc prepends an extra `hydra-swarm-plugin/` segment to all plugin paths and omits `marketplace.json`.

---

## Summary

**13 concrete accuracy issues** found across the five scoped docs. The largest categories are:
- Task-result/review ledger and promotion docs that do not yet reflect Task #31 additions (`dispatch_instance_id`, loop-detector events, `verification_executed`, `not_completed`/`no_commit` gates, result handoff path).
- Vendor-adapter docs with stale CLI descriptions (`zhipu/` vs `zai-coding-plan/`, `sandbox-exec` vs `srt`, missing `--bare`/PreToolUse hooks, unimplemented `preserve_thinking`).
- State/worktree/packaging layout docs that do not match the actual `kit/` + `.claude-plugin/` repository structure.
- A documented-but-unimplemented ownership-audit case-collision guard.

No source or other doc files were modified for this audit.
