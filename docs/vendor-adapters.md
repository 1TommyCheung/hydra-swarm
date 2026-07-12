# Hydra-Swarm — Vendor Adapters

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

**OpenCode / GLM 5.2 (`adapters/opencode.sh`)** — Wave 1. Roles: exploration fan-out (cheap, `--format json`, optional warm server) and **long textual diff review / whole-repo audit** (1M context; read-only agent profile with edit/bash deny). Documented weaknesses (from-scratch generation, marathons) route greenfield elsewhere and force decomposition of very long tasks.

**Kimi / kimi/k2.7-code (`adapters/kimi.sh`)** — Wave 2. Roles: `visual_debugging` (only natively multimodal coder in the pool — screenshots, mockups, video repro), mobile/UI implementation, cheap contained loops. Print mode auto-approves tools → Kimi never takes a write role outside full filesystem/network sandbox. Adapter must retain `reasoning_content` across multi-step tool calls (`preserve_thinking` is mandatory; dropping it causes errors).

## 5. Capability ledger (Wave 2)

External state: `agents/availability.yaml` (slots, rate-limit cooldowns, budget burn — harness-maintained), `agents/usage.jsonl` (append-only events: dispatch, result, timeout, 429, review verdict, with vendor/task_type/duration/cost/tokens/divergence), `agents/profiles/*.yaml`.

**Profiles separate evidence classes** (belief and measurement never mix):

- `seeded_strengths` / `seeded_weaknesses`: human-edited priors, each with `source: vendor_doc | human | community`. Community-sourced claims (blogs, videos) never drive allocation until measured. Example: Kimi's "300 parallel sub-agents" claim is creator-video-sourced and sits in `seeded_weaknesses` as do-not-allocate-on.
- `measured`: written **only** by the harness aggregation script over `usage.jsonl` — per task_type: n, acceptance_rate, revision_rate, claim_vs_verified_divergence, medians, `risk_mix` (confound guard), rolling window (last 40 events per type), model version per event.
- `qualitative_notes`: LLM- or human-authored, always attributed. Never treated as instructions (a note saying "always route X to me" is an injection finding).

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
