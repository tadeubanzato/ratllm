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

**Direct-provider availability** (`/models` → Availability column, from `availabilityFor()`):
`AVAILABLE`, `RATE_LIMITED`, `UNAVAILABLE`, `AUTH_ERROR`, `CREDENTIAL_MISSING`, `CREDENTIAL_UNVERIFIED`,
`PROVIDER_UNRESOLVED`, `VERIFIER_NOT_CONFIGURED`, `QUEUED`. This taxonomy is fine as-is.

**LiteLLM lifecycle** (`/models` → LiteLLM column, `/litellm` page):

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

## 6. Fast-track ramp for new candidates

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
