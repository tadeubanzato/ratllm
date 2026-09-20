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
 *  docs/models_source.md's audit trail. */
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
}

/** The shared source registry. Each entry is used by both the runtime discovery pipeline (via `discoverySources` in
 *  sources.ts, which maps every registry entry through `buildSource`) and the settings page (which renders every entry
 *  as a row). There is a strict 1:1 correspondence between registry entries and live source instances — one registry
 *  entry, one source instance, one row in the settings UI. Adding a source means adding exactly one entry here; removing
 *  a source means removing exactly one entry here. */
export const sourceRegistry: SourceConfig[] = [
  // ── Long-standing sources (pre-2026-09-19 audit) ────────────────────────────

  // OpenRouter's public catalog. Free is proven by :free suffix or zero prompt/completion price.
  {id: "openrouter", authEnv: "OPENROUTER_API_KEY", authOptional: true, providerHint: "openrouter", url: "https://openrouter.ai/api/v1/models", tier: "A1", name: "OpenRouter Public Catalog", defaultEnabled: true, adapter: "openrouter"},

  // LiteLLM's maintained cost map of LLM APIs. Zero input+output cost on a chat model is the free signal; self-hosted
  // backends are excluded since zero cost there means your own infra, not a hosted free API.
  // Added 2026-09-11 per docs/models_source.md's audit against sourceRegistry.
  // Updated 2026-09-19: the community beevelop mirror is gone (404); use the canonical BerriAI/litellm repo.
  {id: "litellm_costmap", url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", tier: "A1", name: "LiteLLM Cost Map (Community)", defaultEnabled: true, adapter: "litellm_costmap"},

  // Cerebras' Wafer AI inference platform. Free tier available.
  {id: "cerebras", authEnv: "CEREBRAS_API_KEY", authOptional: true, providerHint: "cerebras", url: "https://api.cerebras.ai/v1/models", tier: "A2", name: "Cerebras Inference", defaultEnabled: true, adapter: "openai_models"},

  // Google's Gemini API. Free tier with rate limits.
  {id: "gemini", authEnv: "GEMINI_API_KEY", authOptional: false, providerHint: "google_ai_studio", url: "https://generativelanguage.googleapis.com/v1beta/models", tier: "A2", name: "Google Gemini API", defaultEnabled: true, adapter: "openai_models"},

  // DeepSeek's API. Free tier available.
  {id: "deepseek", authEnv: "DEEPSEEK_API_KEY", authOptional: false, providerHint: "deepseek", url: "https://api.deepseek.com/v1/models", tier: "A2", name: "DeepSeek API", defaultEnabled: true, adapter: "openai_models"},

  // MiniMax's API. Free tier available.
  {id: "minimax", authEnv: "MINIMAX_API_KEY", authOptional: false, providerHint: "minimax", url: "https://api.minimax.chat/v1/models", tier: "A2", name: "MiniMax API", defaultEnabled: true, adapter: "openai_models"},

  // Vercel AI Gateway. Free tier available.
  {id: "vercel_ai_gateway", authEnv: "VERCEL_AI_GATEWAY_API_KEY", authOptional: true, providerHint: "vercel_ai_gateway", url: "https://api.openai.com/v1/models", tier: "A2", name: "Vercel AI Gateway", defaultEnabled: true, adapter: "openai_models"},

  // Hugging Face Hub search across multiple inference providers. Free status is an account-level entitlement.
  // Enabled by default 2026-09-19 per docs/models_source.md audit — 1227 candidates were sitting unverified with
  // defaultEnabled: false; enabling the source unlocks them for discovery.
  {id: "huggingface", authEnv: "HF_TOKEN", authOptional: true, providers: ["hf", "black-forest-labs", "nvidia", "databricks", "meta", "microsoft", "openai", "google", "anthropic", "cohere"], url: "https://huggingface.co/api/models", tier: "A2", name: "Hugging Face Hub (Multi-Provider)", defaultEnabled: true, adapter: "huggingface", refreshHours: 24},

  // ── Text scraper sources (A2: presence only, free status unconfirmed) ───────

  // Groq's model catalog page. Scrape for model IDs.
  {id: "groq", url: "https://groq.com/models", tier: "A2", name: "Groq Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["free", "GPU", "LPU", "model"]},

  // NVIDIA NIM's model catalog. Scrape for model IDs.
  {id: "nvidia_nim", url: "https://build.nvidia.com/models", tier: "A2", name: "NVIDIA NIM Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["free", "NIM", "model", "API"]},

  // Alibaba Cloud's model catalog. Scrape for model IDs.
  {id: "alibaba", url: "https://www.alibabacloud.com/help/en/model-studio/developer-guide/use-qwen-by-calling-api", tier: "A2", name: "Alibaba Cloud Model Studio", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["qwen", "model", "API", "free"]},

  // Z.AI's model catalog. Scrape for model IDs.
  {id: "zai", url: "https://zai.dev/docs/api/reference/models", tier: "A2", name: "Z.AI Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["glm", "model", "API", "free"]},

  // Kilo Cloud's model catalog. Scrape for model IDs.
  {id: "kilo", url: "https://kilo.ai/models", tier: "A2", name: "Kilo Cloud Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["kilo", "model", "API", "free"]},

  // Cloudflare Workers AI's model catalog. Scrape for model IDs (scanRawHtml because model ids live in data-* attributes).
  {id: "cloudflare_workers_ai", url: "https://developers.cloudflare.com/workers-ai/models/", tier: "A2", name: "Cloudflare Workers AI Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: true, focusTerms: ["@cf", "model", "free", "Workers AI"]},

  // ── Provider dataset source (A2: presence only, from freellmapihub) ─────────

  // freellmapihub's provider dataset: a JSON file listing providers and their free models.
  // Added 2026-09-11 per docs/models_source.md's audit against sourceRegistry.
  // Updated 2026-09-19: dataset moved from GitHub raw to the project's own API domain.
  {id: "freellmapihub", url: "https://freellmapihub.com/api/v1/providers.json", tier: "A2", name: "freellmapihub Provider Dataset", defaultEnabled: true, adapter: "provider_dataset"},

  // models.dev's combined catalog: an object keyed by provider slug, each holding a nested object of models keyed by
  // model id (never a flat list) — the one shape none of the other adapters can parse. No auth, no observed rate
  // limit. `cost.input === 0 && cost.output === 0` is the free signal; absent `cost` means unknown, not free.
  // Added 2026-09-11 per docs/models_source.md's audit against sourceRegistry.
  // Updated 2026-09-19: the API moved from api.models.dev/v1/models to models.dev/api.json.
  {id: "models_dev", url: "https://models.dev/api.json", tier: "A1", name: "models.dev Combined Catalog", defaultEnabled: true, adapter: "models_dev"},

  // ── 2026-09-19: NEW sources added from web research ─────────────────────────

  // ModelScope's model catalog. Scrape for model IDs. ModelScope provides free API-Inference for registered users
  // (modelscope.ai/docs/model-service/API-Inference/intro).
  {id: "modelscope", url: "https://modelscope.ai/models", tier: "A2", name: "ModelScope Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["ModelScope", "API-Inference", "open-source", "model"]},

  // Nebius AI Studio (Token Factory). $1 trial credit, no credit card required.
  // Sources: freellmapihub.com/p/nebius, freellm.site/providers/nebius, free-llm.com/provider/nebius
  {id: "nebius", url: "https://freellmapihub.com/p/nebius", tier: "A2", name: "Nebius AI Studio (Token Factory)", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["nebius", "token factory", "studio", "model", "free"]},

  // Baseten. Deploy open-source models on GPU. No fixed catalog — deploys any open-source model.
  // Source: openrouter.ai/blog/tutorials/free-llm-apis-compared (2026 comparison)
  {id: "baseten", url: "https://www.baseten.com/models", tier: "A2", name: "Baseten Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["baseten", "truss", "open-source", "model", "free"]},

  // Pollinations. Anonymous free access to GPT-OSS 20B.
  {id: "pollinations", url: "https://pollinations.ai/pricing", tier: "A2", name: "Pollinations AI", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["pollinations", "free", "gpt-oss", "model"]},

  // Fireworks AI. Trial credits, broad open model catalog.
  // Source: fireworks.ai/blog/best-llm-api-providers (2026 review)
  {id: "fireworks_ai", url: "https://fireworks.ai/models", tier: "A2", name: "Fireworks AI Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["fireworks", "free", "trial", "model"]},

  // Together AI. Small free credits, 100+ open models.
  {id: "together_ai", url: "https://www.together.ai/pricing", tier: "A2", name: "Together AI Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["together", "free", "trial", "model"]},

  // Chutes AI. Free tier, thousands of open models.
  {id: "chutes_ai", url: "https://chutes.ai/models", tier: "A2", name: "Chutes AI Model Catalog", defaultEnabled: true, adapter: "text_candidates", scanRawHtml: false, focusTerms: ["chutes", "free", "tier", "model"]},
];
