/**
 * Ported from ratllm_sources.json / RatLLM_Free_Model_Source_Registry.xlsx
 * (the user's own scouting registry). Tiers follow the registry's trust
 * precedence: A1 = official machine-readable API, A2 = official
 * HTML/docs, B = curated third-party aggregator, C = community list.
 * B/C sources are candidate-only — they can surface a lead but never
 * establish free status on their own (see Trust & Rules: "Tier B/C
 * sources cannot directly enter LiteLLM").
 */
export type SourceAdapter = "openrouter" | "litellm_costmap" | "openai_models" | "huggingface" | "text_candidates" | "provider_dataset" | "models_dev";

export interface SourceConfig {
  id: string;
  tier: "A1" | "A2" | "B" | "C";
  name: string;
  adapter: SourceAdapter;
  url: string;
  urls?: readonly string[];
  registrationUrl?: string;
  authEnv?: string;
  authOptional?: boolean;
  providers?: readonly string[];
  focusTerms?: readonly string[];
  candidateOnly?: boolean;
  /** For "openai_models": the response's list key and each entry's id field, when they diverge from the OpenAI
   *  convention (`data`/`id`) — e.g. Cohere returns `{models:[{name,...}]}` instead of `{data:[{id,...}]}`. */
  listKey?: string;
  idField?: string;
  /** Scan raw HTML instead of tag-stripped visible text — for a page (like Cloudflare's models catalog) whose
   *  model ids live only in data-* attributes of a client-side widget, never in rendered text. Opt-in per source. */
  scanRawHtml?: boolean;
  /** The freeType a candidate from this source should be created with, when the source's whole access model implies
   *  it structurally (Vercel's recurring $5/30-day credit, Alibaba's expiring per-model trial quota, Z.AI's
   *  named-free-model list) — distinct from a source that has no such structural signal, which stays UNKNOWN
   *  until a live probe or official price-zero check verifies it. */
  defaultFreeType?: "UNKNOWN" | "RECURRING_CREDIT" | "TRIAL_QUOTA" | "PROVIDER_SPECIFIC_FREE";
  /** Seed this source disabled. Use for sources whose API can't distinguish free from paid at all (unlike e.g. OpenRouter, which exposes per-model pricing) — enabling them means high verification-queue noise for little free-model signal. */
  defaultEnabled?: boolean;
  /** For a text_candidates source scraping a single provider's own page: the exact catalog provider name to resolve every match to. Without this, the scraper only resolves a model if its own text happens to carry a recognizable provider prefix, which most single-provider pages never bother to repeat — leaving otherwise-good tier A2 leads permanently provider-less. */
  providerHint?: string;
  /** How often this specific source is worth re-fetching, per docs/models_source.md §13's freshness table — a live
   *  JSON API and a slow-changing pricing page don't deserve the same cadence. Omit to run on every discovery pass
   *  (matches the old default-1-schedule behavior); runDiscovery skips a source whose lastSyncAt is younger than this. */
  refreshHours?: number;
  description: string;
}

export const sourceRegistry: readonly SourceConfig[] = [
  {id: "openrouter", tier: "A1", name: "OpenRouter Models API", adapter: "openrouter", url: "https://openrouter.ai/api/v1/models", registrationUrl: "https://openrouter.ai/settings/keys", authEnv: "OPENROUTER_API_KEY", authOptional: true, refreshHours: 6, description: "Primary live aggregator for model availability and pricing across many providers."},
  {id: "litellm", tier: "A1", name: "LiteLLM Model Cost Map", adapter: "litellm_costmap", url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", refreshHours: 24, description: "Cross-provider normalized model metadata, cost, and context source maintained by BerriAI."},
  {id: "cerebras", tier: "A1", name: "Cerebras Models API", adapter: "openai_models", url: "https://api.cerebras.ai/public/v1/models", registrationUrl: "https://cloud.cerebras.ai/", authOptional: true, refreshHours: 24, description: "Authoritative live Cerebras model discovery."},
  {id: "gemini", tier: "A1", name: "Google Gemini Models API", adapter: "openai_models", url: "https://generativelanguage.googleapis.com/v1beta/openai/models", registrationUrl: "https://aistudio.google.com/apikey", authEnv: "GEMINI_API_KEY", refreshHours: 24, description: "Authoritative Gemini model inventory via the OpenAI-compatible endpoint."},
  {id: "deepseek", tier: "A1", name: "DeepSeek Models API", adapter: "openai_models", url: "https://api.deepseek.com/models", registrationUrl: "https://platform.deepseek.com/", authEnv: "DEEPSEEK_API_KEY", refreshHours: 24, description: "Authoritative direct DeepSeek model discovery."},
  {id: "minimax", tier: "A1", name: "MiniMax Models API", adapter: "openai_models", url: "https://api.minimax.io/v1/models", registrationUrl: "https://platform.minimax.io/", authEnv: "MINIMAX_API_KEY", refreshHours: 24, description: "Authoritative MiniMax model inventory."},
  {id: "huggingface", tier: "A1", name: "Hugging Face Hub Provider Search", adapter: "huggingface", url: "https://huggingface.co/api/models", registrationUrl: "https://huggingface.co/settings/tokens", authEnv: "HF_TOKEN", authOptional: true, providers: ["cerebras", "cohere", "deepinfra", "fireworks-ai", "groq", "hf-inference", "novita", "nscale", "together", "zai-org"], defaultEnabled: false, refreshHours: 24, description: "Discovers models served by many inference providers through the Hub API. Disabled by default: unlike OpenRouter, the Hub API exposes no per-model pricing, so every result is 'available somewhere,' not 'free' — a provider's full paid catalog looks identical to its free one here."},
  {id: "groq", tier: "A2", name: "Groq Free Plan Limits", adapter: "text_candidates", url: "https://console.groq.com/docs/rate-limits", registrationUrl: "https://console.groq.com/keys", focusTerms: ["Free Plan Limits", "MODEL ID", "RPM", "RPD", "TPM", "TPD"], providerHint: "Groq", refreshHours: 24, description: "Authoritative list of free-plan models and their exact rate limits."},
  {id: "nvidia_nim", tier: "A2", name: "NVIDIA NIM Model Catalog", adapter: "text_candidates", url: "https://build.nvidia.com/models", registrationUrl: "https://build.nvidia.com/", focusTerms: ["Free Endpoint", "Downloadable Free Endpoint"], providerHint: "NVIDIA NIM", refreshHours: 24, description: "Hosted NIM free endpoints and new open models."},
  {id: "alibaba", tier: "A2", name: "Alibaba Model Studio Free Quota", adapter: "text_candidates", url: "https://www.alibabacloud.com/help/en/model-studio/new-free-quota", registrationUrl: "https://modelstudio.console.alibabacloud.com/", focusTerms: ["free quota", "Qwen", "Model"], providerHint: "Alibaba Model Studio", defaultFreeType: "TRIAL_QUOTA", refreshHours: 168, description: "Authoritative Qwen/Tongyi free-quota eligibility — an expiring per-model token grant, not a permanent tier."},
  {id: "zai", tier: "A2", name: "Z.AI / Zhipu Pricing", adapter: "text_candidates", url: "https://docs.z.ai/guides/overview/pricing", registrationUrl: "https://z.ai/", focusTerms: ["Free", "GLM"], providerHint: "Zhipu", defaultFreeType: "PROVIDER_SPECIFIC_FREE", refreshHours: 24, description: "Authoritative GLM model pricing and free-status source — specific named models ($0), not the whole GLM line."},
  {id: "kilo", tier: "A2", name: "Kilo Free Models", adapter: "text_candidates", url: "https://kilo.ai/landing/free-models", registrationUrl: "https://kilo.ai/", focusTerms: ["free", "$0", "model"], providerHint: "Kilo", refreshHours: 24, description: "Live hosted models with zero token pricing."},
  {id: "freellm_models", tier: "B", name: "freeLLM.net Models Directory", adapter: "text_candidates", url: "https://freellm.net/models/", registrationUrl: "https://freellm.net/api-keys/", candidateOnly: true, refreshHours: 24, description: "Curated cross-provider free-model index; candidate-only cross-check."},
  {id: "freellm_providers", tier: "B", name: "freeLLM.net Providers Directory", adapter: "text_candidates", url: "https://freellm.net/providers/", registrationUrl: "https://freellm.net/api-keys/", candidateOnly: true, refreshHours: 24, description: "Provider-level free-tier and registration discovery; candidate-only."},
  {id: "freellmapi", tier: "B", name: "FreeLLMAPI", adapter: "text_candidates", url: "https://freellmapi.co/models", registrationUrl: "https://github.com/tashfeenahmed/freellmapi", candidateOnly: true, refreshHours: 24, description: "Third-party normalized free-model/provider catalog; candidate-only."},
  {id: "cheahjs", tier: "B", name: "cheahjs/free-llm-api-resources (mirror)", adapter: "text_candidates", url: "https://raw.githubusercontent.com/raullenchai/free-llm-api-resources/main/README.md", candidateOnly: true, refreshHours: 24, description: "Reputable community discovery of free API programs and providers. The original cheahjs/free-llm-api-resources repo was removed from GitHub; this is the most current, actively-synced fork of the same generated list (confirmed via GitHub API 404 on the upstream repo)."},
  {id: "xyzs996", tier: "B", name: "xyzs996/free-llm-api", adapter: "text_candidates", url: "https://raw.githubusercontent.com/xyzs996/free-llm-api/main/README.md", candidateOnly: true, refreshHours: 24, description: "Secondary curated free-provider discovery."},
  {id: "ailookup", tier: "C", name: "AILookup/free-llm-resources", adapter: "text_candidates", url: "https://raw.githubusercontent.com/AILookup/free-llm-resources/main/README.md", candidateOnly: true, refreshHours: 168, description: "Long-tail cross-check for free providers/models."},
  {id: "cybirdd", tier: "C", name: "CYBIRD-D/FREE-LLM-API-Provider", adapter: "text_candidates", url: "https://raw.githubusercontent.com/CYBIRD-D/FREE-LLM-API-Provider/main/README.md", candidateOnly: true, refreshHours: 168, description: "China/APAC-focused free-provider discovery, included to reduce Western-source bias."},
  {id: "tatn", tier: "B", name: "tatn/awesome-free-ai-apis", adapter: "text_candidates", url: "https://raw.githubusercontent.com/tatn/awesome-free-ai-apis/main/README.md", candidateOnly: true, refreshHours: 24, description: "Per-provider free-tier tables with exact rate limits (Google AI Studio, OpenAI, OpenRouter, Ollama, and more)."},
  {id: "freellmapihub", tier: "B", name: "freellmapihub.com dataset (pacocartones/free-llm-api-hub)", adapter: "provider_dataset", url: "https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json", registrationUrl: "https://freellmapihub.com/", candidateOnly: true, refreshHours: 24, description: "Structured, machine-readable dataset of free-tier providers with a per-provider 'independently verified against official docs' flag and explicit free model-id lists. Providers whose free tier isn't scoped to specific model ids (e.g. Mistral, Hugging Face) are skipped here since presence alone wouldn't prove free status."},

  // Added 2026-09-11 per docs/models_source.md's audit against sourceRegistry.
  {id: "models_dev", tier: "A1", name: "models.dev Combined Catalog", adapter: "models_dev", url: "https://models.dev/api.json", refreshHours: 24, description: "Independent, no-auth canonical model/provider/lab catalog — the closest thing to a cross-provider model universe (family, modalities, reasoning/tool/structured-output support, open-vs-closed weights). A model's cost.input/cost.output both being 0 is a real free signal here, but per its own docs a canonical $0 entry doesn't guarantee every listed provider still honors it — treat as a strong lead, not the final word."},
  {id: "vercel_ai_gateway", tier: "A1", name: "Vercel AI Gateway Models API", adapter: "openai_models", url: "https://ai-gateway.vercel.sh/v1/models", registrationUrl: "https://vercel.com/ai-gateway/models", authOptional: true, providerHint: "Vercel AI Gateway", defaultFreeType: "RECURRING_CREDIT", refreshHours: 24, description: "Public, no-auth model list across 200+ aggregated models. No model here is priced at literal $0 (confirmed live) — access is via Vercel's recurring $5/30-day credit, not a per-model free tier, so this is presence-only discovery."},
  {id: "cohere_models", tier: "A1", name: "Cohere Models API", adapter: "openai_models", url: "https://api.cohere.com/v2/models", registrationUrl: "https://dashboard.cohere.com/", authEnv: "COHERE_API_KEY", listKey: "models", idField: "name", providerHint: "Cohere", refreshHours: 24, description: "Authoritative Cohere model inventory (Command/embed/rerank family). Presence-only: no pricing/free field in this endpoint, so free status rests on Cohere's separate trial-key rate limits."},
  {id: "mistral_models", tier: "A1", name: "Mistral Models API", adapter: "openai_models", url: "https://api.mistral.ai/v1/models", registrationUrl: "https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key", authEnv: "MISTRAL_API_KEY", providerHint: "Mistral", refreshHours: 24, description: "Authoritative Mistral model inventory. Mistral's pricing page has no clean per-model free-tier list (unlike Groq/NVIDIA/Alibaba/Z.AI), so this is presence-only discovery rather than a text-scrape."},
  {id: "cloudflare_workers_ai", tier: "A2", name: "Cloudflare Workers AI Model Catalog", adapter: "text_candidates", url: "https://developers.cloudflare.com/workers-ai/models/", registrationUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai", focusTerms: ["@cf/"], providerHint: "Cloudflare Workers AI", scanRawHtml: true, refreshHours: 168, description: "Cloudflare publishes no public JSON model catalog; its models page only carries @cf/<vendor>/<model> ids inside data-* attributes of a client-side search widget (confirmed live), not rendered text, hence scanRawHtml. Free status is the account-wide 10,000 Neurons/day allocation, not per-model — a lead, not a verified-free fact."},
] as const;
