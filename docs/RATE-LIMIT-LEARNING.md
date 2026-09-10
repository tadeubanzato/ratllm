# Rate-limit learning

RatLLM distinguishes documented, observed, estimated, manual, and unknown limits. Manual values have unconditional precedence. Estimated safe limits are floored after applying a configurable safety factor (default 70%).

`RATE_LIMIT_LEARNING` (`src/server/rate-limits/learn.ts`) runs on a schedule (every 6 hours by default, configurable from the Automation tab) and derives `observedRpm`/`safeRpm` per deployment from its most recent 30 smoke tests: observed is the non-429 count in that window, safe is 70% of observed. A profile with a manual override is skipped entirely. Set a manual RPM/TPM from the Rate Limits page; it is written via `PATCH /api/rate-limits` and is never overwritten by the learning job.

Controlled ramping, evidence expiration, `Retry-After` handling, and provider-specific rate-limit header mappings are not implemented yet — the current model is a fixed rolling window over smoke-test history, not live production traffic (RatLLM is a control plane; inference traffic goes directly to LiteLLM, not through this app).
