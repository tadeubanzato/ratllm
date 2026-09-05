import "server-only";
import { z } from "zod";
import type { DiscoveredCandidate, DiscoverySource } from "./types";
import { resolveProvider } from "@/server/providers/catalog";
import { sourceRegistry, type SourceConfig } from "./registry";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {headers: {accept: "application/json", "user-agent": "okame-model-curator/0.1", ...headers}, signal: AbortSignal.timeout(30_000), cache: "no-store"});
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}
async function getText(url: string): Promise<string> {
  const response = await fetch(url, {headers: {accept: "text/plain,text/html", "user-agent": "okame-model-curator/0.1"}, signal: AbortSignal.timeout(30_000), cache: "no-store"});
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}
const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
function bearerHeaders(config: SourceConfig): Record<string, string> {
  if (!config.authEnv) return {};
  const key = process.env[config.authEnv];
  return key ? {authorization: `Bearer ${key}`} : {};
}

/** OpenRouter's public catalog. Free is proven by :free suffix or zero prompt/completion price. */
class OpenRouterSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const raw = z.object({data: z.array(z.record(z.string(), z.unknown()))}).parse(await getJson(this.config.url, bearerHeaders(this.config)));
    return raw.data.flatMap((row): DiscoveredCandidate[] => {
      const id = typeof row.id === "string" ? row.id : "";
      const pricing = row.pricing && typeof row.pricing === "object" ? row.pricing as Record<string, unknown> : {};
      const free = id.endsWith(":free") || (Number(pricing.prompt) === 0 && Number(pricing.completion) === 0);
      if (!id || !free) return [];
      const architecture = row.architecture && typeof row.architecture === "object" ? row.architecture as Record<string, unknown> : {};
      return [{source: this.id, modelRef: id, displayName: typeof row.name === "string" ? row.name : id, providerName: "OpenRouter", freeType: "FREE_TIER", verifiedFree: true, contextWindow: numberValue(row.context_length), supportsVision: Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image"), sourceUrl: this.config.url, evidence: {catalogPriceZero: true, variantFree: id.endsWith(":free"), lastCatalogCheck: new Date().toISOString()}}];
    });
  }
}

/** LiteLLM's maintained cost map. Zero input+output cost on a chat model is the free signal; self-hosted backends are excluded since zero cost there means your own infra, not a hosted free API. */
const SELF_HOSTED_PROVIDERS = new Set(["ollama", "bedrock", "sagemaker", "vertex_ai-llama_models"]);
class LiteLLMCostMapSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const raw = z.record(z.string(), z.unknown()).parse(await getJson(this.config.url));
    const out: DiscoveredCandidate[] = [];
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const info = value as Record<string, unknown>;
      if (info.mode !== "chat" || info.input_cost_per_token !== 0 || info.output_cost_per_token !== 0) continue;
      const provider = typeof info.litellm_provider === "string" ? info.litellm_provider : undefined;
      if (provider && SELF_HOSTED_PROVIDERS.has(provider)) continue;
      out.push({source: this.id, modelRef: id, displayName: id, providerName: provider, freeType: "UNKNOWN", verifiedFree: false, contextWindow: numberValue(info.max_input_tokens ?? info.max_tokens), maxOutputTokens: numberValue(info.max_output_tokens), supportsVision: Boolean(info.supports_vision), supportsTools: Boolean(info.supports_function_calling), supportsReasoning: Boolean(info.supports_reasoning), sourceUrl: this.config.url, evidence: {zeroCostCatalogEntry: true, mode: "chat"}});
    }
    return out;
  }
}

/** Generic OpenAI-compatible /models listing (Cerebras, Gemini, DeepSeek, MiniMax, ...). Presence proves the model is live, never that it's free — every candidate needs separate free-plan verification. */
class OpenAICompatibleModelsSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const headers = bearerHeaders(this.config);
    if (this.config.authEnv && !this.config.authOptional && !headers.authorization) return [];
    const body = await getJson(this.config.url, headers) as Record<string, unknown>;
    const data = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
    const out: DiscoveredCandidate[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const model = entry as Record<string, unknown>;
      const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : null;
      if (!id) continue;
      out.push({source: this.id, modelRef: id, displayName: typeof model.name === "string" ? model.name : id, providerName: this.config.id, freeType: "UNKNOWN", verifiedFree: false, contextWindow: numberValue(model.context_length), sourceUrl: this.config.url, evidence: {presenceOnly: true, ownedBy: model.owned_by ?? null}});
    }
    return out;
  }
}

/** Hugging Face Hub search fanned out across a fixed list of inference providers. Discovery net only — free status is an account-level entitlement, never a per-model fact here. */
class HuggingFaceProviderSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const headers = bearerHeaders(this.config);
    const results = await Promise.allSettled((this.config.providers ?? []).map(async provider => {
      const url = `${this.config.url}?inference_provider=${provider}`;
      const data = await getJson(url, headers);
      return {provider, url, data};
    }));
    const out: DiscoveredCandidate[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const {provider, url, data} = result.value;
      if (!Array.isArray(data)) continue;
      for (const entry of data) {
        if (!entry || typeof entry !== "object") continue;
        const model = entry as Record<string, unknown>;
        const id = typeof model.id === "string" ? model.id : typeof model.modelId === "string" ? model.modelId : null;
        if (!id) continue;
        out.push({source: this.id, modelRef: id, displayName: id, providerName: provider, freeType: "UNKNOWN", verifiedFree: false, sourceUrl: url, evidence: {viaProvider: provider, presenceOnly: true}});
      }
    }
    return out;
  }
}

/** Generalized HTML/Markdown text scraper for official tables (Groq, NVIDIA, Alibaba, Z.AI, Kilo) and curated/community lists. Every hit is a lead, never a confirmed fact — candidateOnly sources are explicitly excluded from auto-promotion elsewhere in the pipeline. */
const MODEL_TOKEN_PATTERN = /(?:[a-z0-9._-]+\/(?:qwen|deepseek|glm|kimi|minimax|mimo|stepfun|hunyuan|doubao|ernie|longcat|baichuan|internlm|yi-|gpt-oss|llama|mistral|codestral|command|gemini|phi)[a-z0-9._:+-]*|(?:qwen|tongyi|deepseek|glm|zhipu|kimi|minimax|mimo|stepfun|hunyuan|doubao|ernie|longcat|baichuan|internlm|yi-|gpt-oss|llama|mistral|codestral|command|gemini|phi)[a-z0-9._:+-]*)/gi;
const FREE_WORDS = ["free", "免费", "$0", "no credit card", "free tier", "free quota", "trial credit", "free endpoint", "free plan"];
/** README convention for collapsible "paid pricing" tables — duplicates the free-tier model names next to their paid cost, which reads as free-signal noise if left in. */
const DETAILS_BLOCK_PATTERN = /<details[^>]*>[\s\S]*?<\/details>/gi;
/** A prose mention like "Llama" or "Gemini" isn't a model id; real ids carry a digit, a hyphenated qualifier, or an org/repo slash. */
const looksLikeModelId = (token: string) => /[0-9/-]/.test(token);
/** Doc links and repo references match the family-word pattern too (e.g. "ai.google.dev/gemini-api/docs", "ggml-org/llama.cpp") — filter those out by their non-model suffix/prefix shape. */
const DOC_OR_REPO_SHAPE = /(^[a-z0-9.-]+\.(?:com|dev|org|net|io|co|ai)\/)|(\.(?:com|dev|org|net|io|co|ai|cpp|git|md|html?)$)/i;
/** Same acceptance rule the scraper applies live — exported so a maintenance pass can retroactively prune rows an older, looser version of this parser left behind. */
export const isPlausibleScrapedModelId = (token: string) => looksLikeModelId(token) && !DOC_OR_REPO_SHAPE.test(token);
class TextCandidateSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const urls = this.config.urls ?? [this.config.url];
    const settled = await Promise.allSettled(urls.map(async url => ({url, text: await getText(url)})));
    const seen = new Set<string>();
    const out: DiscoveredCandidate[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const {url, text} = result.value;
      const withoutPaidTables = text.replace(DETAILS_BLOCK_PATTERN, " ");
      const visible = withoutPaidTables.includes("<") && withoutPaidTables.includes(">") ? withoutPaidTables.replace(/<[^>]+>/g, " ") : withoutPaidTables;
      for (const [index, line] of visible.split("\n").entries()) {
        const focusHit = this.config.focusTerms ? this.config.focusTerms.some(term => line.toLowerCase().includes(term.toLowerCase())) : true;
        const freeHit = FREE_WORDS.some(word => line.toLowerCase().includes(word));
        if (!focusHit && !freeHit) continue;
        for (const match of line.matchAll(MODEL_TOKEN_PATTERN)) {
          const token = match[0].replace(/^[`'"[({<]+|[`'")\]}>.,;:|]+$/g, "");
          if (token.length < 4 || seen.has(token.toLowerCase()) || /^https?:/.test(token) || !isPlausibleScrapedModelId(token)) continue;
          seen.add(token.toLowerCase());
          const lo = Math.max(0, match.index! - 200); const hi = Math.min(visible.length, match.index! + token.length + 200);
          const evidence = visible.slice(lo, hi).replace(/\s+/g, " ").trim().slice(0, 500);
          const provider = resolveProvider(this.config.providerHint ?? null, token);
          out.push({source: this.id, modelRef: token, displayName: token, providerName: provider?.name, freeType: "UNKNOWN", verifiedFree: false, sourceUrl: url, evidence: {line: index + 1, excerpt: evidence, freeLead: freeHit, providerResolution: provider ? {slug: provider.slug, method: "model-family"} : undefined}});
        }
      }
    }
    return out;
  }
}

/** freellmapihub's machine-readable dataset: one JSON object per provider with an explicit `models_free` id list and a `verified` flag for whether the facts were independently re-checked against official docs. Providers with no discrete free model ids are skipped — same reasoning as disabling the Hugging Face source: presence isn't proof of "free". */
const providerDatasetEntrySchema = z.object({name: z.string(), docs_url: z.string().optional(), verified: z.boolean().optional(), models_free: z.array(z.string()).optional()});
class ProviderDatasetSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const body = await getJson(this.config.url) as Record<string, unknown>;
    const providersRaw = Array.isArray(body.providers) ? body.providers : [];
    const out: DiscoveredCandidate[] = [];
    for (const raw of providersRaw) {
      const parsed = providerDatasetEntrySchema.safeParse(raw);
      if (!parsed.success || !parsed.data.models_free?.length) continue;
      const {name, docs_url: docsUrl, verified, models_free: modelsFree} = parsed.data;
      const provider = resolveProvider(name, modelsFree[0]);
      for (const modelRef of modelsFree) {
        out.push({source: this.id, modelRef, displayName: modelRef, providerName: provider?.name ?? name, freeType: "FREE_TIER", verifiedFree: false, sourceUrl: docsUrl ?? this.config.url, evidence: {datasetVerified: verified ?? false, providerDocsUrl: docsUrl}});
      }
    }
    return out;
  }
}

function buildSource(config: SourceConfig): DiscoverySource {
  switch (config.adapter) {
    case "openrouter": return new OpenRouterSource(config);
    case "litellm_costmap": return new LiteLLMCostMapSource(config);
    case "openai_models": return new OpenAICompatibleModelsSource(config);
    case "huggingface": return new HuggingFaceProviderSource(config);
    case "text_candidates": return new TextCandidateSource(config);
    case "provider_dataset": return new ProviderDatasetSource(config);
  }
}

export const discoverySources: readonly DiscoverySource[] = sourceRegistry.map(buildSource);
