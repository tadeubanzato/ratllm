import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DiscoveredCandidate, DiscoverySource } from "./types";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { resolveProvider } from "@/server/providers/catalog";
import { resolveCredentialSecret } from "./verify";
import { sourceRegistry, type SourceConfig } from "./registry";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {headers: {accept: "application/json", "user-agent": "ratllm/0.1", ...headers}, signal: AbortSignal.timeout(30_000), cache: "no-store"});
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}
async function getText(url: string): Promise<string> {
  const response = await fetch(url, {headers: {accept: "text/plain,text/html", "user-agent": "ratllm/0.1"}, signal: AbortSignal.timeout(30_000), cache: "no-store"});
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}
const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
/** Falls back to a verified credential the user configured in Settings → Providers when the raw env var isn't set — a key added through the UI should actually get used for discovery, not just for candidate testing. */
async function bearerHeaders(config: SourceConfig): Promise<Record<string, string>> {
  if (!config.authEnv) return {};
  const envKey = process.env[config.authEnv];
  if (envKey) return {authorization: `Bearer ${envKey}`};
  const provider = resolveProvider(config.providerHint ?? config.id, "");
  if (!provider) return {};
  const db = getDb();
  const providerRow = (await db.select({id: providers.id}).from(providers).where(eq(providers.slug, provider.slug)).limit(1))[0];
  if (!providerRow) return {};
  const credential = (await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, providerRow.id)).limit(1))[0];
  if (!credential || credential.valid !== true) return {};
  const secret = resolveCredentialSecret(credential);
  return secret ? {authorization: `Bearer ${secret}`} : {};
}

/** OpenRouter's public catalog. Free is proven by :free suffix or zero prompt/completion price. */
class OpenRouterSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const raw = z.object({data: z.array(z.record(z.string(), z.unknown()))}).parse(await getJson(this.config.url, await bearerHeaders(this.config)));
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

/** Generic OpenAI-compatible /models listing (Cerebras, Gemini, DeepSeek, MiniMax, Vercel AI Gateway, Cohere,
 *  Mistral, ...). Presence proves the model is live, never that it's free — every candidate needs separate
 *  free-plan verification. `listKey`/`idField` accommodate a provider whose list shape diverges from the OpenAI
 *  convention (Cohere returns `{models:[{name,...}]}`, not `{data:[{id,...}]}`). */
class OpenAICompatibleModelsSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const headers = await bearerHeaders(this.config);
    if (this.config.authEnv && !this.config.authOptional && !headers.authorization) return [];
    const body = await getJson(this.config.url, headers) as Record<string, unknown>;
    const listKey = this.config.listKey ?? "data";
    const data = Array.isArray(body[listKey]) ? body[listKey] as unknown[] : Array.isArray(body) ? body : [];
    const out: DiscoveredCandidate[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const model = entry as Record<string, unknown>;
      const idField = this.config.idField;
      const id = (idField && typeof model[idField] === "string" ? model[idField] as string : null) ?? (typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : null);
      if (!id) continue;
      out.push({source: this.id, modelRef: id, displayName: typeof model.name === "string" ? model.name : id, providerName: this.config.providerHint ?? this.config.id, freeType: this.config.defaultFreeType ?? "UNKNOWN", verifiedFree: false, contextWindow: numberValue(model.context_length), sourceUrl: this.config.url, evidence: {presenceOnly: true, ownedBy: model.owned_by ?? null}});
    }
    return out;
  }
}

/** Hugging Face Hub search fanned out across a fixed list of inference providers. Discovery net only — free status is an account-level entitlement, never a per-model fact here. */
class HuggingFaceProviderSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const headers = await bearerHeaders(this.config);
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
// The leading `@cf\/vendor\/model` alternative is Cloudflare Workers AI's own id convention (developers.cloudflare.com/workers-ai/models/)
// — it needs to win the match outright (full id, vendor included) rather than falling through to the generic
// family-word alternative below, which would still partially match "vendor/llama-..." but silently drop the "@cf/" prefix
// that's the only thing distinguishing it from any other provider's same model name.
const MODEL_TOKEN_PATTERN = /(?:@cf\/[a-z0-9_-]+\/[a-z0-9._-]+|[a-z0-9._-]+\/(?:qwen|deepseek|glm|kimi|minimax|mimo|stepfun|hunyuan|doubao|ernie|longcat|baichuan|internlm|yi-|gpt-oss|llama|mistral|codestral|command|gemini|phi)[a-z0-9._:+-]*|(?:qwen|tongyi|deepseek|glm|zhipu|kimi|minimax|mimo|stepfun|hunyuan|doubao|ernie|longcat|baichuan|internlm|yi-|gpt-oss|llama|mistral|codestral|command|gemini|phi)[a-z0-9._:+-]*)/gi;
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
      const stripped = withoutPaidTables.includes("<") && withoutPaidTables.includes(">") ? withoutPaidTables.replace(/<[^>]+>/g, " ") : withoutPaidTables;
      // Some pages (Cloudflare's models catalog) only carry model ids inside data-* attributes of a client-side
      // search widget, not in rendered text — tag-stripping would discard exactly what we're looking for. Opt-in
      // per source (scanRawHtml) rather than a blanket change, since scanning raw markup for every other source
      // risks matching class names/attributes that merely resemble a model id.
      const visible = this.config.scanRawHtml ? withoutPaidTables : stripped;
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
          out.push({source: this.id, modelRef: token, displayName: token, providerName: provider?.name, freeType: this.config.defaultFreeType ?? "UNKNOWN", verifiedFree: false, sourceUrl: url, evidence: {line: index + 1, excerpt: evidence, freeLead: freeHit, providerResolution: provider ? {slug: provider.slug, method: "model-family"} : undefined}});
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

/** models.dev's combined catalog: an object keyed by provider slug, each holding a nested object of models keyed by
 *  model id (never a flat list) — the one shape none of the other adapters can parse. No auth, no observed rate
 *  limit. `cost.input === 0 && cost.output === 0` is the free signal; absent `cost` means unknown, not free. */
class ModelsDevSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const body = await getJson(this.config.url) as Record<string, unknown>;
    const out: DiscoveredCandidate[] = [];
    for (const providerEntry of Object.values(body)) {
      if (!providerEntry || typeof providerEntry !== "object") continue;
      const providerRaw = providerEntry as Record<string, unknown>;
      const providerName = typeof providerRaw.name === "string" ? providerRaw.name : typeof providerRaw.id === "string" ? providerRaw.id : undefined;
      const models = providerRaw.models && typeof providerRaw.models === "object" ? providerRaw.models as Record<string, unknown> : {};
      for (const [modelId, modelEntry] of Object.entries(models)) {
        if (!modelEntry || typeof modelEntry !== "object") continue;
        const model = modelEntry as Record<string, unknown>;
        const cost = model.cost && typeof model.cost === "object" ? model.cost as Record<string, unknown> : undefined;
        const free = cost !== undefined && Number(cost.input) === 0 && Number(cost.output) === 0;
        const limit = model.limit && typeof model.limit === "object" ? model.limit as Record<string, unknown> : {};
        const modalities = model.modalities && typeof model.modalities === "object" ? model.modalities as Record<string, unknown> : {};
        const inputModalities = Array.isArray(modalities.input) ? modalities.input as unknown[] : [];
        out.push({
          source: this.id, modelRef: modelId, displayName: typeof model.name === "string" ? model.name : modelId, providerName,
          freeType: free ? "FREE_TIER" : "UNKNOWN", verifiedFree: free,
          contextWindow: numberValue(limit.context), maxOutputTokens: numberValue(limit.output),
          supportsVision: inputModalities.includes("image"), supportsTools: Boolean(model.tool_call), supportsReasoning: Boolean(model.reasoning),
          sourceUrl: this.config.url, evidence: {family: model.family ?? null, openWeights: Boolean(model.open_weights), costZero: free, catalogEntry: true},
        });
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
    case "models_dev": return new ModelsDevSource(config);
  }
}

export const discoverySources: readonly DiscoverySource[] = sourceRegistry.map(buildSource);
