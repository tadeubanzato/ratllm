# Free-model lifecycle: the master design

This is the canonical description of what RatLLM's automation is actually trying to do end to end —
discover free models, prove they work, add the good ones to LiteLLM, and keep that inventory honest
without a human babysitting it. Read this before changing anything under `src/server/discovery`,
`src/server/health`, `src/server/lanes`, or `src/server/automation`. It's the answer to "why does this
job exist and why does it run when it runs."

## 1. The loop

```
Free Model Sources (Settings)
        │  MODEL_DISCOVERY
        ▼
model_candidates  ──────────────────────────────────────────┐  (Providers page: coverage;
        │  CANDIDATE_VERIFICATION                            │   Discovered Models page: full list)
        │  direct-to-provider call, real credential,         │
        │  requires 2xx AND non-empty completion text        │
        ▼                                                     │
  5 consecutive passes? ──no──> keep rechecking on schedule ──┘
        │ yes
        ▼
promoteCandidate() ──> registered in LiteLLM (model_deployments row, managed=true)
        │
        ▼
HEALTH_MONITOR (hourly)
  tests the exact deployment BY ITS LITELLM DEPLOYMENT ID (never the shared alias —
  aliases fan out to every pool member and would misattribute a failure to the wrong row)
        │
        ▼
  5 consecutive real failures (429s never count)? ──no──> stays live, keeps getting checked
        │ yes
        ▼
  removed from LiteLLM (lifecycle REMOVED, litellm_deployment_id cleared)
        │
        ▼
  candidate keeps being checked by CANDIDATE_VERIFICATION forever — it is NEVER blacklisted.
  If it earns 5 fresh passes again (subject to the cooldown/flap rules in §5), it goes back
  through promoteCandidate() and the loop repeats.
```

Two independent proof loops, on purpose:
- **Direct-to-provider** (`verify.ts` / `verify-due.ts`) proves the provider itself still serves the
  model with the exact endpoint + credential LiteLLM would use. This gate must pass before anything
  is added.
- **Through-LiteLLM** (`health/monitor.ts`) proves the model still works *as routed*, which can fail
  for reasons the direct check can't see (LiteLLM-side model-string mapping, proxy-level auth,
  shared-quota exhaustion from LiteLLM's own traffic volume, router misconfiguration).

Never collapse these into one check — a model can pass one and fail the other, and that disagreement
is exactly the signal that tells you *where* the problem is.

## 2. Where each piece of state actually lives

| Concept | Table / column | Notes |
|---|---|---|
| A discovered model, forever | `model_candidates` | Never deleted for failing checks — only deleted by `consolidateModelCandidates` for retired sources or scraped junk. This is what makes "keeps monitoring a removed model" possible. |
| Direct-check history | `candidate_checks` | One row per `verifyCandidateDirectly` call. `autoAddIfEligible` reads the last 5. |
| A live LiteLLM registration | `model_deployments` | **Re-created on every promote**, not reused — `syncLiteLLM` matches by `litellm_deployment_id`, which LiteLLM assigns fresh on every `/model/new` call. A removed-then-re-added model gets a *new* deployment row; the old REMOVED row stays as history. |
| Through-LiteLLM check history | `smoke_tests` | Keyed by `deployment_id`, so history resets with each new deployment row. |
| The stable identity across flaps | `model_candidates.id` (via `model_deployments.raw_metadata.model_info.source_candidate_id`, embedded at add-time and preserved by `sanitizedMetadata`) | This is the join to use for anything that needs to survive a remove→re-add cycle (flap counters, cooldowns) — `model_deployments.id` does not survive it. |
| A one-off editorial "this model was flaky" mark | `canonical_models.lifecycle = QUARANTINED` | Set by auto-remove. **Currently never reset** — see §6. Only feeds one overview count today; nothing else gates on it. |

## 3. Status label taxonomy

**Direct-provider outcomes** (`candidate_checks`, the Availability bars): only real calls are recorded — `available`,
`unavailable`, `rate_limited`, `auth_error`, and `out_of_credits` (a provider-account fact, not a model failure).
States where no call could be made (no provider, not a chat model, no endpoint, no credential, credential not verified) are a
**blocker on the candidate** (`check_blocker`), never history; see `docs/DISCOVERY-PIPELINE.md` §6. The Discovered Models page shows
only what a person can act on (Add credential, Verify credential, Set base URL); every other blocker stays in the database.

**LiteLLM lifecycle** (`/models` → LiteLLM column, `/litellm` page). The `/models` column shows one short pill with the explanation on
hover (`Added <date>`, `Will retry`, `Needs review`, `Deleted`, `Deactivated`); the tables below use the long names:

| State | Badge | Manual "Add to LiteLLM" button shown? |
|---|---|---|
| Not yet added, promotable | *(the button itself)* | — |
| Not yet added, blocked | promotion-blocker reason chip | no |
| Live (`lifecycle=ACTIVE`) | `Added to LiteLLM` (green) + `RatLLM Managed` tag | n/a |
| Manually deactivated (`DEACTIVATED`) | `Deactivated in LiteLLM` (amber) | no — reactivation is its own explicit action on `/litellm`, not a re-add |
| Auto-removed, still eligible (`REMOVED`, flap count under limit) | `Auto-removed — retry pending` (amber/red) | **yes, if promotable** |
| Auto-removed, flap limit hit (`REMOVED`, over limit) | `Auto-removed — needs review` (strong red) | **yes** — this is the human override path |
| Manually deleted (`REMOVED`, no auto-remove reason on record) | `Deleted from LiteLLM` (neutral) | **yes, if promotable** |

The key change from today: **`REMOVED` must never permanently hide the re-add path.** Right now the
UI shows the badge *instead of* the button once lifecycle is `REMOVED`, forever — so once automation
pulls a model, a person has no way to force it back even after fixing whatever was wrong, and no visual
cue that automation might quietly re-add it on its own. Badge and button are not mutually exclusive.

`RatLLM Managed` (already shipped on `/litellm`) should also appear next to `Added to LiteLLM` on
`/models`, so both pages give the same ownership signal.

## 4. Automation schedule

| Job | Schedule | Rationale |
|---|---|---|
| `MODEL_DISCOVERY` | `0 */6 * * *` | Source catalogs don't churn faster than this. |
| `CANDIDATE_VERIFICATION` | `20 * * * *` (hourly — **changed from every 6h**) | The cron cadence is the ceiling on how promptly a "due" candidate gets picked up; per-candidate recheck delay (§6) is the actual throttle on request volume, not this. Needed for the fast-track ramp to mean anything. |
| `HEALTH_MONITOR` | `0 * * * *` | Already hourly as of the last change; this is the freshest signal against the smallest population (only live deployments), so hourly is the right order of magnitude. |
| `RATE_LIMIT_LEARNING` | `30 */6 * * *` | Derived from smoke-test history; no urgency. |
| `PROVIDER_VERIFICATION` | `45 */6 * * *` | Credential validity is slow-moving. |
| `APPLY_APPROVED_PLANS` | `10 * * * *` (**staggered off :00**) | Reconciles RatLLM's view against LiteLLM's live router. Was colliding at the top of every hour with `HEALTH_MONITOR`/`LANE_RECONCILE`; staggering avoids three jobs hitting DB + LiteLLM at the same instant for no benefit. |
| `LANE_RECONCILE` | `5 * * * *` (**staggered off :00**) | Same staggering reason. Cadence itself (hourly) was a deliberate earlier call ("mostly a no-op") — not changing that, just the collision. |
| `DEEP_BENCHMARK` | `0 3 * * *` | Nightly broad sweep (limit 100 vs. the regular 25) — fine as a once-a-day catch-all. |
| `MAINTENANCE` | `30 3 * * *` | Cleanup, no urgency. |

## 5. Auto-remove / auto-re-add safety (cooldown + flap limit)

Decision: **combine a cooldown with a flap counter.** A pure cooldown never stops a model that's
genuinely fine standalone but broken specifically through LiteLLM from cycling forever (removed →
direct checks still pass → re-added → fails through LiteLLM again → removed...). A pure flap limit
with no cooldown lets a hair-trigger remove-then-immediately-readd happen within the same check cycle.

- **`REMOVE_COOLDOWN_MS = 6h`** — matches one full standard recheck cycle. `autoAddIfEligible` must
  see `now - lastRemovedAt >= 6h` before it will even consider re-promoting, even if 5 fresh passes
  already exist.
- **`FLAP_LIMIT = 3` auto-removals within a rolling 30-day window** — once hit, `autoAddIfEligible`
  stops proposing re-add entirely for that candidate. The UI switches to `Auto-removed — needs review`
  and re-offers the manual `Add to LiteLLM` button (§3). A manual add resets the flap counter — a human
  looked at it, that's the reset trigger, not the passage of time.
- **Where it's tracked:** `model_candidates.evidence.removalHistory` (append-only, timestamp + reason),
  keyed off the stable `model_candidates.id` (see §2 — this cannot live on `model_deployments`, since
  that row doesn't survive a flap). `autoRemoveIfFailing` in `health/monitor.ts` is the write site: it
  already has `deployment.raw_metadata.model_info.source_candidate_id` available at the moment it
  removes a deployment, which is the join back to the candidate.

## 5a. What counts as a failure (auto-remove evidence)

Auto-remove acts on a streak of consecutive failed health checks (`AUTO_REMOVE_AFTER_FAILURES`, opt-in via the Settings
auto-remove toggle), so what counts toward the streak decides what gets deleted. A failed check only counts as evidence about
the *deployment* when nothing broader explains it. The rules live in `src/server/health/probe-policy.ts`.

| Recorded as | Meaning | Counts toward removal? |
|---|---|---|
| `UNAVAILABLE` / `DEGRADED` (5xx, timeout, 404/410, empty) | The deployment failed on its own | **Yes** |
| `RATE_LIMITED` (429) | The provider answered; it's busy | No — neutral |
| `AUTH_ERROR` (401/403) | The provider rejected the *credential*; every deployment made with that key fails alike | No — neutral. Shown as `AUTH_ERROR`; fix the key, don't delete the models |
| `SYSTEMIC` | The failure happened during a wider incident (below) | No — neutral |

"Neutral" means the row neither adds to a streak nor breaks one already building from genuine failures.

**Incidents.** The monitor probes a whole run first, then judges it before any removal is decided:

- *Router unreachable* — no probe got any HTTP response.
- *Widespread* — at least 6 probes and at least 60% failed genuinely.
- *Provider-wide* — at least 3 probes for one provider and **every** one of them failed.

Failures during an incident are re-tagged `SYSTEMIC` (the deployment's health still shows what was observed), logged at `warn`, and
recorded as a `litellm.health.systemic_failure` audit event.

**The shield expires.** Incident protection only covers a deployment that **passed a check within the last 24 hours**. Without
that limit a provider that retires all its models at once would look like a permanent incident and its dead deployments would never
be cleaned up. After 24 hours without a pass, failures count again and the normal streak removes them. A deployment that has never
passed is never shielded.

## 6. Fast-track ramp for new candidates

> Superseded in part by `docs/DISCOVERY-PIPELINE.md` §6: the streak is stored (`consecutive_passes`) rather than re-read from history, a
> candidate is eligible after `PROMOTION_PASSES` (5) consecutive *real* passes, and trial / recurring-quota providers are tested a
> quarter as often (24h recheck, 6h while proving) because a test spends their quota. The rest of this section still holds.

Decision: **fast-track only candidates still proving themselves**, not everyone — steady-state request
volume against providers must not multiply just because most candidates are already known-good or
known-bad and sitting on the standard cadence.

- A candidate that has **never yet failed a direct check** and **hasn't reached 5 consecutive passes**
  yet is "proving" — recheck it every **~90 minutes** instead of 6h while in that state.
- The moment it either (a) gets promoted, or (b) fails once, it drops to the standard `SUCCESS_RECHECK_MS`
  / `FAILURE_RECHECK_MS` (6h) cadence permanently (barring the flap-limit path in §5, which is a
  different state).
- Combined with the hourly `CANDIDATE_VERIFICATION` cron (§4), a good new candidate can realistically
  reach 5-in-a-row in ~7–8h instead of the current ~30h floor.

## 7. Known implementation seams

- `verify-due.ts`'s `checkCandidate` already inserts the `candidate_checks` row and *then* calls
  `autoAddIfEligible` — the cooldown/flap check belongs inside `autoAddIfEligible`, right next to the
  existing `if (row.liteLLMDeploymentId || !row.promotable) return;` guard.
- `health/monitor.ts`'s `autoRemoveIfFailing` is the only write site for the flap counter — it already
  has the deployment row in hand when it decides to remove.
- `models/page.tsx`'s `litellmCell` ternary (`liteLLMLifecycle==="REMOVED" ? badge : ... button`) is
  the exact spot that currently makes badge and button mutually exclusive — needs to become "badge
  *and*, separately, button-if-promotable," reading the new flap/cooldown state to pick which badge
  variant.
- Quarantine reset (§2 table, last row): `litellm/sync.ts`'s canonical-model upsert (`if (!model) insert
  ACTIVE`) needs an `else` branch that flips an existing `QUARANTINED` row back to `ACTIVE` when a new
  deployment for it goes live again. Purely cosmetic (nothing currently gates on this field) but it
  should stop lying.

## 8. Decision log

- **2026-09-13** — Confirmed with the project owner: auto-re-add safety = cooldown (6h) + flap limit
  (3 per 30 days, manual add resets it). Ramp speed = fast-track only unproven candidates (~90m
  recheck until first failure or promotion), not a global speedup. `CANDIDATE_VERIFICATION` moves to
  hourly to make the fast-track meaningful. `APPLY_APPROVED_PLANS`/`LANE_RECONCILE` staggered off the
  top of the hour to stop colliding with `HEALTH_MONITOR`. `REMOVED` lifecycle must stop permanently
  hiding the manual re-add button.
- **2026-09-13** — All of the above implemented same day: `src/server/discovery/auto-add-policy.ts`
  (cooldown/flap-limit, unit-tested in `tests-ts/auto-add-policy.test.ts`), the fast-track ramp and
  cooldown/flap gate wired into `discovery/verify-due.ts`, flap-history recording wired into
  `health/monitor.ts`'s `autoRemoveIfFailing`, manual-promotion flap reset wired into
  `lanes/promote.ts` (new `PromoteOptions.trigger`), quarantine reset wired into `litellm/sync.ts`,
  the badge/button coexistence and `RatLLM Managed` tag wired into `app/models/page.tsx`, and the
  schedule changes applied in `automation/schedule.ts`. Verified with `tsc --noEmit`, `vitest run`
  (70 passing), `eslint`, and a production `next build` — all clean.
- **2026-09-14** — First real flap under the new hardening: `meta-llama/llama-prompt-guard-2-{22m,86m}`
  (Groq) passed direct verification 12+ times in a row and got auto-promoted, then auto-removed after
  5 real health-monitor failures. Root cause: these are safety/classifier models, not chat models —
  Groq's live API rejects `stream: true` on `/v1/chat/completions` for them (`text classification
  models do not support streaming`), and `verify.ts` never sets `stream` so it can't see this, while
  `client.ts`'s `smokeTest` always does. Confirmed this is genuinely invisible in every metadata source
  we have — models.dev reports `modalities: {input: [text], output: [text]}` and LiteLLM's own cost
  map reports `mode: "chat"` for both; only the live Groq call reveals it, and only the model's
  name/family or models.dev's free-text `description` hint at it structurally. Added
  `discovery/model-type.ts`'s `nonChatModelReason` (name-pattern + description-keyword heuristic for
  known guard/classifier families — Prompt Guard, Llama Guard, ShieldGemma, Granite Guardian, WildGuard)
  and wired it into both `queries.ts`'s `promotableReason` (blocks the UI button) and
  `lanes/promote.ts`'s `resolvePromotionContext` (blocks the write path itself, so auto-add and manual
  add can't bypass it) — this is a heuristic on a name, not a structural modality check, because no
  such field reliably exists upstream.
  Separately, noticed the "Add to LiteLLM" button was showing for candidates with zero passing checks
  ever (e.g. OpenRouter's `google/lyria-3-*` — a music-generation model, not chat — stuck at 0%
  availability, HTTP 400 on every real attempt). `promotable` never looked at check history before this,
  only at provider/credential/endpoint resolution. Added `auto-add-policy.ts`'s `unprovenCheckReason`
  (blocks the button — and thus manual promotion — unless the candidate's most-recent direct check
  actually passed) into the same `promotableReason` chain. This only narrows the *first-time*
  promotion path: a flap-limited "needs review" or manually-deleted candidate reaches this same
  `lastStatus` field through its own ongoing recheck cycle and, by construction, keeps passing directly
  (that disagreement with LiteLLM is what makes it flap-limited in the first place) — so the
  human-override button those cases are supposed to keep stays intact. The only route into LiteLLM for
  an unproven or non-chat candidate now is the automatic 5-consecutive-pass path (§6), same as BAU.

- **2026-09-21** — Autopilot audit, end to end (discover → verify → add → monitor → remove) against the live router. Found and fixed:
  a single model's 401/403 was invalidating the provider's whole credential, which deferred every model of that provider for hours
  (I13); RatLLM's own probes were spending free tiers (803 OpenRouter calls in a day against a 50/day cap) with no ceiling (I14);
  a deferred candidate waited up to a day for its next check before auto-add tried again (I15); reasoning models were judged
  unavailable at a 128-token reply budget (I16); the LiteLLM page, overview count and benchmarks counted removed deployments as
  live and could not tell when they were out of step with the router (I17); adoption rejected valid deployments whose metadata
  held empty fields (`null`, `[]`, `{}`) that the router leaves out after an update. Operational notes: lane caps live in
  `LANE_RULES` (code), not in the database; auto-add defers a model whose recommended lanes are full (`smart-general` is fed by five
  self-hosted models), which is by design; RatLLM runs all of its own schedules, so no external scheduler is needed.
- **2026-09-21 (end-to-end suite)** — Added the simulated-world E2E suite (docs/DISCOVERY-PIPELINE.md, "Testing end to end"). It found and
  fixed: concurrent auto-adds racing on the inventory sync (I18); one incident writing one removal per lane, so a model in three lanes was
  flap-limited by a single failure (I19); the "Needs setup" list staying stale for up to an hour after an operator added a key (I20); and
  a regression in the deferred-retry step that stopped a removed model from ever being auto-re-added.
- **2026-09-21 (after merge)** — Two reports from the Discovered Models page. (1) `qwen-flash`, `qwen-max`, `qwen-plus-latest` showed "Add to LiteLLM"
  while live, and a click added extra lane copies: candidate/deployment matching kept the `openai/` routing prefix for names without a digit
  (I21). (2) Groq's Prompt Guard 2 models showed "R" and "Will retry" after being auto-removed: the removal came from the health probe
  streaming a model that cannot stream (I22), and the page read the removed deployment's "managed" flag. A manual direct-alias-only override
  now exists for classifiers that answer chat (I23).

