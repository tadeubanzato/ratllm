/** Registry of discovery sources. Every entry produces `DiscoveredCandidate[]` rows whose `verifiedFree` flag controls
 *  whether the candidate is trusted as genuinely free at discovery time, which in turn gates the auto-add path through
 *  `getModelCandidates()` → `autoAdd` in `litellm-management.ts`. Entries whose source adapter can only prove model
 *  *presence* (not free status) always emit `verifiedFree: false` and land in `model_candidates.verified_free = false`
 *  until a separate verification pass lifts them. Entries whose adapter carries its own free-proof signal (an explicit
 *  zero-cost field, a `:free` variant suffix, etc.) emit `verifiedFree: true` immediately. Sources marked
 *  `defaultEnabled: false` are still discoverable in the settings UI but do not run in the background unless the user
 *  enables them explicitly.
 *
 *  Each source also receives a tier ("A1" | "A2") that feeds the settings page's confidence column and the audit
 *  report's "Source Tier" column. A1 means the source itself proves free status (zero-cost API field, `:free` variant,
 *  etc.); candidates are `verifiedFree: true` at discovery time with no further verification needed. A2 means the
 *  source only proves presence; candidates are `verifiedFree: false` at discovery time and need a separate verification
 *  pass to be trusted as free.
 *
 *  GitHub Models was fully retired on 2026-07-30 (docs.github.com/en/rest/models/catalog) — the source has been
 *  removed from this registry. OVHcloud's `api.ovhcloud.ai` endpoint has been unreachable since the source was added
 *  (DNS/connection failures observed across multiple discovery runs) — also removed. Both removals are recorded in
 *  docs/models_source.md's audit trail.
 *
 *  docs/DISCOVERY-PIPELINE.md §4 is the contract every entry here must meet: a `minExpected` (fewer results is a failure,
 *  never a success) and, for a provider's own catalog, the `providerSlug` it belongs to. Prefer the provider's own API to a
 *  scraped marketing page; a scraper stays only where no API exists. */
export interface SourceConfig {
  id: string;
  name: string;
  authEnv?: string;
  authOptional?: boolean;
  providerHint?: string;
  listKey?: string;
  idField?: string;
  urls?: string[];
  focusTerms?: string[];
  scanRawHtml?: boolean;
  defaultFreeType?: "FREE_TIER" | "UNKNOWN" | "RECURRING_CREDIT" | "TRIAL_QUOTA" | "PROVIDER_SPECIFIC_FREE";
  providers?: string[];
  url: string;
  adapter: string;
  tier: "A1" | "A2";
  defaultEnabled: boolean;
  description?: string;
  candidateOnly?: boolean;
  registrationUrl?: string;
  refreshHours?: number;
  /** Fewer results than this is a FAILED source (I4). Set to what the source reliably returns, with headroom for churn. */
  minExpected: number;
  /** The catalog provider this source is the own catalog of. Every candidate it returns belongs to that provider (I1), and
   *  the source row is linked to it. Leave unset for sources that name their own providers (models.dev, LiteLLM, ...). */
  providerSlug?: string;
  /** A prefix the API puts on every id that is not part of the model's real id (Google returns "models/gemini-2.5-pro"). */
  stripIdPrefix?: string;
}

/** The shared source registry. Each entry is used by both the runtime discovery pipeline (via `discoverySources` in
 *  sources.ts, which maps every registry entry through `buildSource`) and the settings page (which renders every entry
 *  as a row). There is a strict 1:1 correspondence between registry entries and live source instances — one registry
 *  entry, one source instance, one row in the settings UI. Adding a source means adding exactly one entry here; removing
 *  a source means removing exactly one entry here. */
export const sourceRegistry: SourceConfig[] = [
  // ── Provider-published catalogs: the provider's own API, authoritative on which models exist ────────────────────────
  // Presence only (tier A2): a listing proves a model is live, never that it is free — free status comes from the source's
  // own price/flag fields where it publishes them, and from provider offers (freellmapihub), never from a guess.

  // OpenRouter's public catalog. Free is proven by :free suffix or zero prompt/completion price.
  {id: "openrouter", authEnv: "OPENROUTER_API_KEY", authOptional: true, providerHint: "openrouter", providerSlug: "openrouter", minExpected: 5, url: "https://openrouter.ai/api/v1/models", tier: "A1", name: "OpenRouter Public Catalog", defaultEnabled: true, adapter: "openrouter"},

  // LiteLLM's maintained cost map of LLM APIs. Zero input+output cost on a chat model is the free signal; self-hosted
  // backends are excluded since zero cost there means your own infra, not a hosted free API.
  {id: "litellm_costmap", minExpected: 20, url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", tier: "A1", name: "LiteLLM Cost Map (Community)", defaultEnabled: true, adapter: "litellm_costmap"},

  {id: "cerebras", authEnv: "CEREBRAS_API_KEY", authOptional: true, providerHint: "cerebras", providerSlug: "cerebras", minExpected: 1, url: "https://api.cerebras.ai/v1/models", tier: "A2", name: "Cerebras Inference", defaultEnabled: true, adapter: "openai_models"},

  // Google's OpenAI-compatible listing. The native /v1beta/models endpoint rejects a Bearer key (401) and uses a different shape.
  {id: "gemini", authEnv: "GEMINI_API_KEY", authOptional: false, providerHint: "google_ai_studio", providerSlug: "google-ai-studio", minExpected: 20, stripIdPrefix: "models/", url: "https://generativelanguage.googleapis.com/v1beta/openai/models", tier: "A2", name: "Google Gemini API", defaultEnabled: true, adapter: "openai_models"},

  {id: "deepseek", authEnv: "DEEPSEEK_API_KEY", authOptional: false, providerHint: "deepseek", providerSlug: "deepseek", minExpected: 1, url: "https://api.deepseek.com/v1/models", tier: "A2", name: "DeepSeek API", defaultEnabled: true, adapter: "openai_models"},

  // Needs a MiniMax key. Until one is stored under Settings → Providers this is BLOCKED (an expected waiting state).
  {id: "minimax", authEnv: "MINIMAX_API_KEY", authOptional: false, providerHint: "minimax", providerSlug: "minimax", minExpected: 1, url: "https://api.minimax.chat/v1/models", tier: "A2", name: "MiniMax API", defaultEnabled: true, adapter: "openai_models"},

  // Vercel's own gateway listing (public, with per-model price and type). It used to point at api.openai.com, a guaranteed 401.
  {id: "vercel_ai_gateway", authEnv: "VERCEL_AI_GATEWAY_API_KEY", authOptional: true, providerHint: "vercel_ai_gateway", providerSlug: "vercel-ai-gateway", minExpected: 100, url: "https://ai-gateway.vercel.sh/v1/models", tier: "A2", name: "Vercel AI Gateway", defaultEnabled: true, adapter: "openai_models"},

  // Hugging Face Hub search across multiple inference providers. Free status is an account-level entitlement.
  {id: "huggingface", authEnv: "HF_TOKEN", authOptional: true, minExpected: 100, providers: ["hf", "black-forest-labs", "nvidia", "databricks", "meta", "microsoft", "openai", "google", "anthropic", "cohere"], url: "https://huggingface.co/api/models", tier: "A2", name: "Hugging Face Hub (Multi-Provider)", defaultEnabled: true, adapter: "huggingface", refreshHours: 24},

  {id: "groq", authEnv: "GROQ_API_KEY", authOptional: false, providerHint: "groq", providerSlug: "groq", minExpected: 5, url: "https://api.groq.com/openai/v1/models", tier: "A2", name: "Groq Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  {id: "nvidia_nim", authEnv: "NVIDIA_NIM_API_KEY", authOptional: true, providerHint: "nvidia", providerSlug: "nvidia", minExpected: 30, url: "https://integrate.api.nvidia.com/v1/models", tier: "A2", name: "NVIDIA NIM Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  {id: "alibaba", authEnv: "DASHSCOPE_API_KEY", authOptional: false, providerHint: "alibaba-model-studio", providerSlug: "alibaba-model-studio", minExpected: 50, url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", tier: "A2", name: "Alibaba Cloud Model Studio", defaultEnabled: true, adapter: "openai_models"},

  {id: "zai", authEnv: "ZAI_API_KEY", authOptional: false, providerHint: "zhipu", providerSlug: "zhipu", minExpected: 5, url: "https://api.z.ai/api/paas/v4/models", tier: "A2", name: "Z.AI Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  {id: "kilo", authEnv: "KILO_API_KEY", authOptional: true, providerHint: "kilo", providerSlug: "kilo", minExpected: 100, url: "https://api.kilo.ai/api/gateway/models", tier: "A2", name: "Kilo Cloud Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  {id: "modelscope", authEnv: "MODELSCOPE_API_KEY", authOptional: true, providerHint: "modelscope", providerSlug: "modelscope", minExpected: 10, url: "https://api-inference.modelscope.cn/v1/models", tier: "A2", name: "ModelScope Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  // These three list models only for an authenticated caller (401 without a key), so they are BLOCKED until a key is stored.
  {id: "nebius", authEnv: "NEBIUS_API_KEY", authOptional: false, providerHint: "nebius", providerSlug: "nebius", minExpected: 5, url: "https://api.tokenfactory.nebius.com/v1/models", tier: "A2", name: "Nebius AI Studio (Token Factory)", defaultEnabled: true, adapter: "openai_models"},
  {id: "baseten", authEnv: "BASETEN_API_KEY", authOptional: false, providerHint: "baseten", providerSlug: "baseten", minExpected: 1, url: "https://inference.baseten.co/v1/models", tier: "A2", name: "Baseten Model Catalog", defaultEnabled: true, adapter: "openai_models"},
  {id: "fireworks_ai", authEnv: "FIREWORKS_API_KEY", authOptional: false, providerHint: "fireworks", providerSlug: "fireworks", minExpected: 10, url: "https://api.fireworks.ai/inference/v1/models", tier: "A2", name: "Fireworks AI Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  // Pollinations lists a single anonymous model today; the contract accepts that and fails on none.
  {id: "pollinations", providerHint: "pollinations", providerSlug: "pollinations", minExpected: 1, url: "https://text.pollinations.ai/openai/models", tier: "A2", name: "Pollinations AI", defaultEnabled: true, adapter: "openai_models"},

  // Together's list is a bare JSON array with a `type` per model (chat / embedding / image / ...).
  {id: "together_ai", authEnv: "TOGETHER_API_KEY", authOptional: false, providerHint: "together-ai", providerSlug: "together-ai", minExpected: 50, url: "https://api.together.xyz/v1/models", tier: "A2", name: "Together AI Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  {id: "chutes_ai", providerHint: "chutes", providerSlug: "chutes", minExpected: 5, url: "https://llm.chutes.ai/v1/models", tier: "A2", name: "Chutes AI Model Catalog", defaultEnabled: true, adapter: "openai_models"},

  // ── The one source kept as a scraper: Cloudflare's listing needs an account id, so its public catalog page is all there is.
  // scanRawHtml because the model ids live in data-* attributes. minExpected makes a silent parser break loud.
  {id: "cloudflare_workers_ai", providerSlug: "cloudflare-workers-ai", minExpected: 80, url: "https://developers.cloudflare.com/workers-ai/models/", tier: "A2", name: "Cloudflare Workers AI Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: true, focusTerms: ["@cf", "model", "free", "Workers AI"]},

  // ── Cross-provider datasets: these name their own providers ────────────────────────────────────────────────────────

  // freellmapihub: one JSON object per provider with its free models AND its free offer (type, limits text, expiry, card
  // requirement, OpenAI-compatible base URL, last verification). Both are ingested (docs/DISCOVERY-PIPELINE.md §5).
  {id: "freellmapihub", minExpected: 30, url: "https://freellmapihub.com/api/v1/providers.json", tier: "A2", name: "freellmapihub Provider Dataset", defaultEnabled: true, adapter: "provider_dataset"},

  // models.dev's combined catalog: keyed by provider, each with a nested object of models. `cost.input === 0 && cost.output
  // === 0` is the free signal; absent `cost` means unknown, not free.
  {id: "models_dev", minExpected: 3000, url: "https://models.dev/api.json", tier: "A1", name: "models.dev Combined Catalog", defaultEnabled: true, adapter: "models_dev"},
];
