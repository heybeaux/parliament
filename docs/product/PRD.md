# Parliament — Product Requirements Document

| | |
|---|---|
| **Version** | 0.1 (draft) |
| **Author** | Beaux Walton |
| **Last updated** | 2026-05-03 |
| **Status** | Approved direction — pending implementation roadmap |
| **Source deliberations** | [`adversarial-wedge`](../../../ops/research/parliament-deliberations/2026-05-03-productization-adversarial-wedge.md) · [`long-view-ui-first`](../../../ops/research/parliament-deliberations/2026-05-03-productization-long-view-ui-first.md) · [`socratic-pricing`](../../../ops/research/parliament-deliberations/2026-05-03-productization-socratic-pricing.md) |

## 1. One-line summary

Parliament is a multi-agent deliberation engine that turns hard questions into auditable transcripts of specialised reasoning agents debating each other under a shared protocol. The hosted product (Pro / Team / Enterprise) is sold to developers and engineering teams as **decision-quality-as-a-service**; the open-source core is the trust-building wedge.

## 2. Positioning

> **Parliament is to single-shot LLM calls what code review is to merging your own PR.**

Single-model APIs answer the question you asked. Parliament answers the question you *should* have asked, surfaces the failure mode you didn't think of, and gives you a transcript you can take to your team or your auditor.

The competition is not GPT-5 or Claude Opus — Parliament uses those models. The competition is the unaided developer pasting a hard question into ChatGPT, accepting the first answer, and shipping the consequences six months later.

### Two surfaces, one engine

The same engine drives two product surfaces:

1. **Consumer UI** (`parliament.app`) — the showcase. A user types a hard question, picks a preset (`debate`, `adversarial`, `long-view`, …), and watches eight neurotypes deliberate live. Telemetry-as-art renders OSI scores, residue, and agent positions as the deliberation unfolds. This is what makes a developer integrate the API tomorrow.
2. **Developer API** (`api.parliament.app`) — the monetisation surface. The same deliberations, exposed as REST endpoints. Developers integrate Parliament into their products to give their *own* users the decision-quality output Parliament produces.

The audiences overlap: developers play with the UI before they integrate the API; teams using the API ship the same UI-style transcript view to their users. **One engine, two surfaces, one trust story.**

## 3. Why now

Three forces converge in 2026:

1. **Foundation models plateau on raw IQ but not on reasoning structure.** Every benchmark gain since Q4 2025 has come from agentic scaffolding (Anthropic's Computer Use, OpenAI's o-series chain-of-thought, Google's Gemini agents), not from base-model upgrades. The market has implicitly accepted that *how* you wire models together is now the reasoning differentiator.
2. **Decision-quality is becoming a procurement category.** Regulated industries (finance, healthcare, legal) increasingly require auditable AI decision trails. Parliament's transcript-by-default architecture is one of the few products that ships compliance-ready by construction.
3. **Multi-agent primitives are not yet native to foundation labs.** Anthropic and OpenAI ship single-agent loops with tool use; multi-agent orchestration is still a third-party play. Window: 12-18 months before native primitives commoditise the orchestration layer.

## 4. Audiences

### Primary: Engineering teams (3-50 person companies)

**Who:** Senior engineers and tech leads at Series A-C startups, R&D groups at larger companies, and consultancies who own architectural decisions and want a defensible second opinion on hard ones.

**Pain:** They're already using LLMs for reasoning support, but the "ask Claude, get one answer" loop produces overconfident outputs that miss failure modes. The cost of a bad architectural decision is $50k-500k of wasted engineering time; the cost of a Parliament deliberation that catches it is $0.05.

**Job-to-be-done:** "Give me a defensible, auditable second opinion on this hard decision before I commit to it." Specifically: API integration into their own products (decision-support features for *their* users) and CLI/UI use for their own architectural reviews.

### Secondary: Individual senior developers (Pro tier)

**Who:** Staff/principal engineers, indie hackers, technical founders evaluating Parliament for company adoption.

**Pain:** Same as primary, but with a personal credit card and a $20 limit on "AI tools I'm trying."

**Job-to-be-done:** "Let me kick the tyres without asking my company to buy something, and let me show my CTO why we should standardise on this."

### Tertiary: Enterprise (contact sales)

**Who:** Mid-market and large enterprises in regulated industries needing auditable AI reasoning trails, on-prem deployment, SSO/SAML, and indemnification.

**Pain:** "Our compliance team won't let us use ChatGPT for production decisions."

**Job-to-be-done:** "Give us a vendor we can write a contract with."

## 5. Strategic decisions (locked)

These are decisions reached by deliberation; the rationale is in the linked transcripts.

| # | Decision | Source |
|---|---|---|
| **D1** | UI-led acquisition with **day-one developer preview** (single high-value API primitive). NOT pure UI-first; NOT pure API-first. Same engine, two surfaces, opened concurrently. | `long-view-ui-first` |
| **D2** | **First public release ships error-forwarding passthrough with no markup transformation by default.** Markup transformations are opt-in, schema-validated, and explicitly warn the integrator about edge cases. | `adversarial-wedge` |
| **D3** | **Bottom-up cost-plus is the floor, not the strategic anchor.** Pricing tiers are gated on dimensions Parliament controls: reasoning depth, concurrency, reliability SLA, private deliberations, retention. | `socratic-pricing` |
| **D4** | **No free hosted tier.** Free is the OSS (GitHub, BYO-key, self-host); paid is hosted convenience + frontier lineup access + reliability + enterprise features. | Direct |
| **D5** | **OpenRouter passthrough + markup is the hosted-product backend.** BYO-key path is the open-source self-hosted path. | Direct |
| **D6** | **Telemetry-as-art** is the consumer UI's identity. Restrained graphical theatrics, per-neurotype motion identity, no audio. The wait is the product. | Direct |

## 6. Wedge product (v1, ship in Q3 2026)

The first revenue-bearing release. Scope is intentionally narrow.

### Surface 1 — Consumer UI (`parliament.app`)

**Already mostly built.** Remaining work:

- Marketing landing page with the cost-of-being-wrong calculator (see §10)
- Sample questions gallery (already shipped)
- Telemetry-as-art polish: live OSI score morph, residue heatmap, per-neurotype motion identity, animated transcript reveal
- Sharable transcript URLs (read-only public view, opt-in per deliberation)
- Sign-up flow + Stripe billing for Pro tier

### Surface 2 — Developer API (`api.parliament.app`)

**Day-one primitive (D1):** read-only deliberation endpoints. Authenticated developers can:

- `POST /v1/deliberations` — kick off a deliberation (topic + preset + optional context)
- `GET /v1/deliberations/:id` — poll for status and turns
- `GET /v1/deliberations/:id/stream` — SSE stream of turns as they generate
- `GET /v1/deliberations` — list deliberations for the authenticated account
- `GET /v1/presets` — list available presets
- `GET /v1/usage` — current period usage + remaining envelope

This is the minimum that lets a developer build "Parliament-powered decision support" into their own product. Full spec in [`API.md`](./API.md).

**NOT in v1:** custom neurotypes, fine-tuning, write-side mutation of in-flight deliberations, agent-to-agent webhooks. These come in v1.5+.

### Surface 3 — Open source (already exists)

The OSS repo is the trust wedge. It must remain genuinely usable as a self-hosted alternative — not a crippled "community edition." OSS users get every preset, every neurotype, the engine, the UI source, and the BYO-key path. They give up: hosted convenience, frontier lineup access without their own keys, reliability SLA, private-deliberation guarantees, dedicated support, and enterprise features (SSO/audit/indemnification).

## 7. Pricing

| Tier | Price | Deliberations / mo | Concurrency | Lineup | Retention | Private | SLA | Support | Enterprise features |
|---|---|---|---|---|---|---|---|---|---|
| **Free (OSS)** | — | unlimited (self-host, BYO-key) | self-managed | BYO | self-managed | self-managed | none | community | — |
| **Pro** | $19/mo | 350 | 1 | cheap | 30 days | no | best-effort | community | — |
| **Team** | $99/mo per seat | 2,000/seat | 5 | cheap + frontier | 1 year | yes | 99.5% | email | basic audit logs |
| **Enterprise** | contact sales | custom | custom | custom | custom | yes | 99.9% | dedicated | SSO/SAML, full audit, indemnification, on-prem option, custom neurotypes |

**Bottom-up sanity check (cost-plus floor):**

- Pro: 350 deliberations × ~$0.005/deliberation (cheap lineup typical) = $1.75 cost. $19 - $1.75 - infra ≈ $15 gross margin. Healthy.
- Team: 2,000 × ~$0.05 (frontier mix) = $100 cost per seat. $99 price = roughly break-even on inference; margin lives in seat count and overage. Tier needs >2 seats average to clear margin. Reconsider after first 100 paying teams whether Team should be $149.
- Enterprise: custom-priced; cost-plus floor varies wildly by usage profile.

**The story (bottom-up is the floor, not the anchor):** Parliament's value isn't the inference compute — that's OpenRouter's commodity. Parliament's value is orchestration, decision-quality, auditability, and the ability to ship "we caught the failure mode our competitor's single-shot LLM missed." Pricing tiers reflect what the *buyer* values, with the cost-plus floor as the unit-economic safety net.

**No free hosted tier.** OSS handles the "try it free" job. This is a real strategic call: most prosumer SaaS uses free as a funnel; Parliament uses GitHub stars + the consumer UI demo + sample questions gallery as funnel. Defensible because the OSS is genuinely usable, not a crippled freemium.

Detailed pricing rationale + competitive positioning in [`PRICING_AND_MARKETING.md`](./PRICING_AND_MARKETING.md).

## 8. Architectural decisions (D2 implications)

### v1 ships error-forwarding passthrough

**Why:** Adversarial deliberation surfaced silent data corruption in the markup transformation layer as the highest-leverage failure mode. Markup that tries to "enhance" upstream model outputs during partial failures will mangle JSON mid-token, inject hallucinated fields, or corrupt structured data while still returning 200 OK. This is irreversible developer trust loss.

**Implication for v1:**

- **Default behaviour:** Parliament forwards OpenRouter responses verbatim. No transformation, no enhancement, no retry magic. If OpenRouter returns a 503, Parliament returns a 503 with the upstream error preserved.
- **Markup as opt-in:** Integrators who want Parliament to enhance outputs (e.g., enforce structured-output schemas, retry on transient failures) explicitly enable it per-request via a `transform` flag. Each transform is schema-validated and documented with its failure modes.
- **Built-in error-rate divergence telemetry:** Parliament continuously monitors the divergence between its own error rate and OpenRouter's native error rate. If Parliament's 5xx rate drops while OpenRouter's spikes (the canonical "markup is masking failures" signal), this surfaces in the dashboard immediately. This is a built-in product feature, not just internal monitoring.
- **Counterargument acknowledged:** RedAgent argued that stripping markup commoditises Parliament into "a redundant toll booth." Counter-counter: Parliament's value is the *deliberation*, not the per-call markup. The orchestration of eight neurotypes across rounds with OSI / residue scoring is the value. Markup is a v2 feature.

### Provider abstraction (D5 implications)

OpenRouter is the cheap default, not the only path. Internal architecture treats OpenRouter as one of N possible upstream providers. Adversarial deliberation flagged single-provider dependency as a load-bearing risk; abstraction means we can swap upstreams without downtime if OpenRouter changes ToS, prices, or goes down.

## 9. Consumer UI — telemetry-as-art (D6)

The wait is the product. A `chain-of-verifiers` deliberation on the frontier lineup takes 90-180 seconds; this is a feature, not a bug, and the UI must make those 90-180 seconds feel like a microscope, not a loading spinner.

### Animation primitives

1. **Per-neurotype motion identity.** Each agent has a distinct motion signature: the Skeptic's turn arrives with a sharp deceleration; the Historian unfolds left-to-right (timeline metaphor); the Adversary punches in from the side; the Lateralist orbits before landing.
2. **Live OSI score morphing.** As each turn lands, the OSI graph (Opinion Shift Index per agent across rounds) animates. The user sees consensus forming or fracturing in real time. This is the central data-art piece.
3. **Residue heatmap.** Unresolved disagreement points light up the residue heatmap. When residue is high, the heatmap is loud; when consensus emerges, it cools.
4. **Animated transcript reveal.** Words land character-by-character at typewriter speed during streaming, with subtle particle effects on disagreement clauses (Adversary's "the strongest failure mode is" lights up as it lands).
5. **Cost ticker.** Live cost + token counter increments as each turn generates. Visible to the user: this run is currently $0.034 of frontier inference. Combats the "is it still doing something?" anxiety.

### What is explicitly NOT included

- **No audio.** No chimes, no whoosh, no notification sounds. Ever.
- **No gimmicky theatrics.** No "the Adversary is thinking…" narrator strings. The motion design carries the personality; the prose carries the substance.
- **No fake progress bars.** Cost ticker and turn-arrival animation give real progress; we never fake "37% complete."

## 10. Marketing wedge

Three benchmarks ship with v1, and they are the marketing story:

1. **Parliament vs single-shot on a hard reasoning corpus.** 100 hard architectural / strategic / empirical questions. Each run through (a) GPT-5 single-shot, (b) Claude Opus 4.7 single-shot, (c) Parliament `chain-of-verifiers`, (d) Parliament `adversarial`. Measured on factual accuracy (where verifiable), failure-mode-coverage (where measurable via expert grading), human preference (blind A/B), and dollar-cost. **Marketing artifact:** "Parliament's adversarial preset surfaced N failure modes the single-shot Opus call missed, at $0.05 per deliberation."
2. **Residue score as the differentiator metric.** Publish residue score alongside every deliberation. Open-source the residue-scoring algorithm. Make residue the metric the industry argues about. If Parliament owns the metric, Parliament owns the comparison frame.
3. **Cost-of-being-wrong calculator.** Landing-page calculator: user inputs cost of their last bad architectural decision; calculator outputs Parliament's break-even rate. ("If your last bad decision cost $50k, Parliament needs to catch one decision in a million to break even.") Shifts buyer reference frame from "what does an API call cost" to "what does the wrong decision cost." This is RedAgent's outcome-value framing turned into a sales tool.

Full marketing brief in [`PRICING_AND_MARKETING.md`](./PRICING_AND_MARKETING.md).

## 11. Roadmap

### v1.0 — Wedge release (target: Q3 2026)

- Pro tier billing live (Stripe + usage metering)
- Day-one API primitive (read-only deliberation endpoints)
- Telemetry-as-art consumer UI
- Three benchmark artifacts published
- Cost-of-being-wrong calculator
- OSS repo polished + landing page
- Cost-plus floor + tier gates implemented and observable in the dashboard

### v1.5 — Team tier + benchmarks (Q4 2026)

- Team tier (concurrency, private deliberations, frontier lineup, audit logs)
- Public residue-score leaderboard / "deliberation of the week"
- API expansion: webhooks for completion, custom retention windows, custom presets

### v2.0 — Enterprise (2027)

- SSO/SAML + full audit logs
- Indemnification + compliance posture (SOC 2 Type II)
- Custom neurotype work for enterprise customers
- On-prem option (already mostly served by OSS; this is the supported / SLA'd version)

## 12. Success metrics

Tracked monthly, ranked by what we'd actually optimise:

| Metric | v1.0 target (Q3→Q4 2026) | v1.5 target (Q4 2026 → Q1 2027) | Notes |
|---|---|---|---|
| Pro signups | 100 → 1,000 | 1,000 → 5,000 | Top-of-funnel proxy |
| Pro paid conversion | 5% (50) | 5% (250) | OSS-as-funnel benchmark |
| Team paying accounts | 0 | 10-30 | Real revenue starts here |
| Total MRR | $1k | $20-50k | Pro × 19 + Team × 99 × seats |
| API calls / mo | 10k | 100k | Engagement, not just signups |
| GitHub stars | 1k → 5k | 5k → 15k | Marketing funnel + recruitment |
| Benchmark publications | 1 | 3 | Marketing artifacts |

## 13. Risks (acknowledged from deliberations)

1. **Foundation labs ship native multi-agent primitives faster than we expected.** Mitigation: lean into the *transcript / audit / residue-scoring* moat, which is harder to replicate than the orchestration. Also, our OSS posture means we're a community Anthropic can't easily compete with on developer love. (`long-view-ui-first` RedAgent T9)
2. **Markup-transformation silent corruption sinks developer trust.** Mitigation: D2 — ship error-forwarding passthrough by default. (`adversarial-wedge` Adversary T1, T5, T10)
3. **Cost-plus pricing erodes margin if OpenRouter prices fluctuate.** Mitigation: D3 — bottom-up is the floor; tiers are gated on dimensions we control; dynamic margin buffer monitored monthly. (`socratic-pricing` RedAgent T8)
4. **The Team tier price-point is tight against frontier-lineup cost.** Mitigation: monitor first 100 Team accounts; reprice to $149 if margin compression confirmed. Don't ship tier until billing infra can re-tier without contract surgery.
5. **OSS cannibalises hosted product.** Mitigation: Enterprise tier is defended by indemnification + SOC 2 + SSO + dedicated support, not by feature gating. Team tier is defended by frontier-lineup access + concurrency + reliability SLA — things you can't get from "git clone" without significant infra investment.

## 14. Out of scope (explicit non-goals)

- **Mobile app.** The consumer UI is responsive; native apps are a 2027+ question.
- **Building our own foundation models.** We use OpenRouter passthrough. We are an orchestration layer.
- **Free hosted tier.** OSS is the free tier. (D4)
- **Markup-as-default.** Opt-in only in v1. (D2)
- **Selling neurotype builder to non-developers.** v1 ships built-in presets. Custom presets are Team+ feature. Visual neurotype builder is v2+.
- **B2C non-developer market.** The consumer UI exists to convert developers and showcase capability, not as a standalone consumer product.
