# Parliament — Pricing & Marketing One-Pager

| | |
|---|---|
| **Version** | 0.1 (draft, locked direction) |
| **Last updated** | 2026-05-03 |
| **Status** | Approved direction — pending v1 launch implementation |

## TL;DR

- **Free is the OSS** (GitHub, BYO-key, self-host). No free hosted tier.
- **Pro: $19/month** — 350 deliberations, cheap lineup, individual developer.
- **Team: $99/month/seat** — 2,000 deliberations/seat, frontier lineup, concurrency, private deliberations, SLA, basic audit.
- **Enterprise: contact sales** — SSO, full audit, indemnification, dedicated support, on-prem option, custom neurotypes.
- **Bottom-up cost-plus is the floor, not the anchor.** Tiers are gated on dimensions Parliament controls: reasoning depth, concurrency, reliability, retention, private deliberations.
- **Three benchmarks ship with v1** and are the marketing story: Parliament-vs-single-shot reasoning corpus, residue-score-as-the-metric, cost-of-being-wrong calculator.

## Pricing

### The grid

| | **Free (OSS)** | **Pro** | **Team** | **Enterprise** |
|---|---|---|---|---|
| Price | — | $19/mo | $99/mo per seat | Contact sales |
| Deliberations / mo | unlimited (self-host) | 350 | 2,000 / seat | Custom |
| Concurrency | self-managed | 1 | 5 | Custom |
| Lineup | BYO | Cheap (OpenRouter open-frontier) | Cheap + Frontier (Opus, GPT-5) | Custom |
| Retention | self-managed | 30 days | 1 year | Custom |
| Private deliberations | self-managed | No | Yes | Yes |
| SLA | none | best-effort | 99.5% | 99.9% |
| Custom presets | yes (open code) | No | Yes | Yes |
| Support | community | community | email | dedicated |
| SSO / SAML | — | — | — | Yes |
| Audit logs | — | — | basic | full |
| Indemnification | — | — | — | Yes |
| On-prem option | self-host | — | — | supported / SLA'd |

### Why these numbers (the bottom-up sanity check)

The cost-plus floor is the unit-economic safety net. It is **not** the strategic anchor.

**Pro ($19/month, 350 deliberations):**

- Cheap-lineup typical cost per deliberation: **~$0.005**
- 350 × $0.005 = **$1.75 inference cost**
- $19 - $1.75 - infra (~$2) - billing fees (~$0.60) = **~$14.65 gross margin**
- Healthy. Pro tier carries itself even at moderate utilisation.

**Team ($99/month/seat, 2,000 deliberations/seat):**

- Frontier-lineup typical cost per deliberation: **~$0.05**
- 2,000 × $0.05 = **$100 inference cost** at full utilisation
- $99 - $100 = **slight loss at full utilisation per seat**
- Margin lives in: (a) seat count > 2 average, (b) lower-than-cap utilisation, (c) frontier-mix (most teams won't run frontier on every deliberation), (d) concurrency overage, (e) overage billing on deliberation count.
- **First 100 Team accounts inform repricing decision.** If margin is consistently negative, raise to $149. We'd rather start aggressive and raise than start expensive and have to discount.

**Enterprise (custom):**

- Cost-plus floor is account-specific
- Defended by: SSO + SOC 2 + audit logs + indemnification + dedicated support + on-prem + custom neurotype work
- Typical first-year contract size target: **$24k-120k** depending on usage profile. The Enterprise tier is the revenue tier; Pro and Team are funnel and validation.

### Why no free hosted tier (the strategic call)

Most prosumer SaaS uses a free tier as funnel. We don't, for two reasons:

1. **The OSS is genuinely usable.** A developer who wants to try Parliament without paying can `git clone`, `pnpm install`, plug in their own OpenRouter key, and run it locally in 10 minutes. They get every preset, every neurotype, the full UI. No artificial limits.
2. **Free hosted on frontier-lineup costs is bleeding money for no funnel benefit.** A free user doing 50 deliberations/month on the cheap lineup costs $0.25 — but the ones who would have converted to Pro at $19 would have done so anyway (they have the money). The ones who *wouldn't* convert are people we should be acquiring via OSS, not via free hosted.

The funnel is: GitHub stars → consumer UI demo (`parliament.app`) → sample questions gallery → sign up for Pro. The "try it free" job is done by the OSS clone-and-run path *and* by the (rate-limited, non-account) public-facing consumer UI demo at `parliament.app` itself.

### Why the OSS doesn't cannibalise paid

This is the most common founder anxiety with OSS-first products, and the answer is: it doesn't, for documented structural reasons.

1. **Indemnification.** Enterprises in regulated industries (finance, healthcare, legal) need a vendor counterparty for liability. Their own engineer running OSS-Parliament *is* them. Indemnification is the single line item that's worth more than the rest of enterprise pricing combined for these buyers.
2. **Procurement-shaped purchase.** Enterprises have a budget category for "SaaS subscription" with a fast approval path. They don't have a budget category for "engineer's time to operate Parliament-OSS in perpetuity." A $24k/year line item glides through procurement; spinning up a dedicated team to operate Parliament costs $300k+/year fully loaded. The math punishes self-hosting.
3. **SOC 2 / ISO 27001 / SSO / SCIM / audit logs / data residency.** None of these ship in the OSS. Most enterprises *can't legally* use software without SOC 2; rolling their own audit infra on Parliament-OSS is a 6-month engineering project.
4. **Operational cost > license cost.** At enterprise scale, the cost of running a system (on-call, scaling, incident response, security patches, version migrations) is 5-20x the license fee. Enterprises pay vendors so they don't pay an internal team to do that.
5. **The vendor relationship.** Roadmap influence, dedicated support, "we'll build you that custom neurotype," uptime credits when something breaks. None of this is in the GitHub release.

The OSS *is the wedge that makes the enterprise sale possible.* Every senior architect at every Fortune 500 has the OSS version running in their experimentation cluster, and that's exactly how the enterprise contract starts. HashiCorp, GitLab, Sentry, Posthog, Supabase, Mattermost, Grafana, and Elastic (pre-relicense) all run this exact playbook. It's the dominant enterprise-software pattern of the last decade.

### Pricing dimensions, ranked by defensibility

When tiers are explained to a buyer, these are the dimensions where the value story is *legible* without hand-waving:

| Rank | Dimension | Defensibility | How it appears in the grid |
|---|---|---|---|
| 1 | **Reasoning depth** (rounds, neurotypes, preset complexity) | Highest. Buyer sees the artifact. | Cheap vs frontier lineup; future: custom presets unlock |
| 2 | **Concurrency / throughput** | High. Maps to procurement-friendly SLA language. | 1 vs 5 vs custom |
| 3 | **Reliability / latency SLA** | High once we have data. p99 latency, uptime. | best-effort vs 99.5% vs 99.9% |
| 4 | **Privacy / retention controls** | High for enterprise. "Your transcripts never leave your tenant." | Private delibs + retention windows |
| 5 | **Volume / token meter** | Medium. Cost-plus floor; necessary for abuse cap, least differentiated. | Deliberations/mo |
| 6 | **Outcome-tied** (per resolved, per converged) | Theoretically highest, practically lowest right now. Hard to contract. | v2+ |

Tiers gate dimensions 1-4 (capability tiers); dimension 5 is the meter (volume cap, with overage billing for whales). This is the Vercel / Linear shape: tier unlocks features, meter scales with usage.

### Future tier moves

- **First 100 Team accounts → reprice if needed.** If frontier-lineup utilisation is consistently > 80% of envelope and gross margin is negative, raise to $149. Ship billing infra that supports tier repricing without contract surgery.
- **Volume overage billing** ships in v1.5: deliberations beyond the envelope at $0.10-0.50/run depending on preset complexity and lineup. Caps optional per-account.
- **Annual discount** (15-20% off) ships when we have a year of data showing acceptable churn.
- **Outcome-tied pricing experiment** in 2027 once we have enough customer data to write a per-resolved-deliberation contract that the buyer can predict.

## Marketing

### The pitch

> **Parliament is to single-shot LLM calls what code review is to merging your own PR.**

Single-model APIs answer the question you asked. Parliament answers the question you *should* have asked, surfaces the failure mode you didn't think of, and gives you a transcript you can take to your team or your auditor.

### The buyer reference frame

The mistake every "AI tools" pitch makes is anchoring on *input cost* — "$0.10 per query, cheap!" Parliament's defensibility lives in the *output value* frame: what does it cost when a senior engineer commits to the wrong architecture for six months?

The marketing copy must consistently shift the buyer from input-cost framing to outcome-value framing. Every landing-page block, every benchmark, every comparison table works in that direction.

### Three v1 marketing artifacts

These three ship at v1.0 and are the load-bearing marketing pieces. Each is defensible (data, not vibes).

#### 1. Parliament vs Single-Shot benchmark

**Setup:** 100 hard architectural / strategic / empirical questions (pulled from real engineering scenarios, lightly anonymised). Each question runs through:

- (a) **GPT-5** single-shot (with strong CoT prompt)
- (b) **Claude Opus 4.7** single-shot (with strong CoT prompt)
- (c) **Parliament `chain-of-verifiers`** (5-agent, 4-round)
- (d) **Parliament `adversarial`** (5-agent, 4-round)

**Measurements:**

- **Factual accuracy** (where ground truth exists): % correct
- **Failure-mode coverage** (where measurable): N failure modes surfaced vs known-failure-mode list, expert-graded
- **Human preference** (blind A/B): which output would the buyer ship from?
- **Dollar cost per question**

**Marketing artifact:** "Parliament's `adversarial` preset surfaced **N more failure modes** than single-shot Opus across 100 hard engineering questions, at **$0.05 per deliberation vs $0.40 per Opus call**. The full benchmark, dataset, and methodology are open."

This is the headline the home page leads with.

#### 2. Residue Score as the Differentiator Metric

Parliament already computes **residue score** (0-1) for every deliberation: a measure of unresolved disagreement after the synthesizer runs. Residue ≤ 0.2 = consensus. Residue ≥ 0.6 = irreconcilable split. Residue between is "useful disagreement worth surfacing to the human."

**Move:** publish residue alongside every deliberation. Open-source the residue-scoring algorithm. Make residue *the* metric the industry argues about.

If Parliament owns the metric, Parliament owns the comparison frame. (See: HuggingFace owning the model leaderboard, Stack Overflow owning the developer survey.)

**Marketing artifact:** weekly "deliberation of the week" featuring genuinely-split panels on hard public questions (where the disagreement is the value, not a synthesis failure), ranked by residue score. Builds an audience around the metric itself.

#### 3. Cost-of-Being-Wrong Calculator

Landing-page interactive widget:

> **What did your last bad architectural decision cost you?**
>
> [ slider: $0 — $1M ]
>
> *Engineering time × 6 months × team size = your back-of-envelope cost.*
>
> **Parliament needs to catch one such decision in [X] deliberations to break even.**
>
> *(At $0.05/deliberation, a $50k bad-call costs the equivalent of 1,000,000 Parliament runs.)*

This shifts the buyer's reference frame from "what does an API call cost" to "what does the wrong decision cost." It's RedAgent's outcome-value framing turned into a sales tool.

**Marketing artifact:** featured at the top of the pricing page; embeddable widget for technical blog posts; share-on-Twitter screenshots of "Parliament needs to catch 1 in 1,000,000 deliberations to break even on my last bad decision."

### Top-of-funnel channels

Ranked by what we'd actually optimise:

1. **GitHub.** The OSS repo is the funnel. Optimise the README, ship a stunning demo gif, write the architectural posts that get on Hacker News.
2. **Hacker News + technical Twitter.** Ship the benchmark in §1 with the methodology open. "Parliament beat single-shot Opus on N% of these 100 questions" is HN front-page material if the benchmark is rigorous.
3. **The consumer UI itself.** `parliament.app` is the demo. Sample questions gallery is the on-ramp. Each sample deliberation transcript has a sharable URL — every shared transcript is a recruiting pitch.
4. **Technical blog posts** by named engineers. "How we used Parliament to catch a $200k mistake before shipping." The case study is the killer-app of B2B-developer marketing.
5. **Conference talks** (KubeCon, QCon, Strange Loop) once we have customer-validated case studies. 2027.

### What we're NOT doing

- **Paid acquisition for Pro.** $19/month CAC math doesn't work for paid ads. Pro is OSS-funnel only.
- **Generic "AI tools" SEO.** Doesn't differentiate against the noise.
- **Influencer partnerships.** Not where developers buy.
- **B2C marketing.** The consumer UI exists for developer credibility, not as a B2C product.

### Naming and positioning notes

- **"Multi-agent reasoning"** is the technical category name. Use in technical contexts.
- **"Decision-quality-as-a-service"** is the value-frame name. Use in pricing and enterprise sales contexts.
- **"Auditable AI reasoning"** is the compliance-frame name. Use in regulated-industry contexts.
- **Avoid** "AI debate" (gimmicky), "council of agents" (twee), "swarm intelligence" (overused, technical-religious).

### What success looks like at v1.0 launch

- Pro signups: 1,000 in first 6 months
- Pro paid conversion: 5% (50 paying)
- Team paying accounts: 0-10 (validation, not revenue)
- MRR: $1k-3k (this is a learning quarter, not a revenue quarter)
- GitHub stars: 5,000
- Benchmark publications: 1 (the §1 corpus, with full methodology)
- HN front page: at least one technical post hitting top 10
- Customer case studies in pipeline: 3 named-customer deals where the deliberation transcript caught a real bug or surfaced a real failure mode the team hadn't seen

The revenue tier is Team and Enterprise, and those land in v1.5 and v2.0. v1.0 is for **proving the wedge** with a small paying Pro cohort, the benchmark, and the OSS funnel.
