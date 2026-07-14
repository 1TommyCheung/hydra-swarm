# Hydra-Swarm — License Recommendation

> **Task:** `license-research-opencode` (run 0002). Independent research brief on
> what license Hydra-Swarm should adopt, given three goals: (a) free/open use for
> non-commercial and individual-developer use, (b) a commercial
> licensing/monetization path for organizations, and (c) eventual listing on a
> Claude Code plugin marketplace.
>
> **Date:** 2026-07-14 · **Author:** research worker (OpenCode/GLM) ·
> **Status of repo today:** private, **no `LICENSE` file**, `.claude-plugin/plugin.json`
> declares **no `license` field**. Every recommendation below is a forward choice,
> not a change to existing licensed code.

---

## TL;DR — the recommendation

1. **Primary: license the core plugin under `Apache-2.0`.** Monetize via
   **open-core** — a separate, *additively-licensed* Enterprise Edition (managed
   control-plane, enterprise policy engine, SLA'd vendor-adapter updates, support)
   governed by its own `LICENSE-ENTERPRISE` plus a **trademark policy** that stops
   third parties from branding a hosted offering as "Hydra-Swarm."
2. **Alternative, if you insist the code itself must be the paid product:**
   `PolyForm-Noncommercial-1.0.0` for the core, with a separately advertised
   commercial license. It is the only one of the three "source-available"
   candidates whose threat model actually matches goal (a)+(b).
3. **Explicitly *not* recommended for Hydra-Swarm:** `BSL-1.1`,
   `Elastic-2.0`, and `SSPL`. Their threat models target **hosted-service
   commoditization by cloud providers** — a risk that barely exists for a *local*
   orchestration harness. Worse, `Elastic-2.0` is **not a non-commercial license
   at all** (internal commercial use is allowed), so it would not even achieve
   goal (b). Details in §3.

The rest of this document justifies that call, point by point.

---

## 1. The specific license recommendation

| | Choice | SPDX id |
|---|---|---|
| **Core plugin** (skills, commands, `kit/`, harness, adapters, docs) | Apache License 2.0 | `Apache-2.0` |
| **Enterprise modules** (anything you build later that is not in the free kit — managed control-plane, enterprise policy engine, premium adapters, telemetry/observability backend) | Proprietary / separate commercial license (`LICENSE-ENTERPRISE`) | n/a |
| **Brand** ("Hydra-Swarm" name/logo) | A short **trademark policy** (grant a narrow usage right to the OSS project, reserve hosted/commercial branding) | n/a |

Concrete mechanics:

- `LICENSE` = full Apache-2.0 text. `NOTICE` file for attribution. Add
  `"license": "Apache-2.0"` to `.claude-plugin/plugin.json` and the marketplace
  entry (the marketplace `license` field takes an SPDX id; MIT/Apache-2.0 are the
  examples the docs give — see §2).
- Keep a `TRADEMARK.md` that says: anyone may use the name "Hydra-Swarm" to refer
  to the upstream project; **no one may ship a hosted/managed product called
  "Hydra-Swarm"** without written permission. This is the cheap, effective
  substitute for a code-license restriction when your real fear is brand
  confusion rather than code copying. (This is exactly how Mozilla, Let's
  Encrypt, and most foundations separate code freedom from brand control.)
- Dual-license any *future* Enterprise module: it ships under a commercial
  license only, and is excluded from the Apache-2.0 `kit/`. The free kit remains
  genuinely useful on its own (this is the "open-core" bargain — see GitLab,
  Grafana, PostHog, Supabase).

> **Why Apache-2.0 over MIT:** Apache-2.0 adds an **express patent grant** and a
> patent-retaliation clause. Hydra-Swarm is unlikely to carry patents today, but
> Apache-2.0 is the license the ecosystem (and the marketplace examples) names
> first, and it is what a cautious enterprise legal team will sign off on fastest.
> MIT is a fine fallback; the difference is immaterial to the recommendation.

---

## 2. Is this compatible with Claude Code marketplace listing? (yes — and the premise of the question is looser than the brief assumed)

The brief worried that the marketplace "leans toward expecting a plain permissive
open-source license (MIT or Apache-2.0)." Having read the actual marketplace
documentation ([code.claude.com/docs/en/plugin-marketplaces][mp]), that worry is
**only half right, and the half that matters is favorable:**

- **There is no permissive-license requirement to be listed.** The `license`
  field on a plugin entry is **optional** metadata documented as
  *"SPDX license identifier (for example, MIT, Apache-2.0)"*. MIT and Apache-2.0
  are *examples of SPDX identifiers*, not a stated requirement. Nothing in the
  schema, the hosting model, or the install flow rejects a source-available or
  non-commercial license.
- **There is no app-store review gate at all.** A "marketplace" is literally any
  git repo with a `.claude-plugin/marketplace.json`. Anthropic publishes one
  (reserved names like `claude-code-marketplace` are blocked from third-party
  use), but **anyone can host their own** ([§"Host and distribute marketplaces"][mp]).
  Anthropic does not curate third-party marketplace contents for license
  ideology. So even if a future official catalog were to add a policy, a
  self-hosted `hydra-swarm` marketplace is always an escape hatch.
- **Practical reality:** large, trusted plugins already ship mixed licenses and
  self-hosted catalogs; the install path (`/plugin marketplace add owner/repo`
  then `/plugin install …`) is license-agnostic. A non-commercial license
  *technically lists fine*.

So: **there is no hard conflict between a non-commercial-restricted license and
being installable via a Claude Code marketplace.** What you actually trade away
with a restrictive license is not *listability* — it is *trust, adoption, and the
"open source" label* (§3, §4). That is a real cost, but it is a different cost
than the brief framed.

**How real projects resolve the "I want to monetize but also be listable/trusted"
tension** — all of these are compatible with marketplace listing because listing
doesn't care:

- **Open-core (recommended here):** permissive core + proprietary enterprise
  surface. GitLab (MIT core / Enterprise Edition proprietary), Grafana (AGPL core
  + Grafana Cloud), PostHog, Supabase. The *listed/installable* artifact is the
  permissive core; commercial value lives in a service or add-on modules.
- **Dual-license:** same codebase offered under a copyleft/permissive license to
  the community and a commercial license to paying customers (Qt, Sentry's older
  model, MongoDB pre-2018). Workable but heavier to operate.
- **Tradmark/brand restriction instead of code restriction:** the code is fully
  permissive; you reserve the *name*. Cheap and common for dev tools whose risk
  is "someone relaunches my thing as a hosted product under my brand" rather than
  "someone copies my code."

My recommendation (§1) is **open-core + trademark** precisely because it removes
even the *soft* friction (nagging doubt, "is this really open source?") while
preserving every monetization lever that matters for Hydra-Swarm.

[mp]: https://code.claude.com/docs/en/plugin-marketplaces

---

## 3. The candidate licenses — and a correction to the brief

The brief groups "BSL/BUSL, Elastic License 2.0 / SSPL, PolyForm Noncommercial /
PolyForm Shield" together as "non-commercial free, commercial paid." **That
grouping conflates three materially different threat models.** Getting this right
changes the recommendation, so it is worth being precise.

| License | What it actually restricts | Allows internal commercial use? | Achieves goal (b)? |
|---|---|---|---|
| **PolyForm Noncommercial 1.0.0** ([text][pfnc]) | All **commercial** use; permits noncommercial, personal, and noncommercial-org use | **No** — commercial use requires a separate paid license | **Yes** — this is the only candidate that cleanly says "free for non-commercial, paid for commercial" |
| **Elastic License 2.0** ([text][el]) | Only **providing the software to third parties as a hosted/managed service**, plus license-key circumvention | **Yes** — internal commercial use at a for-profit is fully allowed | **No** — a company can run it internally for profit for free; you only capture cloud-resellers |
| **SSPL** | Offering the software (or the surrounding management/security stack) **as a service to third parties** | **Yes** | **No** — same as Elastic, more aggressive |
| **Business Source License 1.1** ([text][bsl]) | **Production use** unless covered by an "Additional Use Grant" or a purchased commercial license; **auto-converts** to a GPL-compatible license on the Change Date or 4th anniversary | Only if you grant it; otherwise no | **Yes, temporarily** — but the 4-year conversion eventually gives the work away as OSS |

Three corrections to the brief's framing:

1. **Elastic-2.0 / SSPL are *not* non-commercial licenses.** A for-profit company
   using Elasticsearch *internally* pays nothing and is fully compliant. These
   licenses exist to stop **AWS-equivalents from offering your software as a
   managed cloud service**. They are the wrong tool if your goal (b) is "charge
   organizations that use Hydra-Swarm internally." Adopting Elastic-2.0 would
   *fail goal (b) outright* while still carrying the "not open source" stigma.
2. **BSL's 4-year auto-conversion is a feature for products with a predictable
   shelf-life moat** (a database that, in 4 years, will be far ahead of any fork).
   For Hydra-Swarm, whose moat is *adapter maintenance against four moving vendor
   CLIs* (see §5), 4 years is not a comfortable horizon — you'd be handing the
   orchestration layer to the community exactly when the work is hardest.
3. **Only PolyForm Noncommercial actually expresses goal (a)+(b) in license
   terms.** If you want a restrictive license, *this* is the candidate — not BSL,
   not Elastic.

[pfnc]: https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html
[el]: https://www.elastic.co/licensing/elastic-license
[bsl]: https://mariadb.com/bsl11/

---

## 4. Tradeoffs: what a restrictive license costs vs. protects

### What it protects (the upside of PolyForm NC / BSL)

- A **legal lever** to charge commercial users. If a company wants to run
  Hydra-Swarm internally for profit, the license says they must buy a commercial
  license. In principle this is the most direct monetization.
- Some deterrence of **embedded resale** (a vendor bundling Hydra-Swarm into a
  paid product) for PolyForm NC.

### What it costs (the downside — and it is substantial)

- **You cannot call it "open source."** Neither PolyForm NC, BSL, nor Elastic-2.0
  is [OSI-approved][osi]. The correct term is *"source available."* For a project
  whose entire architectural pitch is **trust, evidence gates, and verifiable
  claims**, marketing it under a license the OSI does not bless sends a mixed
  signal: *"trust the process, but not the license of the process."*
- **Contribution friction.** External contributors must either assign copyright
  (so you can dual-license) or accept that their contribution is locked to the
  non-commercial terms. The set of people willing to fix a Codex adapter quirk
  for free *and* sign away commercial rights is small. This matters acutely for
  Hydra-Swarm, because **adapter drift is the single ongoing maintenance burden**
  (the roadmap explicitly names it as the designed drift point) and that burden
  is exactly the kind of patch a community would otherwise absorb.
- **Distribution/packaging refusals.** OS distributions (Debian, Fedora, Homebrew
  core, nixpkgs) and most corporate "approved OSS" allowlists **will not ship or
  bless non-OSI licenses**. A restrictive license can close the door to the
  easiest install paths and to enterprise security-review pipelines that auto-
  approve only OSI licenses.
- **Weak enforceability for a local, no-call-home tool (decisive for Hydra).**
  PolyForm NC and BSL rely on the honor system plus the legal threat. Hydra-Swarm
  runs locally, against the user's *own* vendor accounts and *own* codebase, with
  no authentication call-home and no telemetry. **Detection of commercial misuse
  is near-zero.** So a restrictive license imposes 100% of its costs (stigma,
  friction, distribution loss) to capture *only* honest, self-disclosing
  commercial users — the exact users who are also the most likely to just pay for
  a support/enterprise tier anyway. That is a poor trade.

### What Apache-2.0 + open-core costs (for balance)

- You **give the core away** to commercial users for free. Monetization depends
  on building something *beyond* the core that companies value (managed service,
  enterprise policy, support, guaranteed adapter SLAs). If Hydra-Swarm's core
  *is* the entire product and you never build a commercial surface, open-core
  earns you goodwill and little money.
- A competitor **could fork** the permissive core. In practice the fork dies
  without the ongoing adapter maintenance and the brand — and for a *local* tool,
  there is no easy "wrap it as a SaaS" arbitrage because it must run against the
  end-user's own vendor credentials and local repo (see §5).

Net: for a local, trust-centric, no-call-home orchestration tool, the costs of a
restrictive license outweigh its (weakly enforceable) protection. Open-core keeps
the trust story consistent and routes monetization to where Hydra-Swarm can
actually defend it.

[osi]: https://opensource.org/licenses

---

## 5. What is specific to Hydra-Swarm (point 4)

This is the section that should most change the calculus versus a "typical"
BSL/Elastic-style product. Three facts dominate.

### 5.1 Hydra-Swarm is a local orchestrator of *paid third-party* CLIs, not a hosted SaaS

Hydra-Swarm doesn't run a service for end-users; it **drives CLIs the user
already pays for** (Claude, Codex, OpenCode/GLM, Kimi) on the user's own machine,
against the user's own codebase. The classic justification for BSL / Elastic-2.0
/ SSPL is *"stop AWS from offering my database/search-engine as a managed service
and undercutting me."* **That threat barely maps to Hydra-Swarm:**

- Nobody can profitably resell Hydra-Swarm as a *managed cloud service* because
  the value is inseparable from running locally against the customer's own vendor
  credentials and private repos. A "Hydra Cloud" would have to ingest the
  customer's source and hold their vendor keys — a trust and security posture most
  buyers would reject, and one that doesn't need a code-license restriction to
  deter (a trademark policy does it cleanly).
- The vendor CLIs themselves carry **mixed licenses** (the adapters doc already
  notes the vendors range from proprietary to open-weights-MIT). Hydra-Swarm's
  *orchestration* layer being licensed differently from the things it orchestrates
  is natural; restricting it gains little.

**Conclusion:** BSL/Elastic/SSPL solve a problem Hydra-Swarm doesn't have. Drop
them from consideration on the merits, not on familiarity.

### 5.2 The real moat is adapter maintenance + the trust model, not secret code

The roadmap names **vendor-adapter drift** as the recurring, designed-in
maintenance burden (model renames, flag changes, print-mode quirks,
stream-format changes — all confined to adapters by design). That is:

- **Hard to sustain alone** under a restrictive license (no contributor flywheel).
- **Easy to sustain with community help** under a permissive license (vendor-CLI
  users have direct incentive to upstream adapter fixes — but only if they can
  actually *use* the fix, which a non-commercial license blocks for the corporate
  users who hit the quirks most).

The *other* durable asset — the **evidence-gate / trust-boundary model** — is an
*idea*, not protectable code. Its value is adoption and reputation, both of which
a permissive license maximizes.

### 5.3 The realistic monetization surfaces are additive, not the core

What would a company actually pay for?

- **A managed control-plane / dashboard** (run history, cross-repo capability
  ledger, the global ledger the roadmap already plans) — a hosted *coordination*
  layer, not the local worker.
- **Enterprise policy** (verification/ownership templates, compliance hooks,
  audit exports) — the kind of thing that is easy to gate behind an enterprise
  module.
- **SLA'd vendor-adapter updates and support** — companies pay so that when
  Codex/Kimi change their CLI, *someone* ships a fix on a schedule.
- **Hosted/premium vendor adapters or hosted verification sandboxing.**

Every one of these is an **additive enterprise surface**, licensable separately,
that leaves the Apache-2.0 core fully free. That is the textbook open-core fit:
the free core is genuinely useful and trustworthy; the paid layer is where
organizations spend because they want *management, guarantees, and support*, not
because the license forces them.

### 5.4 The decision rule

> If Hydra-Swarm's value were a **secret algorithm or a hosted service others
> could resell**, a restrictive license (PolyForm NC, or BSL) would be defensible.
> It is neither: it is a **local trust-and-orchestration harness** whose moat is
> **maintenance velocity and reputation**. Therefore **maximize adoption and
> contribution (Apache-2.0) and monetize the additive enterprise layer + brand
> (trademark).**

---

## 6. Implementation checklist (if the recommendation is accepted)

1. Add a top-level `LICENSE` (full Apache-2.0 text) and a short `NOTICE`.
2. Set `"license": "Apache-2.0"` in `.claude-plugin/plugin.json` and in any
   `marketplace.json` plugin entry (so the optional field is populated and
   unambiguous).
3. Add `TRADEMARK.md`: permit use of "Hydra-Swarm" to refer to the upstream
   project; reserve hosted/managed/commercial branding.
4. When the first enterprise module lands, place it outside the Apache-2.0 `kit/`
   (e.g. `enterprise/`) under `LICENSE-ENTERPRISE`; keep `kit/` self-sufficient.
5. Record the decision in `docs/roadmap.md` (open decisions) so the rationale is
   auditable later — consistent with how this repo documents every design choice.

---

## 7. Sources

- Claude Code plugin marketplace documentation (schema, optional `license` field,
  self-hosted marketplaces, no review gate):
  https://code.claude.com/docs/en/plugin-marketplaces
- PolyForm Noncommercial License 1.0.0 (full text; permits noncommercial,
  personal, noncommercial-org use; excludes commercial):
  https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html
- Elastic License 2.0 (restricts only hosted/managed-service provision and
  license-key circumvention; **allows internal commercial use**):
  https://www.elastic.co/licensing/elastic-license
- Business Source License 1.1 (non-production use default; **auto-converts to a
  GPL-compatible license on the 4th anniversary**; explicitly "not an Open Source
  license"): https://mariadb.com/bsl11/
- Open Source Initiative license list (PolyForm NC, BSL, Elastic-2.0, SSPL are
  **not** OSI-approved): https://opensource.org/licenses
- Repo context: `README.md`, `docs/packaging.md` (Wave 3 / kit + managed
  trajectory), `docs/vendor-adapters.md` (adapter drift as designed drift point;
  mixed vendor licenses), `.claude-plugin/plugin.json` (no `license` field today).

---

## 8. One-line summary

**Adopt `Apache-2.0` for the core, monetize through an additive Enterprise
Edition + a trademark policy (open-core), and reserve `PolyForm-Noncommercial-1.0.0`
as the fallback only if you decide the code itself — not a service layer — must be
the paid product; do *not* use BSL/Elastic/SSPL, whose cloud-resale threat model
does not fit a local, no-call-home orchestrator of third-party CLIs.**
