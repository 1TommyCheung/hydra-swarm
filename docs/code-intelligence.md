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
