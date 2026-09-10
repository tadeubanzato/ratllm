# Rate-limit learning

RatLLM distinguishes documented, observed, estimated, manual, and unknown limits. Manual values have unconditional precedence. Estimated safe limits are floored after applying a configurable safety factor (default 70%).

Milestone 1 creates the normalized profile and tested policy. Controlled ramping, rolling confidence, evidence expiration, Retry-After handling, and provider header mappings are deferred until every probe can be persisted safely.
