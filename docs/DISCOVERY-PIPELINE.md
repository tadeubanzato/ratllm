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
| I10 | **Identity.** A candidate is one model at one provider as one source lists it: unique on `(source, model_ref, provider)`, and rows from different sources that are the same model at the same provider (`provider_id` + `model_key`) merge into one, keeping every source as corroboration. The same model at two providers is two rows and two deployments and never merges across providers, *including when a single source lists it under both* (models.dev lists `gemini-flash-latest` under Google and Vertex). A source cannot corroborate itself. |
| I11 | **Added.** A successful promotion stamps `added_to_litellm_at` and `added_by` (`auto` or `manual`) on the candidate. |
| I12 | **Scale.** No request path loads the whole candidates table. The Discovered Models page is paginated and filtered in SQL, and every hot query is indexed. |
| I13 | **A model's auth error is not the key's verdict.** A 401 or 403 from one model says nothing about the credential (Alibaba trial credits answer 403 "free quota exhausted", OpenCode Zen 401 "no payment method", public-ai 403 "key not allowed to access model"). It triggers the provider's own account-level check, once per pass; only a provider with no such check is invalidated directly on a 401. A real passing call clears a stale "invalid". (`credentialVerdict`) |
| I14 | **Provider call budget.** RatLLM's own calls to one provider (candidate checks and health probes together) are capped per rolling 24 hours (`providers/call-budget-policy.ts`): OpenRouter 24 (its free models share 50 a day with real traffic), self-hosted unlimited, others 200. Candidate checks stop at 60% of the total (checks and probes together); health probes are limited only by their own usage against the whole budget, so discovery can never leave live models unmonitored. Candidates already on a pass streak are checked first. |
| I15 | **Deferred promotions are retried.** A candidate with 5 passes that is not in LiteLLM is retried each verification run once its deferral has expired (up to 20 a run, not limited by the budget, skipping what is already live), instead of waiting for its next scheduled check, which for trial and recurring-quota providers is a day away. |
| I16 | **Checks give reasoning models room to answer.** Every availability test, direct and through LiteLLM, allows `PROBE_MAX_TOKENS` (256) reply tokens; at 128 reasoning models spent it all thinking and were judged unavailable while answering normally. |
| I17 | **The LiteLLM page is the router.** Lists and counts hold only deployments still in LiteLLM (a removed one is found by its own id). The page compares itself with the live router on every load and says so when they differ (`litellm/parity.ts`). A disabled lane takes no new members. |
| I18 | **Promotions run one at a time.** Candidate checks run concurrently, but adding to LiteLLM does not: each promotion registers deployments and runs a full inventory sync, and two at once insert the same rows, so one fails and a model that was added can lose its "Added" stamp. All auto-adds happen in one sequential step after the checks (`autoAddWaiting`), for the hourly job and the manual "test now" alike. |
| I19 | **One incident is one removal.** Deployments of the same candidate removed within 30 minutes count as a single event in its removal history (`withRemoval`). A model in several lanes has several deployments failing for one reason; counting each would flap-limit it (3) after one incident. A model that was added and later removed is retried after its cooldown; a model with a live deployment is not. |
| I20 | **Setup changes take effect at once.** Saving, deleting or disabling a credential, verifying a provider, or changing its base URL recomputes every candidate's blocker immediately, so "Needs setup" and what gets tested never lag the operator by an hour. |

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

## 8. What the real-data runs taught us

Everything above was checked against a restored copy of the production database with the real sources over the real network
(`docs/DISCOVERY-PIPELINE.md` is the spec; these are the findings that shaped it). Each is now covered by a test.

- **Candidate identity must include the provider.** Unique on `(source, model_ref)`, models.dev's 7,865 listings collapsed into ~3,700
  rows: one provider's entry overwrote another's whenever they shared a model id, and the row flipped provider between runs. Nine
  thousand real candidates exist once the provider is part of the identity.
- **One resolver decides the provider.** Five copies used to disagree; consolidation wiped `provider_id` on every run because it
  re-resolved from a stored display name the catalog did not recognise (the identical 44 merges and 44 backfills, every 6 hours).
- **A source's own catalog names its provider.** Five scrapers set no provider hint, so 579 candidates had no provider at all.
- **models.dev publishes provider endpoints** (`api`, and the `npm` SDK that says whether it speaks the OpenAI protocol). Ingesting
  them took "no known endpoint" from 3,615 candidates to 1,638. Those base URLs are SDK-style (the SDK appends `/chat/completions`,
  with no `/v1` assumption), unlike the Base URL a person types on the provider page, which is a host. `endpointBaseHint` keeps the
  two apart.
- **Discovery is idempotent, measured.** After the first run cleans legacy state, a second and third run leave a hash over every
  candidate's structure and evidence unchanged (only OpenRouter's own per-run `lastCatalogCheck` timestamp moves).
- **Identity changes need a "New" baseline.** Correcting identity surfaces thousands of previously hidden (provider, model) pairs in
  the first run. Migration 0017 stores `discovery.baseline_epoch`; each source's first run since then is a baseline, so deploying
  does not put "New" on 4,000 models for a day.
- **"New" has no expiry.** A discovered model keeps the badge until it has been in LiteLLM (live, deactivated or removed), so a model that
  auto-add keeps deferring is not forgotten after a day. Models that can never be added (not a chat model, or reported only by a community
  list) do not carry it; they show their blocker instead. Waiting on a key, an endpoint or free lane capacity keeps the badge.
- **Providers that need no key were untestable.** The verifier demanded a credential row even for Pollinations, LLM7, Kilo's free
  models and Chutes, which serve anonymous requests.
- **Non-chat models were being sent chat calls** (Whisper, TTS, embeddings, image and rerank models): a fifth of all 400s. Sources'
  own `type`/modalities now say so at ingestion, with a name heuristic (tested against chat models that share substrings) as backup.
- **A prefix the verifier strips can be part of the id** (`groq/compound`, NVIDIA's `nvidia/...`), so a 400/404 is retried once with
  the id as discovered before it is recorded as a failure.

## 9. Operating it

- **A source shows BLOCKED** when it needs a key you have not stored (Baseten, Fireworks, MiniMax, Nebius today). Store one under
  Settings → Providers; the next run picks it up, and the state clears by itself.
- **A source shows FAILED** with the recorded reason. Nothing from that run was stored, and the last good data is untouched.
- **A provider shows "Needs base URL"** when no source has published where to send requests. Set one on its provider page.
- **Testing burns quota** for trial and recurring-quota providers, which is why they are tested a quarter as often (§6).
- **Removing a source from `registry.ts`** removes its Settings row on the next run and, after a week without being listed anywhere,
  its models (unless they are in LiteLLM).
- **Known limits.** "Free" is only what a source states. The free-offer text is quoted, never parsed into limits. The 5-pass gate,
  the Added stamp and automatic promotion are verified against a stand-in for LiteLLM, and the promotion path has not been exercised
  against a live router in this refactor.

## Testing end to end

`tests-integration/e2e-autopilot.test.ts` runs RatLLM's real code through the whole loop — provider list, discovery, monitoring, add to
LiteLLM, remove from LiteLLM — against a simulated outside world (`tests-integration/support/fake-world.ts`): free-model providers
(real hostnames for Groq and OpenRouter, invented ones for "Fakecloud" and "Nimbus AI"), sources publishing catalogs, and a LiteLLM
router that speaks the real HTTP protocol (`/model/new`, `/model/delete`, `/model/{id}/update`, `/v1/model/info`, `/fallback`, streaming
chat). Any request to an unregistered host throws, so it can never reach the internet or the live router. Run it with
`pnpm test:integration` (a disposable Postgres on port 55432). It covers: the golden path; new models and providers appearing on later
runs and the "New" badge; a failing source; a provider without a key; a model's auth error versus a revoked key; the daily call
budget and 429 back-off; removal, cooldown, re-add and the flap limit; changes made outside RatLLM, adoption and parity; the auto-add
and auto-remove switches and lane caps; dead versus busy models; and a LiteLLM outage.

