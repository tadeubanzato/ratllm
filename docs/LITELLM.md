# LiteLLM integration

`src/server/litellm` is the compatibility boundary. It validates variable `/v1/model/info` response shapes, derives stable identities, redacts secret-shaped metadata, and exposes smoke tests.

Only `model_info.managed_by == "ratllm-curator"` is managed. Missing markers, prior marker values from earlier renames, and any other arbitrary value are unmanaged and read-only. Future adoption must be explicit and audited.

Model-management payloads will be capability-detected against the configured LiteLLM version before write support is enabled.

## Lane routing (`smart-*`)

`src/server/lanes` turns a discovered candidate into one or more `smart-*` LiteLLM model groups:

- **`rules.ts`** — capability-gated lane eligibility (`smart-vision` needs image input, `smart-agent` needs tool calls, `smart-deep` needs a reasoning flag, `smart-long` needs ≥200k context; `smart-general` / `smart-coding` / `smart-summary` take any chat model, ranked by name and size). Also the cross-lane fallback chains. This is the single source of truth; the seed mirrors a serialized copy into `lanes.eligibility` for audit.
- **`promote.ts`** — `promoteCandidate(candidateId, { lanes, directAlias })`. Preflights the provider through the exact endpoint + credential LiteLLM will use, registers one deployment per target `model_name` (idempotent, retries transient 5xx/429), runs one inventory sync, smoke-tests each new group, and writes `lane_assignments`. Returns a per-target result so a partial failure keeps its successes.
- **`fallbacks.ts`** — `syncFallbackConfig()` pushes the chains to the router via `POST/DELETE /fallback` (needs `STORE_MODEL_IN_DB=True`). Declarative: each `smart-*` group is set to exactly its chain, or cleared. Never touches non-lane models.
- **`reconcile.ts`** — `reconcileLaneMembership()`, run by the `LANE_RECONCILE` automation every 15 minutes. Re-adds any lane member whose router deployment went missing and re-pushes the fallback chains. Never removes a pinned (user-selected) assignment.

The provider credential comes from ratllm's own encrypted store, so promoting a model into several lanes never needs a key to be entered by hand.
