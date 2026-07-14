# License Research & Recommendation for Hydra-Swarm

**Researcher:** Kimi (run 0002)  
**Date:** 2026-07-14  
**Scope:** Recommend a single, concrete license for Hydra-Swarm that (a) permits free use for non-commercial / individual developers, (b) preserves a commercial-licensing / monetization path, and (c) does not preclude listing on the Claude Code plugin marketplace.

---

## 1. Specific license recommendation

**Primary recommendation: `PolyForm Noncommercial 1.0.0`**, with a separate, paid **commercial license** sold by the Hydra-Swarm project for for-profit use.

This is the cleanest available standard license for the stated goals:

- It permits **use, modification, and redistribution** for any **non-commercial purpose**, including personal projects, education, public research, non-profits, government use, and hobby development. ([PolyForm Noncommercial 1.0.0 text](https://polyformproject.org/licenses/noncommercial/1.0.0))
- It explicitly **withholds the right to use the software commercially** unless the user negotiates a separate license with the licensor. That creates the monetization path: individuals and non-commercial users get the code for free; companies that use Hydra-Swarm in revenue-generating work purchase a commercial license.
- It is a **standardized, lawyer-drafted, plain-language license** with a recognized SPDX identifier (`PolyForm-Noncommercial-1.0.0`). ([SPDX entry](https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0))
- It keeps the **full source code public**, unlike open-core models that hide enterprise code behind a proprietary wall.

This model is already used by real projects:

- **EPPlus** moved from LGPL to PolyForm Noncommercial 1.0.0 and sells commercial licenses for spreadsheet-library use in business. ([EPPlus license change](https://www.epplussoftware.com/Home/LgplToPolyform))
- **Tessera** uses PolyForm Noncommercial for personal/learning/OSS/non-profit use and paid tiers for client work, SaaS, and internal for-profit tools. ([Tessera license page](https://tessera-ai.net/docs/license))

For Hydra-Swarm, the recommended repository header would look like:

```text
SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

This software is licensed under the PolyForm Noncommercial License 1.0.0.
Commercial use (including use by for-profit companies and consultants doing
paid client work) requires a separate commercial license.
See https://hydra-swarm.dev/commercial-license or contact licensing@hydra-swarm.dev.
```

---

## 2. Compatibility with the Claude Code plugin marketplace

### What the marketplace docs actually say

The Claude Code plugin marketplace schema treats the `license` field as an **optional SPDX identifier** and gives `MIT` and `Apache-2.0` as examples. ([Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)) There is **no published rule that the license must be OSI-approved** in order for a marketplace entry to validate or load; the field is metadata.

The official Anthropic directory says only that external plugins must meet "quality and security standards for approval" and that users should review each plugin's own LICENSE file. ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official))

### Is there a real conflict?

**There is no documented hard ban on source-available / non-commercial licenses.** However, there is a **practical tension**:

- The docs’ examples are MIT/Apache, and many submissions in the issue tracker list MIT. This suggests the review pipeline is **accustomed to permissive open-source licenses** and may treat a non-commercial license as anomalous.
- PolyForm Noncommercial is **not an open-source license** under the OSI definition because it discriminates against the field of endeavor of commercial use. ([Open Source Definition, criterion 6](https://opensource.org/osd)) If Anthropic's "quality standards" ever include an OSI-approval requirement, PolyForm Noncommercial would fail.
- The marketplace lets **anyone host their own marketplace** (e.g. `acme-corp/claude-plugins`). A self-hosted or community marketplace does not require Anthropic approval, so a PolyForm-licensed plugin can always be distributed that way.

### How to resolve the tension if the official directory objects

If the official/curated directory insists on a permissive license, the best real-world pattern is an **open-core / dual-track** approach:

1. Keep the **full Hydra-Swarm harness** under `PolyForm Noncommercial 1.0.0` in its main repository.
2. Publish a **small, permissively licensed "Hydra-Swarm Plugin" wrapper** (MIT or Apache-2.0) that exposes a minimal, marketplace-friendly interface and points users to the full harness for advanced use.
3. Sell commercial licenses for the full harness separately.

This is analogous to how many "source-available" companies still publish an MIT/Apache SDK or plugin to maximize distribution while protecting the core product.

**Bottom line:** PolyForm Noncommercial is technically compatible with marketplace distribution today, but it is **not guaranteed to be welcomed by Anthropic's curated directory**. The project should either (a) list it in its own marketplace if curation rejects the license, or (b) pair a permissive plugin wrapper with the PolyForm core.

---

## 3. Concrete tradeoffs

### What a non-commercial-restricted license costs you

| Cost | Why |
|------|-----|
| **Not "open source" in the OSI sense** | PolyForm Noncommercial violates OSD criterion 6 (no discrimination against fields of endeavor). You must call it **source-available**, not open source. ([OSD](https://opensource.org/osd)) |
| **Contributor friction** | Some developers and companies have policies against contributing to non-OSI licenses. Corporate legal teams may need to review before employees can even submit pull requests. |
| **Marketplace / ecosystem friction** | Some catalogs, package registries, and enterprise procurement systems favor or require OSI-approved licenses. You may be excluded from certain directories or have to maintain a separate permissive wrapper. |
| **Community trust hit** | Switching a project from a permissive license to a non-commercial one can be perceived as a bait-and-switch. If Hydra-Swarm starts permissive and later moves to PolyForm, expect pushback. |

### What it protects

| Protection | Why |
|------------|-----|
| **Commercial monetization** | For-profit use requires a paid license. This is the direct revenue model. |
| **Prevents free-riding by competitors** | A rival cannot simply fork Hydra-Swarm and sell a competing product or bundle it into a paid IDE without a license. |
| **Avoids cloud-provider cloning** | Unlike MIT/Apache, a non-commercial license stops a hyperscaler or SaaS vendor from offering Hydra-Swarm as a managed or bundled service without negotiation. |
| **Public source + individual freedom** | Individuals, academics, and open-source projects still get full source, modification, and redistribution rights. |

### Comparison with the main alternatives

- **MIT / Apache-2.0**: Maximum adoption and trust, but **no commercial gate**. If Hydra-Swarm becomes valuable, competitors can monetize it freely while the project has no licensing leverage. Apache-2.0 is the safest choice if marketplace acceptance is the dominant concern.
- **Business Source License (BUSL-1.1)**: Source-available, non-production use is free, and code automatically converts to an open-source license after a set date. ([MariaDB BSL FAQ](https://mariadb.com/bsl-faq-mariadb/)) This is a strong choice for infrastructure products worried about cloud competition, but it is more complex (requires setting a Change Date and Change License) and does **not** permanently reserve commercial rights.
- **Elastic License 2.0**: Allows almost all use except offering the product as a managed service, circumventing license keys, or removing notices. ([Elastic License 2.0 FAQ](https://www.elastic.co/licensing/elastic-license/faq)) It protects against SaaS cloning but still permits most internal commercial use, so it is **not** a direct monetization license.
- **AGPL-3.0**: Forces network-use derivatives to be open source; companies typically buy a commercial license to avoid copyleft. Strong for hosted/network software, but Hydra-Swarm is primarily a local CLI harness, so AGPL’s network clause is a poor fit and would scare away library adopters.

For Hydra-Swarm’s stated goals, **PolyForm Noncommercial is the most direct fit**: it makes individuals/non-commercial users free and companies paid.

---

## 4. Hydra-Swarm-specific considerations

Hydra-Swarm is **not a typical database or SaaS platform**; it is a **local orchestration harness** that dispatches paid third-party vendor CLIs (Claude, Codex, OpenCode/GLM, Kimi) on behalf of whoever runs it. This changes the license calculus in a few ways:

### The cloud-hosting threat is smaller

Products like CockroachDB, Elasticsearch, or Terraform switched to BSL/Elastic/SSPL because hyperscalers could offer them as managed services and undercut the vendor. Hydra-Swarm, by contrast, operates on the user’s local machine against the user’s own vendor CLI credentials and subscriptions. A third party cannot easily offer "Hydra-Swarm as a service" without also managing the user’s relationship with Claude/Codex/OpenCode/Kimi. That makes the **anti-cloud-hosting clauses** in Elastic License 2.0 or SSPL **less relevant**.

### The real threat is copying the orchestration logic

The value of Hydra-Swarm is in its **trust boundary, worktree isolation, evidence gates, cross-vendor review, and integration protocol** — not in raw compute or data hosting. A competitor could fork the logic and sell a similar multi-agent harness. PolyForm Noncommercial directly blocks that commercial resale while still letting individuals and open-source projects study and build on the code.

### Users already pay the vendors separately

Commercial users of Hydra-Swarm are already paying Anthropic, OpenAI, Zhipu, Moonshot, etc. for the underlying agents. Hydra-Swarm is an **orchestration layer on top of those payments**. A non-commercial license means the project can ask for its own license fee without dramatically changing the user’s cost structure — it is an additional tool license, not a substitute for vendor API costs.

### Deployment shape favors a clean license

Because Hydra-Swarm is designed to be installed as a plugin / local tool, the "free for individuals, paid for companies" model maps cleanly:

- **Individual developers** install the plugin, use their own API keys, and fall under PolyForm Noncommercial.
- **Companies / agencies / consultancies** purchase a site-wide or per-seat commercial license.
- **Future hosted or enterprise editions** can be licensed separately without relicensing the core repo.

### Recommendation for the packaging path

When Wave 3 packages Hydra-Swarm as a standalone installable plugin (`docs/packaging.md`), keep the core repo under PolyForm Noncommercial. If the Claude Code official marketplace ever rejects that license, the fallback is:

- Publish an **Apache-2.0 plugin manifest + thin wrapper** to the marketplace.
- The wrapper downloads or delegates to the PolyForm-licensed core.
- Commercial terms live on the project website and in the `COMMERCIAL-LICENSE.md` file.

---

## Final recommendation

**Use `PolyForm Noncommercial 1.0.0` as the primary license for the Hydra-Swarm repository**, and offer a separate paid commercial license for for-profit use. This is the simplest, most enforceable, and most widely understood source-available model that satisfies all three stated goals.

If marketplace acceptance becomes a concrete blocker, do not abandon the monetization model; instead, **layer a permissively licensed (Apache-2.0) marketplace wrapper over the PolyForm core**, as many dual-track source-available projects do.
