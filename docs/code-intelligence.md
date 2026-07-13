# Hydra-Swarm — Code Intelligence (Wave 1+ only)

Nothing in this document is implemented in Wave 0.

## 1. Purpose and tool selection

| Need | Tool |
|---|---|
| Dependency and blast-radius analysis | GitNexus (Wave 1) |
| Call-chain and execution-flow inspection | GitNexus (Wave 1) |
| Code + specifications + diagrams | Graphify (Wave 2) |
| Design-to-implementation traceability | Graphify (Wave 2) |
| Precise changed lines and history | Git |
| Behavioural correctness | Tests and runtime verification |

**The two graph tools are complementary, not redundant** (see §5 for how the
harness uses both): GitNexus gives *structure* (AST symbols, call chains,
blast-radius) but — as-built — only parses **JavaScript** into symbols; the bash
harness is file-level-only there. Graphify gives *intent* (semantic edges over
code **and** docs, incl. bash + markdown) with an EXTRACTED/INFERRED/AMBIGUOUS
confidence audit trail. GitNexus answers "what does this change structurally
touch"; Graphify answers "does this change still match approved design intent".

## 2. GitNexus (Wave 1)

### 2.1 Index custody: harness-generated, post-freeze (normative)

A worker-writable `.gitnexus/` inside the worktree would let a worker shape the index that later informs its own review. Therefore indexes that participate in review are **harness-generated after the candidate is frozen**:

1. Worker completes and commits; dispatch ends.
2. Harness revokes/stops worker access to the worktree.
3. Harness confirms clean worktree and expected HEAD.
4. Harness deletes or ignores any worker-created graph artifacts.
5. Harness builds a fresh index.
6. Harness writes the manifest to external state.
7. Reviewers query only that harness-generated index.

Preferred index location — external state, keyed by commit:

```text
<external-state>/indexes/gitnexus/<repo-id>/<commit-sha>/
```

If GitNexus requires its index inside the worktree, the harness rebuilds it post-freeze and marks the directory read-only for the review phase. Workers *may* run their own throwaway indexing mid-task for their own navigation; such indexes never feed review.

### 2.2 Index manifest and freshness gate

```yaml
worktree: run-0042-canvas-validation
indexed_commit: ca827d1
working_tree_dirty_at_index: false
indexer_version: <ver>
created_at: <ts>
```

A graph result participates in review only if `current HEAD == indexed_commit` **and** the working tree is clean; otherwise re-index. "Index identity equals HEAD" holds only at index time.

### 2.3 Logical indexes and comparisons

```text
baseline/<base-sha> · candidate/<task-id>/<head-sha> · hydra-integration/<run-id>/<head-sha>
```

Baseline identifies pre-existing structure; candidate the branch's result; integration the combined structure. Integration worktree re-indexes after each applied candidate (incremental where reliable, full rebuild where ambiguous) before smoke verification.

### 2.4 Authority

`detect_changes` and graph queries produce **risk inputs**; the reviewer's classification, grounded in diff + tests, is authoritative. Static coverage is incomplete for generated code, reflection, DI, dynamic imports, macros, and external services. Absence of an edge is not proof of absence of a dependency.

## 3. Graphify (Wave 2)

- Built at run baseline over code + docs + diagrams; refreshed at integration only when design artifacts changed; never per-candidate (LLM cost; the provider sees document content during the semantic pass — code-only mode available where that matters).
- Storage: external state (`indexes/graphify/`), run-scoped by default.
- **Confidence policy (normative):**
  - `INFERRED` edge → never blocking; review questions only.
  - `EXTRACTED` edge → may open a **blocking investigation** (integration pauses pending a check).
  - An actual **blocking verdict** requires confirmation from source, diff, tests, or reproducible behavior. Graph data identifies where to look; it never independently stops integration.
- Primary consumers: documentation-conflict detection and the "does the implementation still match approved design intent" combined-review question.

## 4. As-built drift notes (audit 2026-07-13)

- **§2.1 GitNexus custody — the flag matters.** The harness index is built with
  `gitnexus analyze --skip-agents-md --skip-skills --name hydra-<run>-<task>
  --allow-duplicate-name <worktree>`. `--skip-agents-md`/`--skip-skills` prevent
  it mutating tracked files (which would dirty the frozen worktree); `--name`
  registers it so reviewers can target it with `detect-changes -r`. **`--index-only`
  was wrong** — it skips registration too, leaving nothing to query. The index is
  copied to external custody keyed by commit and the in-worktree `.gitnexus/` is
  marked read-only for the review phase. The freshness gate (index == HEAD + clean
  tree) is enforced by `freshness-gate.sh` before any query.
- **§2.4 authority — upheld.** `graph-impact.sh` emits `graph_impact` with
  `advisory:true`; a stale index is omitted, never a blocker.
- **§3 Graphify — as-built specifics.** Built via `graphify extract --backend
  claude|kimi` (LLM key required). Output is networkx node-link JSON: **edges are
  under `.links`** (not `.edges`), each with `confidence: EXTRACTED | INFERRED |
  AMBIGUOUS` and a `confidence_score`. The investigation policy maps directly:
  EXTRACTED → blocking investigation (requires source/diff/test confirmation),
  INFERRED/AMBIGUOUS → review question only. A Kimi coding-plan key works via an
  in-memory base-URL + `kimi-code-cli` User-Agent patch (installed package
  untouched) — see `graphify-baseline.sh`. Storage is run-scoped external
  (`indexes/graphify/<repo-id>/run-<id>/`). Confirmed non-blocking end-to-end in
  run 0006 (`graphify_investigation advisory:true`).

## 5. Combined layer — using both together (as-built 2026-07-13)

Two harness scripts make GitNexus and Graphify a single code-intelligence layer.

### 5.1 The standing repo graph — `graphify-repo.sh`
`graphify-baseline.sh` is run-scoped and ephemeral (one candidate's
investigation). `graphify-repo.sh` maintains a **persistent** semantic graph over
the whole repository — code **and** docs, including the bash harness and markdown
GitNexus can't parse into symbols. Stored in `graphify-out/` (gitignored — the
tool's default location, so queries need no flags). Verbs: `build` (full semantic
extraction; LLM-backed, timeout-guarded), `update` (AST-only, cheap), `query`,
`status` (freshness vs HEAD). This is the substrate for design-to-implementation
traceability over Hydra itself.

### 5.2 The combined query/audit tool — `code-intel.sh`
Routes each question to the right tool per §1 and surfaces both, **each labelled
with its source and authority**:

| Subcommand | GitNexus (structure, RISK INPUT) | Graphify (intent, INVESTIGATION-NOT-VERDICT) |
|---|---|---|
| `changed [--base ref]` | `detect-changes` → changed symbols + affected flows (JS) | design-intent edges touching the diff (EXTRACTED→investigate, INFERRED→question) |
| `impact <symbol>` | blast-radius (JS) | semantic neighbours (all langs + docs) |
| `query "<q>"` | execution flows | semantic hits |
| `drift` | (confirms the code side exists) | **docs-vs-code**: EXTRACTED edges linking a `docs/` node to a `hydra/`\|`src/` code node — the design's explicit references to implementation, flagged to confirm |

`drift` is the showcase of "both": Graphify finds the `architecture.md §X →
promote.sh` design→implementation edges (GitNexus can't — no bash symbols, no
docs), and GitNexus confirms the code side is structurally real. It is exactly
the manual drift audit (roadmap doc-maintenance checklist), made queryable.

### 5.3 Authority is unchanged (roadmap success criterion #6)
Neither tool independently blocks or approves. GitNexus output is a **risk input**
(§2.4); Graphify is **investigation-not-verdict** (§3) — EXTRACTED opens an
investigation requiring source/diff/test confirmation, INFERRED is a question.
`code-intel.sh` presents; the reviewer (lead/human) decides.

### 5.4 Coverage reality
`gitnexus analyze` indexes all repo files (incl. 32 harness `.sh` files) but
parses only **JS** into symbols (call-graph/impact is JS-only). Graphify's
semantic pass covers bash + markdown, so the standing graph is where harness- and
doc-level reasoning lives. The Graphify build is LLM-backed and endpoint-gated —
if the semantic backend is unavailable, the standing graph is simply absent and
`code-intel.sh` degrades to the GitNexus half (never fatal).
