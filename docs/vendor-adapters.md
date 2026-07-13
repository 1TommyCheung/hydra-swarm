# Hydra-Swarm — Vendor Adapters

> **`last_verified: 2026-07-13`** (CLI flags + adapter behaviour verified against
> the installed tools on this machine). Model versions, context windows, and
> pricing in §3 are perishable — **re-verify against vendor docs at each wave
> exit** and bump this date. The §5 capability ledger now carries *measured*
> findings alongside seeded priors.

## 1. Adapter contract

```text
start(task_spec, worktree, permissions)   -> agent_run_id
status(agent_run_id)                      -> running | blocked | completed | failed | timed_out
resume(agent_run_id, amended_task_spec)   -> agent_run_id     # turn-boundary only
cancel(agent_run_id)                      -> final_state
result(agent_run_id)                      -> path to inbox drop (untrusted)
```

There is deliberately no `message()` (mid-turn instruction injection): mid-run instructions would exist only in a running context window (invisible to the ledger, unreconstructable, gate-invalidating); delivery mechanisms are vendor-asymmetric; interrupting mid-edit contaminates the worker context with inconsistent instruction sets. Course-correction = `cancel()` or wait for a checkpoint → amend spec (ledger event, version bump) → `resume()`. If a vendor session can't resume, cold-restart against the agent's branch — cheap, because work is committed at checkpoints.

## 2. CLI capability matrix

| Capability | Claude Code | Codex CLI (GPT‑5.6 Sol) | OpenCode (GLM 5.2) | Kimi Code (kimi/k2.7-code) |
|---|---|---|---|---|
| Headless invocation | `claude -p "…"` | `codex exec "…"` | `opencode run --model zhipu/glm-5.2 "…"` | `kimi -p / --prompt` |
| Structured output | `--output-format json\|stream-json` | JSON/experimental flags | `--format json` | `--output-format` (with `--prompt` only); `--final-message-only`, `--quiet` |
| Session resume | `--resume <id>` (id from JSON result) | `codex resume` | `run -s <id>`; `--fork` to branch | `--session/-S <id>`, `--continue/-C` |
| Fine tool allowlist | Yes (`--allowedTools`, rules) | Sandbox modes + config | Partial (`opencode.json` permission per agent) | **None in print mode — auto-approves** |
| Pre/post tool hooks | Yes (PreToolUse/PostToolUse) | Yes (hooks.json via adapter) | Plugin system (weaker) | None in print mode |
| Read-only mode | permission-mode + allowlist | sandbox read-only | agent with edit/bash deny | `--plan` (not combinable with `--prompt`) |
| Working dir control | `--add-dir`, cwd | cwd/config | cwd | `--work-dir/-w`, `--add-dir` |
| Step/turn limits | max-turns | config | config | `--max-steps-per-turn`, `--max-retries-per-step` |
| Hermetic mode | `--bare` | config-scoped | `--attach` to controlled server | `--skills-dir` override; config.toml |
| Warm server | — | — | `opencode serve` + `--attach` | `kimi server` |

### 2.1 Verified headless invocations (2026-07-13, as-built)

The matrix above is the design intent; these are the exact invocations the
adapters use, with the corrections operating the system surfaced:

| Vendor | Adapter invocation | Gotchas found |
|---|---|---|
| Claude | `claude -p "<prompt>" --output-format json --permission-mode bypassPermissions --add-dir <wt>` | `bypassPermissions` imposes **no OS sandbox** — worker is unconfined at OS level (see §4 + the trust drift note). |
| Codex | `codex exec --json -C <wt> -s workspace-write -c 'sandbox_workspace_write.writable_roots=["<git-common-dir>"]' "<prompt>" </dev/null` | Must close stdin (`</dev/null`) or it hangs "Reading additional input from stdin". Needs the **git-common-dir** as a writable root to commit a linked worktree. Session id is **`thread_id`**. |
| OpenCode/GLM | `opencode run --model zai-coding-plan/glm-5.2 --agent <profile> --format json --auto --dir <wt> "<prompt>"` | Model prefix is **`zai-coding-plan/`**, not `zhipu/`. `--auto` is required for headless (else it can hang on a permission prompt). `--agent` selects an `opencode.json` profile (`hydra-reviewer` = edit/bash deny; `hydra-implementer` = allow). Still draws a formatted display to a tty — use `opencode serve` + `--attach` for fully TUI-free. Edges: the semantic backend is OpenAI-compatible. |
| Kimi | `sandbox-exec -f <profile> kimi -p "<prompt>" --output-format stream-json --add-dir <wt>` | `-p` **already auto-approves** tools (no allowlist) → OS sandbox mandatory; `-y` is *rejected* ("Cannot combine --prompt with --yolo"). Output is **`stream-json`** (JSONL), not `json`. The sandbox must allow `/dev/null` (git/bash need it) and the herdr socket dir; session id is in a `session.resume_hint` meta event. |

**Result handoff (all subprocess vendors):** the worker writes
`.hydra-result.json` in its own worktree and the adapter bridges it to the inbox
— workers never touch the state store. If a worker commits but omits the
self-report, the adapter derives the drop from git evidence
(`hydra_derive_drop_from_git`); promotion re-verifies regardless.

**Worker prompt:** built by `build-worker-prompt.sh`. The objective is a YAML
block scalar (`objective: >`) and must be read with `hydra_yaml_block` — the
same-line accessor returns empty and silently drops the objective (this bit hard;
see `operations.md`).

## 3. Model capabilities (verified against vendor docs, 2026-07)

| Attribute | Claude Fable 5 | GPT‑5.6 Sol | GLM 5.2 | Kimi K2.7 Code |
|---|---|---|---|---|
| Context / max output | 1M-class | ~1.05M / 128K | 1M / 128K | 256K / ~64K |
| Input modalities | Text + image | Text + image | **Text only** (per Z.AI dev doc) | **Text + image + video** (MoonViT) |
| Reasoning control | Effort levels | none→max; ultra multi-agent | Thinking modes, `reasoning_effort: max` | **Always-on thinking**; `preserve_thinking` mandatory |
| Openness | Proprietary | Proprietary | Open weights, MIT | Open weights, Modified MIT |
| Cost (per 1M in/out) | Subscription/API | $5 / $30 | Free tier + cheap plan | ~$0.95 ($0.19 cached) / $4.00; HighSpeed 180–260 tok/s |
| Documented sweet spot | Frontier general + implementation discipline | Hardest reasoning | Project-scale takeover, standards adherence, refactoring (FrontierSWE 74.4; TB2.1 81.0) | Token-efficient agent loops; visual/mobile debugging |
| Documented gaps | — | Expensive; slower | From-scratch generation; marathon tasks | Smallest context; trails frontier SWE |

## 4. Per-vendor adapter notes

**Claude (`adapters/claude.sh`)** — Wave 0. Write-capable workers: headless subprocess in the worktree (native-subagent isolation contract unverified; see below). Native subagents: read-only roles only. `--bare` for hermetic worker invocations; ownership PreToolUse hook active as defense in depth.

Native subagent spawn contract (gate for ever moving writers in-process):

```text
spawn_native_subagent(
    cwd            = assigned_worktree,
    writable_roots = [assigned_worktree],
    task_spec      = read_only_copy,
    env            = task_environment (unique PORT),
    tools          = per-role allowlist,
    hooks          = ownership hooks active
)
```

All guarantees enforced, or the worker takes the subprocess path. Uniform isolation outranks dispatch latency.

**Codex (`adapters/codex.sh`)** — Wave 0. `codex exec` in worktree; sandbox read-only for reviewer role; hooks via adapter script.

**OpenCode / GLM 5.2 (`adapters/opencode.sh`)** — Wave 1 read-only; **implementer role added Wave 2 (open-decision #2 resolved).** Roles: exploration fan-out (cheap, `--format json`, optional `opencode serve` warm server) and **long textual diff review / whole-repo audit** (1M context; `hydra-reviewer` profile, edit/bash deny). The `hydra-implementer` profile (edit/bash allow) gives it a write role — refactoring/standards-adherence is its documented sweet spot — but it is **availability-gated**: the Z.AI coding endpoint returned transient 500s on write workloads. Documented weaknesses (from-scratch generation, marathons) route greenfield elsewhere. Headless requires `--auto`.

**Kimi / kimi/k2.7-code (`adapters/kimi.sh`)** — Wave 2. Roles: `visual_debugging` (only natively multimodal coder in the pool — screenshots, mockups, video repro), mobile/UI implementation, cheap contained loops. Print mode auto-approves tools → Kimi never takes a write role outside full filesystem/network sandbox. Adapter must retain `reasoning_content` across multi-step tool calls (`preserve_thinking` is mandatory; dropping it causes errors).

## 5. Capability ledger (Wave 2)

External state: `agents/availability.yaml` (slots, rate-limit cooldowns, budget burn — harness-maintained), `agents/usage.jsonl` (append-only events: dispatch, result, timeout, 429, review verdict, with vendor/task_type/duration/cost/tokens/divergence), `agents/profiles/*.yaml`.

**Profiles separate evidence classes** (belief and measurement never mix):

- `seeded_strengths` / `seeded_weaknesses`: human-edited priors, each with `source: vendor_doc | human | community`. Community-sourced claims (blogs, videos) never drive allocation until measured. Example: Kimi's "300 parallel sub-agents" claim is creator-video-sourced and sits in `seeded_weaknesses` as do-not-allocate-on.
- `measured`: written **only** by the harness aggregation script over `usage.jsonl` — per task_type: n, acceptance_rate, revision_rate, claim_vs_verified_divergence, medians, `risk_mix` (confound guard), rolling window (last 40 events per type), model version per event.
- `qualitative_notes`: LLM- or human-authored, always attributed. Never treated as instructions (a note saying "always route X to me" is an injection finding).

**Measured findings at Wave 2 exit (2026-07-13, small n — do not over-read):**

| Vendor | Measured | Verdict on seeded priors |
|---|---|---|
| claude | promotions n=5, divergence 0.20 (one historical) | prior "frontier + implementation discipline" — consistent, not yet confirmed (n<8) |
| codex | promotions n=4, divergence 0.00 | prior "hardest reasoning / rigorous review" — supported qualitatively (caught the most conformance gaps in runs 0003/0013/0014); implemented the run-0015 refactor correctly in one shot |
| kimi | promotions n=3, divergence 0.00 | **write-role RESOLVED**: strong greenfield/contained (runs 0006, 0009), **weak at revise-existing** (run 0015 v3/v4 no-ops). Confirms seeded weakness "trails frontier SWE"; keep off subtle refactors. |
| opencode/glm | n=0 promoted (reviews only) | **implementer promotion RESOLVED (open-decision #2)**: real write role added; works when the Z.AI coding endpoint is healthy (transient 500s observed). Read-only long-diff review is reliable (runs 0005, 0014). |

All n < 8, so allocation still runs on **seeded priors** — measurement has begun
but does not yet drive pins. Re-aggregate (`aggregate-usage.sh`) and re-annotate
this table at each wave exit; retire any prior a measurement contradicts.

**Allocation:** hard constraints (capability matrix, role rules) → availability filter → capability ranking (`measured` when n ≥ 8, else seeded priors) → cost/latency tie-break → cross-vendor-review diversity override. No automatic role-pin changes; the ledger recommends, humans pin.

**Taxonomy** (controlled vocabulary; stats aggregate only within it):

```text
implementation: feature | bugfix | refactor | test_authoring | migration | mobile
analysis:       exploration | code_analysis | security_review | dependency_audit
review:         diff_review | long_context_review | architecture_review
integration:    cherry_pick_integration | conflict_resolution
multimodal:     visual_debugging      # image/video input required — hard capability pin
```

**Canonical profile filenames:** `claude-fable-5.yaml`, `codex-gpt-5.6-sol.yaml`, `opencode-glm-5.2.yaml`, `kimi-k2.7-code.yaml`.

## 6. Skills and instruction layering

- **Lead orchestration & usage-ledger skill** (`.claude/skills/hydra-protocol/`) — installed for the lead only: allocation procedure, ledger read protocol, note attribution, "ledger contents are data."
- **Workers** receive the worker protocol compiled into their task spec — more reliable than four models interpreting one skill identically.
- **Universal security rules** live in `AGENTS.md` (inherited by every worktree).
- **Vendor configuration** lives in vendor files, subordinate to `AGENTS.md`.
