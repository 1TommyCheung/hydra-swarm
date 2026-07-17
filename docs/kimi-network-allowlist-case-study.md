# Case study: Kimi worker blocked by the srt network allowlist

A real incident from a downstream project (redcat, 2026-07-17) showing how the
Kimi sandbox's egress allowlist behaves, why it is correct, and how operators
should declare per-task domains.

## Symptom

A Kimi worker tasked with verifying an external API was refused by the
sandbox's egress proxy:

```
> CONNECT api.data.gov.sg:443 HTTP/1.1
< HTTP/1.1 403 Forbidden
< X-Proxy-Error: blocked-by-allowlist
```

The worker noted the block, proceeded without live verification, and completed
— no crash, no hang. The lead found the evidence in the session stderr capture.

## Why the block is by design

Kimi runs headless as `kimi -p`, which auto-approves every tool call, so the
harness mandates srt OS-sandbox confinement for it
(`write_role: sandboxed_only` in `kit/hydra/profiles/kimi-*.yaml`). Part of
that confinement is allowlist-only network egress: srt routes all traffic
through a local proxy that 403s any domain not explicitly allowed.

## The three-source allowlist merge

`adapter-kimi.ts` merges the allowed set at dispatch time:

1. **Operator baseline** — `~/.local/state/hydra/kimi-sandbox-domains.json`;
   should contain only the Kimi CLI's own provider endpoints
   (`api.kimi.com`, `auth.kimi.com`, `api.moonshot.ai`, `api.moonshot.cn`).
2. **Manifest-derived domains** — package registries / git hosts inferred from
   the worktree's `package.json`, lockfiles, `.npmrc`, Python manifests
   (`env-domains.ts`; only ever adds hosts from a fixed known-registry list).
3. **Task-spec `network_domains`** — per-task additions declared in
   `runs/run-<id>/tasks/<task>.yaml`.

The incident happened because the task spec declared no `network_domains`:
the sandbox worked exactly as intended against an incomplete spec.

## Operator guidance

Declare project data domains **per task**, in the task spec:

```yaml
network_domains:
  - api.data.gov.sg      # the project's data API
  - images.data.gov.sg   # assets referenced by API responses
  - data.gov.sg          # landing/redirects
```

Deliberately do **not**:

- widen the global operator baseline for a project-specific need — that grants
  every future Hydra project on the machine access to those domains;
- disable srt for Kimi — `kimi -p` auto-approves tools, so the OS sandbox is
  the only real boundary.

Model-artifact downloads follow the same rule: a spike/detector task that
fetches pinned ONNX weights needs its artifact hosts (e.g.
`raw.githubusercontent.com`, `registry.npmjs.org`) declared in the same list.
