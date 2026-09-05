/**
 * Ported from ratllm_sources.json / RatLLM_Free_Model_Source_Registry.xlsx
 * (the user's own scouting registry). Tiers follow the registry's trust
 * precedence: A1 = official machine-readable API, A2 = official
 * HTML/docs, B = curated third-party aggregator, C = community list.
 * B/C sources are candidate-only — they can surface a lead but never
 * establish free status on their own (see Trust & Rules: "Tier B/C
 * sources cannot directly enter LiteLLM").
 */
export type SourceAdapter = "openrouter" | "litellm_costmap" | "openai_models" | "huggingface" | "text_candidates";

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
  description: string;
}

export const sourceRegistry: readonly SourceConfig[] = [
  {id: "openrouter", tier: "A1", name: "OpenRouter Models API", adapter: "openrouter", url: "https://openrouter.ai/api/v1/models", registrationUrl: "https://openrouter.ai/settings/keys", authEnv: "OPENROUTER_API_KEY", authOptional: true, description: "Primary live aggregator for model availability and pricing across many providers."},
  {id: "litellm", tier: "A1", name: "LiteLLM Model Cost Map", adapter: "litellm_costmap", url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", description: "Cross-provider normalized model metadata, cost, and context source maintained by BerriAI."},
  {id: "cerebras", tier: "A1", name: "Cerebras Models API", adapter: "openai_models", url: "https://api.cerebras.ai/public/v1/models", registrationUrl: "https://cloud.cerebras.ai/", authOptional: true, description: "Authoritative live Cerebras model discovery."},
  {id: "gemini", tier: "A1", name: "Google Gemini Models API", adapter: "openai_models", url: "https://generativelanguage.googleapis.com/v1beta/openai/models", registrationUrl: "https://aistudio.google.com/apikey", authEnv: "GEMINI_API_KEY", description: "Authoritative Gemini model inventory via the OpenAI-compatible endpoint."},
  {id: "deepseek", tier: "A1", name: "DeepSeek Models API", adapter: "openai_models", url: "https://api.deepseek.com/models", registrationUrl: "https://platform.deepseek.com/", authEnv: "DEEPSEEK_API_KEY", description: "Authoritative direct DeepSeek model discovery."},
  {id: "minimax", tier: "A1", name: "MiniMax Models API", adapter: "openai_models", url: "https://api.minimax.io/v1/models", registrationUrl: "https://platform.minimax.io/", authEnv: "MINIMAX_API_KEY", description: "Authoritative MiniMax model inventory."},
  {id: "huggingface", tier: "A1", name: "Hugging Face Hub Provider Search", adapter: "huggingface", url: "https://huggingface.co/api/models", registrationUrl: "https://huggingface.co/settings/tokens", authEnv: "HF_TOKEN", authOptional: true, providers: ["cerebras", "cohere", "deepinfra", "fireworks-ai", "groq", "hf-inference", "novita", "nscale", "together", "zai-org"], description: "Discovers models served by many inference providers through the Hub API."},
  {id: "groq", tier: "A2", name: "Groq Free Plan Limits", adapter: "text_candidates", url: "https://console.groq.com/docs/rate-limits", registrationUrl: "https://console.groq.com/keys", focusTerms: ["Free Plan Limits", "MODEL ID", "RPM", "RPD", "TPM", "TPD"], description: "Authoritative list of free-plan models and their exact rate limits."},
  {id: "nvidia_nim", tier: "A2", name: "NVIDIA NIM Model Catalog", adapter: "text_candidates", url: "https://build.nvidia.com/models", registrationUrl: "https://build.nvidia.com/", focusTerms: ["Free Endpoint", "Downloadable Free Endpoint"], description: "Hosted NIM free endpoints and new open models."},
  {id: "alibaba", tier: "A2", name: "Alibaba Model Studio Free Quota", adapter: "text_candidates", url: "https://www.alibabacloud.com/help/en/model-studio/new-free-quota", registrationUrl: "https://modelstudio.console.alibabacloud.com/", focusTerms: ["free quota", "Qwen", "Model"], description: "Authoritative Qwen/Tongyi free-quota eligibility."},
  {id: "zai", tier: "A2", name: "Z.AI / Zhipu Pricing", adapter: "text_candidates", url: "https://docs.z.ai/guides/overview/pricing", registrationUrl: "https://z.ai/", focusTerms: ["Free", "GLM"], description: "Authoritative GLM model pricing and free-status source."},
  {id: "kilo", tier: "A2", name: "Kilo Free Models", adapter: "text_candidates", url: "https://kilo.ai/landing/free-models", registrationUrl: "https://kilo.ai/", focusTerms: ["free", "$0", "model"], description: "Live hosted models with zero token pricing."},
  {id: "freellm_models", tier: "B", name: "freeLLM.net Models Directory", adapter: "text_candidates", url: "https://freellm.net/models/", registrationUrl: "https://freellm.net/api-keys/", candidateOnly: true, description: "Curated cross-provider free-model index; candidate-only cross-check."},
  {id: "freellm_providers", tier: "B", name: "freeLLM.net Providers Directory", adapter: "text_candidates", url: "https://freellm.net/providers/", registrationUrl: "https://freellm.net/api-keys/", candidateOnly: true, description: "Provider-level free-tier and registration discovery; candidate-only."},
  {id: "freellmapi", tier: "B", name: "FreeLLMAPI", adapter: "text_candidates", url: "https://freellmapi.co/models", registrationUrl: "https://github.com/tashfeenahmed/freellmapi", candidateOnly: true, description: "Third-party normalized free-model/provider catalog; candidate-only."},
  {id: "cheahjs", tier: "B", name: "cheahjs/free-llm-api-resources", adapter: "text_candidates", url: "https://raw.githubusercontent.com/cheahjs/free-llm-api-resources/main/README.md", candidateOnly: true, description: "Reputable community discovery of free API programs and providers."},
  {id: "xyzs996", tier: "B", name: "xyzs996/free-llm-api", adapter: "text_candidates", url: "https://raw.githubusercontent.com/xyzs996/free-llm-api/main/README.md", candidateOnly: true, description: "Secondary curated free-provider discovery."},
  {id: "ailookup", tier: "C", name: "AILookup/free-llm-resources", adapter: "text_candidates", url: "https://raw.githubusercontent.com/AILookup/free-llm-resources/main/README.md", candidateOnly: true, description: "Long-tail cross-check for free providers/models."},
  {id: "cybirdd", tier: "C", name: "CYBIRD-D/FREE-LLM-API-Provider", adapter: "text_candidates", url: "https://raw.githubusercontent.com/CYBIRD-D/FREE-LLM-API-Provider/main/README.md", candidateOnly: true, description: "China/APAC-focused free-provider discovery, included to reduce Western-source bias."},
] as const;
