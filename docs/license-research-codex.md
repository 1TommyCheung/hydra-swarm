# Hydra-Swarm licensing research brief

_Research date: 14 July 2026. This is a product recommendation, not legal advice; counsel should review the final license package, contributor agreement, and third-party CLI terms before public release._

## Executive recommendation

License Hydra-Swarm's public code under **PolyForm Noncommercial License 1.0.0** (SPDX identifier `PolyForm-Noncommercial-1.0.0`) and offer the same code under a separately drafted, paid **Hydra-Swarm Commercial License** to organizations using it commercially.

This is a genuine dual-license model: a user may rely on PolyForm for a permitted noncommercial use, or buy the commercial grant. It directly matches the stated business goal better than MIT, Apache-2.0, BSL 1.1, Elastic License 2.0, SSPL, or PolyForm Shield. EPPlus is a useful working precedent: it publishes its code under PolyForm Noncommercial and sells per-developer commercial licenses ([EPPlus license overview](https://epplussoftware.com/en/LicenseOverview/), [EPPlus repository](https://github.com/EPPlusSoftware/EPPlus)).

There are two important qualifications:

1. Call Hydra-Swarm **source-available**, not “open source.” The Open Source Definition forbids restricting a field of endeavor, including business use ([OSI definition, section 6](https://opensource.org/osd)). “Free/open use” should therefore be described as “free source-available use for noncommercial purposes.”
2. PolyForm's personal-use grant covers hobby, study, research, and similar use **without anticipated commercial application**. It does not make paid work free merely because one individual operates the tool ([license text](https://polyformproject.org/licenses/noncommercial/1.0.0)). If “individual-developer use” is intended to include a solo developer's paid client work, counsel should add a separate no-charge individual commercial grant with a clear boundary (for example, a natural person working solely for their own account, not for an employer or customer organization). Do not claim that PolyForm itself already grants that right.

Before accepting outside code, require a contributor agreement that gives the project owner sufficient copyright and patent rights to distribute contributions under both the PolyForm and commercial licenses. A simple inbound-equals-outbound policy is not sufficient for a licensor that intends to sell a separate license, and commercial employers may be unable to contribute while relying only on PolyForm's noncommercial grant.

## 1. Why this exact license

PolyForm Noncommercial 1.0.0 is a standardized, plain-language license with copyright and patent grants, permission to modify and redistribute for permitted purposes, notice obligations, a 32-day first-violation cure, and express coverage for noncommercial organizations. It is also on the SPDX License List under the exact identifier above ([SPDX entry](https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html)). That is materially clearer than inventing “MIT plus a noncommercial clause,” which would no longer be MIT and would create a bespoke license for every user and scanner to interpret.

The alternatives miss Hydra-Swarm's stated boundary:

| Alternative | Why it is not the primary recommendation |
| --- | --- |
| MIT or Apache-2.0 | Maximizes adoption and marketplace confidence, but irrevocably permits commercial use, modification, and redistribution. A separate “commercial terms” document could sell support, warranty, hosted service, or premium proprietary modules, but could not require payment for using the already permissively licensed code. Apache also deliberately leaves trademarks outside the code grant ([Apache-2.0 sections 4 and 6](https://www.apache.org/licenses/LICENSE-2.0.html)). |
| BSL 1.1 | The stock grant permits non-production use, not all noncommercial or personal production use; any production allowance must be specified in an Additional Use Grant. Each release must convert to a GPL-compatible license no later than four years after first public distribution ([BSL 1.1 text](https://mariadb.com/bsl11/)). That machinery is useful for server products with a planned delayed-open-source cycle, but is needlessly indirect for “noncommercial free, commercial paid.” |
| Elastic License 2.0 | Allows free internal commercial use and mainly blocks offering the product as a managed service, bypassing license-key features, and removing notices ([Elastic FAQ](https://www.elastic.co/licensing/elastic-license/faq/)). It would protect against a hosted clone but would not monetize ordinary organizational use. |
| SSPL | Its service-source obligation targets software offered as a service. It is a poor fit for a local process orchestrator and introduces a controversial, non-OSI license without establishing a simple per-organization paid-use boundary. |
| PolyForm Shield | Allows commercial use except for competing products ([license text](https://polyformproject.org/licenses/shield/1.0.0)). Like ELv2, it protects a product business against competitors but does not require normal commercial users to buy a license. |
| PolyForm Small Business 1.0.0 | Allows use for organizations below both 100 workers and an inflation-adjusted USD 1 million revenue threshold ([license text](https://polyformproject.org/licenses/small-business/1.0.0)). This is attractive if the real policy is “small commercial users free, larger businesses paid,” but it is not the stated noncommercial boundary and does not expressly grant all noncommercial use. |

The commercial license should spell out the metric (preferably named developer/operator seats rather than machines or orchestrated agents), affiliates, contractors, CI use, redistribution, modification, support, term, audit mechanics, and a reasonable evaluation period. Keep pricing and mutable product policy out of the public PolyForm text.

## 2. Claude Code marketplace compatibility

### What Anthropic's public materials actually establish

The initial claim that a Claude Code marketplace requires MIT or Apache-2.0 is too strong. Current public documentation says:

- A marketplace plugin's `license` field is **optional** and takes an SPDX identifier; MIT and Apache-2.0 are examples, not an allowlist ([marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces#optional-plugin-fields)). Because PolyForm Noncommercial 1.0.0 has an SPDX identifier, it is schema-representable.
- Anyone can host a public, private, local, or self-hosted marketplace. Claude Code can fetch plugins from Git, GitHub, npm, and other sources; the documented self-hosted mechanism publishes no open-source-license gate ([hosting and sources](https://code.claude.com/docs/en/plugin-marketplaces#host-and-distribute-marketplaces)). PolyForm is therefore technically compatible with a Hydra-Swarm-owned marketplace.
- Community submissions are described as passing `claude plugin validate`, automated safety screening, and review; approved entries are pinned to a source commit. The page does not publish a permissive-license eligibility rule ([submission process](https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace)).
- The separate official directory is curated at Anthropic's discretion and has no application process. Its repository tells readers to consult each external plugin's own license rather than declaring that all plugins share the catalog's Apache license ([official directory README](https://github.com/anthropics/claude-plugins-official#license)).
- Most decisively for technical tolerance, Anthropic itself documents a Claude Code plugin marketplace containing document skills it explicitly calls “source-available, not open source,” whose license restricts copying, derivatives, and distribution ([Anthropic skills README](https://github.com/anthropics/skills#about-this-repository), [example restricted license](https://github.com/anthropics/skills/blob/main/skills/pdf/LICENSE.txt)). This does not promise equal treatment for third-party curated submissions, but it disproves the idea that the plugin mechanism inherently requires MIT or Apache-2.0.

### Practical conclusion

**Self-hosted/community-owned marketplace: compatible. Curated Anthropic community directory: plausible but unconfirmed. Official directory: entirely discretionary and unconfirmed.** There is no public rule I found that rejects PolyForm Noncommercial, but absence of a published prohibition is not an acceptance guarantee. Before making the license irreversible or marketing “Claude marketplace compatible,” obtain written confirmation from the submission channel describing the precise license and commercial dependency. Preserve a self-hosted marketplace as the guaranteed distribution path.

If Anthropic says curated listing requires an OSI-approved permissive license, there is a real conflict: no code license can both allow unrestricted commercial use (as MIT/Apache do) and require commercial organizations to pay for that same use. Choose one of these honest resolutions:

1. **Recommended fallback:** publish a small Claude-facing adapter/plugin under Apache-2.0 that installs or invokes the separately distributed PolyForm/commercial Hydra-Swarm engine. Clearly disclose the engine's license and any paid requirement. This resembles open integrations or SDKs that connect to paid products, but Anthropic should confirm it will accept the dependency.
2. Put genuinely generic plugin definitions and interfaces in an Apache-2.0 “core,” while keeping differentiated orchestration, organization policy, collaboration, or management features in the commercially licensed product. The split must be technically real, not a misleading license wrapper.
3. If maximum official-directory reach matters more than charging for local code use, license all code Apache-2.0 and monetize support, hosted control-plane features, managed execution, enterprise governance, indemnity, or proprietary add-ons. Use a separate trademark policy to prevent confusing branding. This abandons the ability to charge merely for commercial use; trademark does not recreate that code restriction.
4. Retain PolyForm and distribute through Hydra-Swarm's own marketplace if direct commercial-use monetization matters more than Anthropic-curated discovery.

## 3. Tradeoffs

### What the restriction protects

- It creates a clear legal trigger for commercial organizations to negotiate and pay, instead of hoping they voluntarily purchase support for freely usable code.
- It reduces lawful free-riding by vendors that would repackage Hydra-Swarm into a commercial developer product.
- It keeps source visible for inspection, noncommercial learning, modification, and community experimentation.
- A standard SPDX-listed text is more legible to counsel and tooling than a custom “fair use” license.

### What it costs

- PolyForm Noncommercial is not open source. Some developers will reject the terminology or the restriction on principle, and OSPOs/package policies may automatically disallow it.
- “Commercial” boundaries generate questions: a hobbyist preparing a future product, an employee experimenting at work, a consultant, a university-industry project, and a sponsored open-source maintainer may not know whether their use is permitted. Legal review and procurement can erase the convenience advantage of a small CLI.
- Downstream packaging, Linux distributions, mirrors, integrations, and some curated marketplaces may decline the license. The pool of compatible reusable code and distribution channels is smaller.
- External contributions become harder. Contributors and their employers need authority to grant commercial relicensing rights; requiring a CLA adds friction and can reduce trust.
- Public forks can continue noncommercially, but commercial ecosystem businesses cannot form without a separate deal. That reduces independent investment, integrations, and mindshare.
- Enforcement for a local tool is mostly contractual/legal. Without a hosted control plane, Hydra-Swarm may have limited visibility into organizational use; aggressive telemetry or license checks would add security, privacy, and adoption costs.
- Dual licensing only works cleanly while the project can grant both licenses over all shipped code. Dependency licenses, copied prompts/assets, and outside contributions need provenance review.

The trust cost is especially sensitive here: Hydra-Swarm asks developers to let an orchestrator launch powerful coding agents against their repositories. Auditable source helps, but a license that blocks paid-work experimentation may discourage exactly the experienced teams whose scrutiny and contributions would establish trust.

## 4. Hydra-Swarm-specific calculus

Hydra-Swarm is not a hosted database, search service, or infrastructure control plane. It runs locally and orchestrates separately installed vendor CLIs. That changes the risk and value boundary:

- **The classic ELv2/SSPL defense is misaligned.** Those licenses principally address a cloud provider exposing a server product as a competing managed service. Hydra-Swarm's likely uncompensated use is an organization running the local tool internally, which ELv2 generally permits. A direct noncommercial/commercial split fits that risk better.
- **BSL's production distinction is awkward.** A developer harness can affect real paid work from its first useful invocation; “non-production use” is less intuitive than it is for a database deployment. A custom Additional Use Grant would have to recreate the desired user categories and would still add per-release change-date administration.
- **Marketplace distribution is valuable but not the whole product.** A Claude plugin can be a thin entry point while the engine coordinates Claude, Codex, OpenCode, and Kimi. Keeping the adapter separable makes the license boundary and a permissive-listing fallback more credible.
- **Users already bear vendor costs.** Organizations must acquire and comply with the relevant CLI subscriptions/API terms. An additional per-seat Hydra license creates a second procurement decision, so pricing should reflect orchestration value and should not charge by spawned agent or vendor token. A generous evaluation path is likely more effective than attempting technical enforcement.
- **Third-party rights remain separate.** Hydra-Swarm's license cannot authorize automated use, concurrent sessions, credential handling, redistribution, or branding under a vendor's terms. The product should require users to install and authenticate each CLI themselves, avoid bundling vendor code unless redistribution is allowed, make no implied endorsement, and maintain a compatibility/terms review for each integration.
- **Trademark is useful but incomplete.** Reserving the Hydra-Swarm name and logo can prevent misleading forks from presenting themselves as official. It cannot make organizations pay for code use and should complement, not substitute for, the recommended commercial license.
- **A hosted moat is currently weak.** Unlike a database company, Hydra-Swarm cannot rely on a natural hosted-service upsell today. Apache-2.0 plus paid hosting is therefore less aligned with the current product than advocates of the standard open-core playbook may assume. If an enterprise control plane, managed scheduler, audit service, or policy service becomes the main value later, permissive licensing can be reconsidered for future versions without revoking the terms of versions already released.

## Decision and launch checklist

Proceed with `PolyForm-Noncommercial-1.0.0 OR Commercial` only if management accepts lower adoption and uncertain curated-directory approval in exchange for the ability to charge ordinary commercial users. Before launch:

1. Ask Anthropic's community submission channel in writing whether `PolyForm-Noncommercial-1.0.0` and, if used, an Apache-2.0 adapter with a commercially licensed engine are eligible.
2. Have counsel draft the commercial EULA, any free solo-developer commercial grant, the trademark policy, and the contributor agreement; publish a plain-language FAQ with concrete permitted/prohibited examples.
3. Inventory ownership and dependency licenses, including prompts, templates, vendored scripts, and generated assets. Do not dual-license code the project lacks authority to relicense.
4. Package the Claude adapter as a separable component so an Apache-2.0 fallback does not require relicensing the entire engine.
5. Review the current terms, trademarks, authentication expectations, and redistribution rules for every orchestrated vendor CLI before each public integration release.

If Anthropic confirms that curated discovery requires permissive licensing and curated reach is the non-negotiable priority, switch the adapter—not automatically the entire engine—to Apache-2.0. If Anthropic requires the complete executable dependency to be permissive too, the lead must explicitly choose between commercial-use license revenue and that distribution channel; the two requirements cannot be solved by wording alone.
