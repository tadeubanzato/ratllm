# Discovery pipeline: sources → providers → models → proof → LiteLLM

This is the contract for the heart of RatLLM. Every change under `src/server/discovery`, `src/server/providers`,
`src/server/lanes/promote.ts` or the Sources / Providers / Discovered Models pages has to keep it true.
`docs/FREE-MODEL-LIFECYCLE.md` describes what happens *after* a model is in LiteLLM; this document describes how a model
gets there.

## 1. The chain

```
Source (registry, in code)            what the world publishes: providers, models, free offers, limits
   │  discover()  →  candidates + offers, validated against the source's contract
   ▼
Provider (derived)                    every provider a source names becomes a provider row
   │                                  (catalog entries enrich it with adapter/endpoint knowledge)
   ▼
Candidate = one model at one provider (provider_id, model_key)
   │  real test call, real credential: did it return content?
   ▼
Proof: 5 consecutive real passes      → "Add to LiteLLM" button, or automatic (Settings → LiteLLM)
   ▼
LiteLLM deployment                    "Added <date>", then the health monitor (FREE-MODEL-LIFECYCLE.md)
```

Each stage is derived from the one before it. Nothing downstream re-guesses what an upstream stage already decided.

## 2. Decisions (confirmed with the project owner, 2026-09-20)

- **Evaluate** means one thing: the model returned content. No quality scoring.
- **Free** is a *kind*, not a boolean: free forever, recurring quota (daily/monthly), trial credits, or unknown. A kind is
  set only when a source proves it; otherwise `UNKNOWN`. Never guessed.
- **Published limits are stored verbatim** (`provider_offers.rate_limits_text`), with the source and its verification date.
  Numbers used to drive routing stay in `rate_limit_profiles` (observed/manual). We never parse prose into numbers and
  present the result as fact, because a wrong number silently mis-routes traffic, while a verbatim quote cannot be wrong.
- **Source grading** exists only where it can be measured (a source's proven-vs-claimed track record, already in
  `getSourceYield`). No editorial scores.
- **Testing burns quota** on trial and quota-based providers, so those are tested less often (§6).
- **Same model at several providers/endpoints** is several candidates and several deployments. An endpoint variant of a
  provider (a regional endpoint, a China/global split) is its own provider row.
- **Adding sources from the UI** is a button only for now; the registry in code stays the source of truth.

## 3. Invariants

Each is enforced by code and covered by a test named for it (`tests-ts/*`, `tests-integration/discovery-pipeline.test.ts`).

| # | Invariant |
|---|---|
| I1 | **One attribution.** `attributeProvider()` (`providers/attribution.ts`) is the only function that maps "what a source reported" to a provider. Writers call it; readers use the stored `provider_id` and never re-derive it. |
| I2 | **Idempotent discovery.** Running discovery twice on the same input changes nothing on the second run: no row created or deleted, no `provider_id`, `first_seen_at` or `model_key` changed. Consolidation is idempotent by the same rule. |
| I3 | **Providers derive from sources.** Any provider a source names gets a provider row (`origin = DISCOVERED` unless the catalog knows it). The slug is a deterministic function of the name. A provider without a known endpoint is visible but untestable, and says why. |
| I4 | **Source contract.** Every source declares a minimum expected result. Fewer results is `FAILED`, never success. A missing credential is `BLOCKED` (an expected waiting state). Some rows rejected is `DEGRADED`. A run is only `PARTIAL` because of a real failure. |
| I5 | **Registry is the truth for what a source is.** `model_sources` rows are exactly the registry entries plus operator-created custom rows. A row for anything else is removed. |
| I6 | **History holds real calls only.** `candidate_checks` records provider responses. States where no call could be made (no credential, not a chat model, no endpoint) are a *blocker on the candidate*, not history, and never break or extend a streak. |
| I7 | **Streak.** `consecutive_passes` counts consecutive real `available` results. Any other real result resets it to 0. |
| I8 | **Promotion gate.** A candidate is eligible after `PROMOTION_PASSES` (5) consecutive passes. Eligible means the button is shown, or the model is added automatically when `autoAdd` is on. A candidate that was removed from LiteLLM keeps the documented human-override button (its last check passed). |
| I9 | **Free is evidence.** `free_type` other than `UNKNOWN` requires a source that states it. Provider offers keep the source's wording. |
| I10 | **Identity.** A candidate is unique per `(provider_id, model_key)`. The same model at two providers is two rows and two deployments and never merges across providers. |
| I11 | **Added.** A successful promotion stamps `added_to_litellm_at` and `added_by` (`auto` or `manual`) on the candidate. |
| I12 | **Scale.** No request path loads the whole candidates table. The Discovered Models page is paginated and filtered in SQL, and every hot query is indexed. |

## 4. Sources

A source is defined once, in `registry.ts`. The database row holds only operator state (enabled, last run).

```ts
SourceConfig {
  id, name, adapter, url, tier,
  minExpected: number,        // I4: fewer results than this is a failure
  providerSlug?: string,      // set when the source is one provider's own API (links source -> provider)
  authEnv?, authOptional?,    // credential the source needs
}
```

Status vocabulary (`model_sources.status`, plus `last_error`, `last_success_at`):
`HEALTHY` · `DEGRADED` (works, some rows rejected) · `FAILED` (error or below `minExpected`) · `BLOCKED` (credential missing).

Prefer a provider's own API over scraping its marketing page. A scraper stays only where no API exists, and then its
`minExpected` makes a silent parser break loud.

## 5. Providers, offers and readiness

`providers.origin` is `CATALOG` or `DISCOVERED`. A provider's readiness is derived, not stored:

`NO_ENDPOINT` → `NEEDS_CREDENTIAL` → `CREDENTIAL_UNVERIFIED` → `READY`

`provider_offers` holds what a source says about a provider's free offer: kind, free-tier text, rate-limit text,
expiry, card/phone requirement, commercial-use flag, OpenAI-compatible base URL, docs URL, and the source's own
`verified`/`last_verified`. The base URL feeds endpoint resolution for providers the catalog has no wiring for.

## 6. Verification

Outcomes of a real call: `available`, `unavailable`, `rate_limited` (429), `auth_error` (401/403),
`out_of_credits` (402 or a balance/credit/quota message; a *provider account* fact, not a model failure).

Blockers (no call is made): `PROVIDER_UNRESOLVED`, `NO_ENDPOINT`, `CREDENTIAL_MISSING`, `CREDENTIAL_UNVERIFIED`,
`NOT_CHAT_MODEL`. They are recomputed cheaply per provider each cycle and cleared the moment their cause is fixed.

Cadence (`verification-policy.ts`, pure and unit-tested): standard providers recheck every 6h and prove new candidates
every 90 min; trial and quota providers recheck every 24h and prove every 6h; `rate_limited` waits 24h;
`out_of_credits` waits 24h. The stripped model id is retried once with the id as discovered before a 400/404 is recorded.

## 7. Same model, several providers

`model_key` (= `bareModelKey(modelRef)`, stored) plus `provider_id` identify a candidate. The Discovered Models page shows
"also listed by N other providers" for a shared `model_key`, worded as *listed*, because the key deliberately ignores
org prefixes and two different uploads can share it. LiteLLM deployments are per provider and already independent.
