/** How many real provider calls RatLLM's own automation (candidate checks and health probes together) may spend on one provider per
 *  rolling day. Free tiers are small and shared with real traffic: OpenRouter's `:free` models allow 50 requests a day across all of
 *  them, so without a ceiling the checks alone used them up (800 calls in a day) and the models then failed for everyone.
 *  Pure, so the numbers and the arithmetic are unit-tested; the SQL that counts usage lives next to the code that uses it. */

export const DEFAULT_DAILY_CALL_BUDGET = 200;

/** Providers with a known small allowance get a smaller share; self-hosted ones cost nothing and are never limited. */
export const PROVIDER_DAILY_CALL_BUDGET: Readonly<Record<string, number>> = {
  openrouter: 24,
  local: Number.MAX_SAFE_INTEGER,
  lemonade: Number.MAX_SAFE_INTEGER,
};

export function dailyCallBudget(slug: string): number {
  return PROVIDER_DAILY_CALL_BUDGET[slug] ?? DEFAULT_DAILY_CALL_BUDGET;
}

/** Calls left today for a provider that has already spent `used`; never negative. */
export function remainingCalls(slug: string, used: number): number {
  return Math.max(0, dailyCallBudget(slug) - Math.max(0, used));
}

/** Share of the day discovery's candidate checks may use. The rest is kept for health probes, which are what keep the models
 *  already in LiteLLM honest, so a long tail of untested candidates can never starve them. */
export const CANDIDATE_CHECK_SHARE = 0.6;

export function remainingCandidateChecks(slug: string, used: number): number {
  return Math.max(0, Math.floor(dailyCallBudget(slug) * CANDIDATE_CHECK_SHARE) - Math.max(0, used));
}

/** Health probes only. Probing is what keeps the models already in LiteLLM honest, so it is limited by its own usage against the whole
 *  budget, never by what discovery spent: a provider that ran hot on candidate checks (or before the budget existed) must not leave
 *  its live deployments unmonitored. Discovery is the one that yields (it stops at CANDIDATE_CHECK_SHARE of the total). */
export const HEALTH_PROBES_LAST_24H_SQL = `select d.provider_id, count(*)::int as n from smoke_tests s join model_deployments d on d.id = s.deployment_id where s.created_at > now() - interval '24 hours' group by d.provider_id`;

/** Real calls a provider has already received in the last 24 hours, from both candidate checks and health probes. Shared so the
 *  two never spend the same allowance twice: drizzle-free SQL text, used as a CTE. */
export const CALLS_LAST_24H_SQL = `select provider_id, count(*)::int as n from (
  select m.provider_id from candidate_checks ch join model_candidates m on m.id = ch.candidate_id where ch.created_at > now() - interval '24 hours'
  union all
  select d.provider_id from smoke_tests s join model_deployments d on d.id = s.deployment_id where s.created_at > now() - interval '24 hours'
) calls group by provider_id`;
