import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { SourceBlockedError, type DiscoveredCandidate, type DiscoveryResult, type DiscoverySource, type FreeType, type ProviderOffer } from "./types";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers } from "@/server/db/schema";
import { and } from "drizzle-orm";
import { resolveProvider } from "@/server/providers/catalog";
import { resolveCredentialSecret } from "./verify";
import { buildExtraHeaders } from "@/server/providers/wiring";
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
  if (envKey) {
    const extra = config.providerHint ? buildExtraHeaders(config.providerHint, null) : {};
    return {authorization: `Bearer ${envKey}`, ...extra};
  }
  const provider = resolveProvider(config.providerHint ?? config.id, "");
  if (!provider) return {};
  const db = getDb();
  const providerRow = (await db.select({id: providers.id}).from(providers).where(eq(providers.slug, provider.slug)).limit(1))[0];
  if (!providerRow) return {};
  const credential = (await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, providerRow.id)).limit(1))[0];
  if (!credential || credential.valid !== true) return {};
  const secret = resolveCredentialSecret(credential);
  const extras = buildExtraHeaders(provider.slug, credential.config);
  return secret ? {authorization: `Bearer ${secret}`, ...extras} : extras;
}

/** The credentials a source may use, in the order they are tried: the environment variable (an operator override that has
 *  always won), then every verified key stored under Settings → Providers. A wrong or expired environment key used to
 *  end the source with a 401 while a perfectly good stored key sat unused; now a 401/403 moves on to the next key. */
async function credentialsFor(config: SourceConfig): Promise<Array<{secret: string; extra: Record<string, string>}>> {
  const found: Array<{secret: string; extra: Record<string, string>}> = [];
  const envKey = config.authEnv ? process.env[config.authEnv] : undefined;
  if (envKey) found.push({secret: envKey, extra: config.providerHint ? buildExtraHeaders(config.providerHint, null) : {}});
  const slug = config.providerSlug ?? resolveProvider(config.providerHint ?? config.id, "")?.slug;
  if (slug) {
    const db = getDb();
    const providerRow = (await db.select({id: providers.id}).from(providers).where(eq(providers.slug, slug)).limit(1))[0];
    if (providerRow) {
      const stored = await db.select().from(providerCredentialReferences).where(and(eq(providerCredentialReferences.providerId, providerRow.id), eq(providerCredentialReferences.disabled, false), eq(providerCredentialReferences.valid, true)));
      for (const credential of stored) {
        const secret = resolveCredentialSecret(credential);
        if (secret && !found.some(item => item.secret === secret)) found.push({secret, extra: buildExtraHeaders(slug, credential.config)});
      }
    }
  }
  return found;
}

/** Fetches a source's JSON listing with whatever credentials it has. Three distinct outcomes, so the run can tell them apart:
 *  a key is needed and none exists (SourceBlockedError: an expected waiting state), every key was refused (a real failure:
 *  the key is bad), or anything else (a real failure). */
export async function getListing(config: SourceConfig): Promise<unknown> {
  const credentials = await credentialsFor(config);
  const needsKey = `${config.name} needs an API key: add one under Settings → Providers`;
  if (!credentials.length && config.authEnv && !config.authOptional) throw new SourceBlockedError(needsKey);
  let refused = 0;
  for (const credential of credentials.length ? credentials : [null]) {
    const headers = credential ? {authorization: `Bearer ${credential.secret}`, ...credential.extra} : {};
    const response = await fetch(config.url, {headers: {accept: "application/json", "user-agent": "ratllm/0.1", ...headers}, signal: AbortSignal.timeout(30_000), cache: "no-store"});
    if (response.ok) return response.json();
    if (response.status !== 401 && response.status !== 403) throw new Error(`${config.url} returned ${response.status}`);
    refused = response.status;
  }
  if (!credentials.length) throw new SourceBlockedError(needsKey);
  throw new Error(`${config.url} returned ${refused} for every stored key: the key may be invalid or expired`);
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (...values: unknown[]) => { for (const value of values) { const n = numberValue(value); if (n !== undefined && n > 0) return n; } return undefined; };
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(item => item.toLowerCase()) : [];
/** A price field is zero only when it is present and numerically zero. Absent, "-1" (a router's variable price) or a negative is unknown, never free. */
const isZeroPrice = (value: unknown) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number(value) === 0;

/** Model types (Together, Vercel) and output modalities that mean "not a chat model" — never sent a chat-completion test. */
const NON_CHAT_TYPES = new Set(["embedding", "embeddings", "embed", "image", "image-generation", "audio", "transcribe", "transcription", "speech", "tts", "stt", "rerank", "reranker", "moderation", "video", "video-generation", "moderations"]);

export interface ModelInfo {
  displayName?: string; contextWindow?: number; maxOutputTokens?: number;
  supportsVision?: boolean; supportsTools?: boolean; supportsReasoning?: boolean;
  free: boolean; freeReason?: string; priced: boolean; nonChatReason?: string;
}

/** What an OpenAI-style /models entry tells us. Every provider names these fields a little differently (context_length,
 *  context_window, max_model_len; pricing.prompt or pricing.input; a `type` or output modalities), so this reads all the
 *  spellings once, here, instead of each adapter guessing. Pure, and tested against a sample of every real shape. */
export function extractModelInfo(model: Record<string, unknown>): ModelInfo {
  const architecture = asRecord(model.architecture), topProvider = asRecord(model.top_provider), modalities = asRecord(model.modalities), pricing = asRecord(model.pricing);
  const input = stringList(model.input_modalities ?? architecture.input_modalities ?? modalities.input);
  const output = stringList(model.output_modalities ?? architecture.output_modalities ?? modalities.output);
  const features = [...stringList(model.supported_parameters), ...stringList(model.supported_features)];
  const type = typeof model.type === "string" ? model.type.toLowerCase() : "";
  let nonChatReason: string | undefined;
  if (type && NON_CHAT_TYPES.has(type)) nonChatReason = `Listed as a ${type} model, not a chat model`;
  else if (output.length && !output.includes("text")) nonChatReason = `Outputs ${output.join("/")} rather than text`;
  const promptPrice = pricing.prompt ?? pricing.input, completionPrice = pricing.completion ?? pricing.output;
  const numericPrices = [promptPrice, completionPrice].map(value => Number(value)).filter(value => Number.isFinite(value));
  const zeroPriced = isZeroPrice(promptPrice) && isZeroPrice(completionPrice);
  const id = typeof model.id === "string" ? model.id : "";
  let freeReason: string | undefined;
  if (model.isFree === true) freeReason = "The source flags this model as free (isFree)";
  else if (id.endsWith(":free")) freeReason = "A :free variant";
  else if (zeroPriced) freeReason = "Zero prompt and completion price";
  return {
    displayName: typeof model.name === "string" ? model.name : typeof model.display_name === "string" ? model.display_name : undefined,
    contextWindow: positive(model.context_length, model.context_window, model.max_model_len, topProvider.context_length),
    maxOutputTokens: positive(model.max_output_length, model.max_completion_tokens, topProvider.max_completion_tokens, model.max_tokens),
    supportsVision: input.length ? input.includes("image") : undefined,
    supportsTools: features.length ? features.some(item => item === "tools" || item === "tool_choice" || item === "function_calling") : undefined,
    supportsReasoning: features.length ? features.some(item => item === "reasoning" || item === "include_reasoning") : undefined,
    free: freeReason !== undefined && model.isFree !== false, freeReason,
    priced: numericPrices.some(value => value > 0), nonChatReason,
  };
}

/** OpenRouter's public catalog. Free is proven by :free suffix or zero prompt/completion price. */
class OpenRouterSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveredCandidate[]> {
    const raw = z.object({data: z.array(z.record(z.string(), z.unknown()))}).parse(await getListing(this.config));
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
      out.push({source: this.id, modelRef: id, displayName: id, providerName: provider, freeType: "FREE_TIER", verifiedFree: true, contextWindow: numberValue(info.max_input_tokens ?? info.max_tokens), maxOutputTokens: numberValue(info.max_output_tokens), supportsVision: Boolean(info.supports_vision), supportsTools: Boolean(info.supports_function_calling), supportsReasoning: Boolean(info.supports_reasoning), sourceUrl: this.config.url, evidence: {zeroCostCatalogEntry: true, mode: "chat", provider}});
    }
    return out;
  }
}

/** A provider's own OpenAI-style /models listing (docs/DISCOVERY-PIPELINE.md §4): the authoritative answer to "which models
 *  does this provider serve". Presence proves a model is live, never that it is free; free is claimed only from the
 *  listing's own price or flag fields (extractModelInfo). `listKey`/`idField` cover providers whose list shape diverges from
 *  the convention, and a bare top-level array (Together) is accepted. */
class OpenAICompatibleModelsSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveryResult> {
    const body = await getListing(this.config);
    const listKey = this.config.listKey ?? "data";
    const record = asRecord(body);
    const data = Array.isArray(body) ? body : Array.isArray(record[listKey]) ? record[listKey] as unknown[] : [];
    const candidates: DiscoveredCandidate[] = [];
    let rejected = 0;
    for (const entry of data) {
      const model = asRecord(entry);
      const idField = this.config.idField;
      let id = (idField && typeof model[idField] === "string" ? model[idField] as string : null) ?? (typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : null);
      if (id && this.config.stripIdPrefix && id.startsWith(this.config.stripIdPrefix)) id = id.slice(this.config.stripIdPrefix.length);
      if (!id || !id.trim()) { rejected++; continue; }
      const info = extractModelInfo({...model, id});
      candidates.push({
        source: this.id, modelRef: id, displayName: info.displayName ?? id, providerName: this.config.providerHint ?? this.config.id,
        freeType: info.free ? "FREE_TIER" : (this.config.defaultFreeType ?? "UNKNOWN") as FreeType, verifiedFree: info.free,
        contextWindow: info.contextWindow, maxOutputTokens: info.maxOutputTokens, supportsVision: info.supportsVision, supportsTools: info.supportsTools, supportsReasoning: info.supportsReasoning,
        nonChatReason: info.nonChatReason, sourceUrl: this.config.url,
        evidence: {presenceOnly: !info.free, ...(info.free ? {freeReason: info.freeReason} : {}), priced: info.priced, ownedBy: typeof model.owned_by === "string" ? model.owned_by : null},
      });
    }
    return {candidates, rejected};
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
          out.push({source: this.id, modelRef: token, displayName: token, providerName: provider?.name, freeType: (this.config.defaultFreeType ?? "UNKNOWN") as FreeType, verifiedFree: false, sourceUrl: url, evidence: {line: index + 1, excerpt: evidence, freeLead: freeHit, providerResolution: provider ? {slug: provider.slug, method: "model-family"} : undefined}});
        }
      }
    }
    return out;
  }
}

/** freellmapihub's machine-readable dataset: one JSON object per provider with its free offer (a free type, the rate limits
 *  as the provider publishes them, an expiry, whether a card or phone is needed, an OpenAI-compatible base URL, when it
 *  was last verified) and, for some, an explicit list of free model ids. Both are kept: the models become candidates and
 *  the offer becomes a provider_offers row (docs/DISCOVERY-PIPELINE.md §5). Nothing in it is parsed into numbers. */
const DATASET_FREE_TYPES: Readonly<Record<string, FreeType>> = {"perpetual": "PERMANENT_FREE", "renewing-quota": "RECURRING_CREDIT", "recurring-credit": "RECURRING_CREDIT", "trial-credit": "TRIAL_CREDIT"};
const providerDatasetEntrySchema = z.object({
  name: z.string(), slug: z.string().nullish(), docs_url: z.string().nullish(), verified: z.boolean().nullish(), models_free: z.array(z.string()).nullish(),
  free_type: z.string().nullish(), free_tier: z.string().nullish(), rate_limits: z.string().nullish(), notes: z.string().nullish(),
  expires: z.string().nullish(), card_required: z.boolean().nullish(), phone_required: z.boolean().nullish(), commercial_ok: z.boolean().nullish(),
  openai_base_url: z.string().nullish(), last_verified: z.string().nullish(),
});
const orUndefined = <T,>(value: T | null | undefined) => value ?? undefined;
class ProviderDatasetSource implements DiscoverySource {
  constructor(private config: SourceConfig) {}
  get id() { return this.config.id; }
  async discover(): Promise<DiscoveryResult> {
    const body = await getJson(this.config.url) as Record<string, unknown>;
    const providersRaw = Array.isArray(body.providers) ? body.providers : [];
    const candidates: DiscoveredCandidate[] = [];
    const offers: ProviderOffer[] = [];
    let rejected = 0;
    for (const raw of providersRaw) {
      const parsed = providerDatasetEntrySchema.safeParse(raw);
      if (!parsed.success) { rejected++; continue; }
      const entry = parsed.data;
      // A free type we have no mapping for stays UNKNOWN: a new label in the dataset must not silently become "free forever".
      const freeType: FreeType = DATASET_FREE_TYPES[entry.free_type ?? ""] ?? "UNKNOWN";
      const docsUrl = orUndefined(entry.docs_url);
      offers.push({source: this.id, providerName: entry.name, slugHint: orUndefined(entry.slug), freeType, freeTierText: orUndefined(entry.free_tier), rateLimitsText: orUndefined(entry.rate_limits), notes: orUndefined(entry.notes),
        expiresAt: orUndefined(entry.expires), cardRequired: orUndefined(entry.card_required), phoneRequired: orUndefined(entry.phone_required), commercialOk: orUndefined(entry.commercial_ok),
        openaiBaseUrl: orUndefined(entry.openai_base_url), docsUrl, sourceVerified: orUndefined(entry.verified), sourceLastVerified: orUndefined(entry.last_verified)});
      for (const modelRef of entry.models_free ?? []) {
        candidates.push({source: this.id, modelRef, displayName: modelRef, providerName: entry.name, freeType, verifiedFree: false, sourceUrl: docsUrl ?? this.config.url, evidence: {datasetVerified: entry.verified ?? false, providerDocsUrl: docsUrl, offerFreeType: entry.free_type ?? null}});
      }
    }
    return {candidates, offers, rejected};
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
          ...(Array.isArray(modalities.output) && modalities.output.length && !modalities.output.includes("text") ? {nonChatReason: `Outputs ${(modalities.output as unknown[]).join("/")} rather than text`} : {}),
          sourceUrl: this.config.url, evidence: {family: model.family ?? null, openWeights: Boolean(model.open_weights), costZero: free, priceZeroClaim: free, catalogEntry: true, description: typeof model.description === "string" ? model.description : null},
        });
      }
    }
    return out;
  }
}

function buildAdapter(config: SourceConfig): DiscoverySource {
  switch (config.adapter) {
    case "openrouter": return new OpenRouterSource(config);
    case "litellm_costmap": return new LiteLLMCostMapSource(config);
    case "openai_models": return new OpenAICompatibleModelsSource(config);
    case "huggingface": return new HuggingFaceProviderSource(config);
    case "text_candidates": return new TextCandidateSource(config);
    case "provider_dataset": return new ProviderDatasetSource(config);
    case "models_dev": return new ModelsDevSource(config);
    default: throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}

/** Every source carries its registry contract (I4) and the provider it is the own catalog of (I1) with it. */
function buildSource(config: SourceConfig): DiscoverySource {
  const adapter = buildAdapter(config);
  return {id: config.id, minExpected: config.minExpected, providerSlug: config.providerSlug, discover: () => adapter.discover()};
}

export const discoverySources: readonly DiscoverySource[] = sourceRegistry.map(buildSource);
