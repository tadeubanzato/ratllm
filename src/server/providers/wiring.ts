/**
 * Single source of truth for how ratllm actually talks to each provider: the lightweight GET used to flag a
 * credential "valid" (`check`), and the real POST chat-completions URL used both to test a candidate and as the
 * `api_base` LiteLLM gets once a model is promoted (`completions`). These used to live in two separate,
 * independently-maintained maps (one in providers/verify.ts, one in discovery/verify.ts) — a provider present in
 * only one of them was silently, permanently broken (either its credential could never verify, or it could verify
 * but nothing could ever test/promote its models), with no signal anywhere that the fix was a single line in a
 * completely different file. Merging them here makes that specific failure mode structurally impossible: there is
 * only one map, so a provider is either wired (has an entry) or it's tracked in WIRING_PENDING below with a reason.
 *
 * `providersWiring.test.ts` asserts every AUTOMATED/PARTIAL catalog provider has a `completions` entry or a
 * documented WIRING_PENDING reason, so a newly added provider can never again sit half-wired undetected.
 */

export interface ProviderCheck { url: string; auth: "bearer" | "query" }
export interface ProviderWiring {
  /** GET request that discriminates a valid credential from an invalid one. Omit only when the provider has no
   *  endpoint capable of that (confirmed public/unauthenticated, like Kilo's /models) — `verifyCandidateDirectly`
   *  then treats the real completions call itself as the verification instead of blocking on it forever. */
  check?: ProviderCheck;
  /** POST chat-completions URL. Omit when the provider needs an account/project-scoped or self-hosted Base URL
   *  instead (Cloudflare, Vertex AI, Local, custom providers) — those are configured per-provider, not here. */
  completions?: string;
  /** True when the provider is fully reachable with zero credential (confirmed against its own docs — llm7 and
   *  Pollinations both serve a free/anonymous tier with no key at all). Distinct from Kilo-style "no check" above:
   *  those two DO have a working check endpoint, it's just optional to use. */
  credentialOptional?: boolean;
}

export const providerWiring: Readonly<Record<string, ProviderWiring>> = {
  groq: { check: { url: "https://api.groq.com/openai/v1/models", auth: "bearer" }, completions: "https://api.groq.com/openai/v1/chat/completions" },
  cerebras: { check: { url: "https://api.cerebras.ai/v1/models", auth: "bearer" }, completions: "https://api.cerebras.ai/v1/chat/completions" },
  nvidia: { check: { url: "https://integrate.api.nvidia.com/v1/models", auth: "bearer" }, completions: "https://integrate.api.nvidia.com/v1/chat/completions" },
  "google-ai-studio": { check: { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "query" }, completions: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
  openrouter: { check: { url: "https://openrouter.ai/api/v1/auth/key", auth: "bearer" }, completions: "https://openrouter.ai/api/v1/chat/completions" },
  mistral: { check: { url: "https://api.mistral.ai/v1/models", auth: "bearer" }, completions: "https://api.mistral.ai/v1/chat/completions" },
  sambanova: { check: { url: "https://api.sambanova.ai/v1/models", auth: "bearer" }, completions: "https://api.sambanova.ai/v1/chat/completions" },
  // Fixed 2026-09-11: check and completions were pointed at two different regional hosts (China vs. international)
  // — a key issued for one account region could pass/fail the check against the wrong host entirely. Both now use
  // the international endpoint, since that's the one a non-China-verified account signs up against.
  "alibaba-model-studio": { check: { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", auth: "bearer" }, completions: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions" },
  // Fixed 2026-09-11: was hardcoded to the China-legacy open.bigmodel.cn host, which requires a China-phone-verified
  // account. api.z.ai is Z.AI's international host with a plain email signup and free-tier GLM access.
  zhipu: { check: { url: "https://api.z.ai/api/paas/v4/models", auth: "bearer" }, completions: "https://api.z.ai/api/paas/v4/chat/completions" },
  deepseek: { check: { url: "https://api.deepseek.com/models", auth: "bearer" }, completions: "https://api.deepseek.com/chat/completions" },
  "public-ai": { check: { url: "https://api.publicai.co/v1/models", auth: "bearer" }, completions: "https://api.publicai.co/v1/chat/completions" },

  // Fixed 2026-09-11: were credential-checkable but had no completions entry at all, so every candidate was
  // permanently stuck on "no known endpoint" no matter how correct the credential was. Confirmed against each
  // provider's own current documentation, not memory.
  "hugging-face": { check: { url: "https://huggingface.co/api/whoami-v2", auth: "bearer" }, completions: "https://router.huggingface.co/v1/chat/completions" },
  "opencode-zen": { check: { url: "https://opencode.ai/zen/v1/models", auth: "bearer" }, completions: "https://opencode.ai/zen/v1/chat/completions" },
  // llm7 and Pollinations both confirmed (own docs) to serve a free/anonymous tier requiring no credential at all —
  // a key only raises rate limits. credentialOptional lets Integration status report these as usable today instead
  // of permanently "blocked on a credential" that was never actually required.
  llm7: { check: { url: "https://api.llm7.io/v1/models", auth: "bearer" }, completions: "https://api.llm7.io/v1/chat/completions", credentialOptional: true },
  minimax: { check: { url: "https://api.minimax.io/v1/models", auth: "bearer" }, completions: "https://api.minimax.io/v1/chat/completions" },
  pollinations: { check: { url: "https://gen.pollinations.ai/v1/models", auth: "bearer" }, completions: "https://gen.pollinations.ai/v1/chat/completions", credentialOptional: true },
  // Fixed 2026-09-11: was on Cohere's v1 models path; v2 is their current documented surface.
  cohere: { check: { url: "https://api.cohere.com/v2/models", auth: "bearer" }, completions: "https://api.cohere.ai/compatibility/v1/chat/completions" },

  // Fixed 2026-09-11: the reverse gap — had a completions entry but no credential check, so a correct credential
  // could never be marked verified and every candidate was permanently stuck on "credential unverified" instead.
  "together-ai": { check: { url: "https://api.together.xyz/v1/models", auth: "bearer" }, completions: "https://api.together.xyz/v1/chat/completions" },

  // Fixed 2026-09-11: had neither entry at all (not a bug that had bitten anyone yet — no credential was
  // configured for these — but the exact same trap was waiting the moment one was added, same as DeepSeek/Together).
  "modelscope": { check: { url: "https://api-inference.modelscope.cn/v1/models", auth: "bearer" }, completions: "https://api-inference.modelscope.cn/v1/chat/completions" },
  scaleway: { check: { url: "https://api.scaleway.ai/v1/models", auth: "bearer" }, completions: "https://api.scaleway.ai/v1/chat/completions" },
  wandb: { check: { url: "https://api.inference.wandb.ai/v1/models", auth: "bearer" }, completions: "https://api.inference.wandb.ai/v1/chat/completions" },
  typhoon: { check: { url: "https://api.opentyphoon.ai/v1/models", auth: "bearer" }, completions: "https://api.opentyphoon.ai/v1/chat/completions" },
  "volcengine-ark": { check: { url: "https://ark.cn-beijing.volces.com/api/v3/models", auth: "bearer" }, completions: "https://ark.cn-beijing.volces.com/api/v3/chat/completions" },

  // Fixed 2026-09-11: the old blanket comment claiming these three "can't discriminate a credential" only actually
  // held for Kilo. Ollama Cloud and Vercel AI Gateway's own current docs confirm their /v1/models endpoints do
  // require and validate a bearer token — they were excluded on a wrong assumption, not a confirmed limitation.
  "ollama-cloud": { check: { url: "https://ollama.com/v1/models", auth: "bearer" }, completions: "https://ollama.com/v1/chat/completions" },
  "vercel-ai-gateway": { check: { url: "https://ai-gateway.vercel.sh/v1/models", auth: "bearer" }, completions: "https://ai-gateway.vercel.sh/v1/chat/completions" },
  // Kilo's /models really is public/unauthenticated (confirmed in its own API reference) — no check is possible,
  // so this one relies entirely on the gate fallthrough: the real completions call is the only verification
  // available. Its free lane (kilo-auto/free and named free models) also genuinely needs no credential at all.
  kilo: { completions: "https://api.kilo.ai/api/gateway/chat/completions", credentialOptional: true },

  "chutes": { check: { url: "https://api.chutes.ai/v1/models", auth: "bearer" }, completions: "https://api.chutes.ai/v1/chat/completions", credentialOptional: true },
  "cloudflare-workers-ai": { check: { url: "https://api.cloudflare.com/client/v4/user/tokens/verify", auth: "bearer" } }, // completions needs the account-scoped Base URL set on the provider page

  // Added 2026-09-11: had zero wiring (portal link only). Sarvam's own docs confirm both its native
  // `api-subscription-key` header and standard `Authorization: Bearer` work — no models-listing endpoint is
  // confirmed public, so (like Kilo) this relies on the completions call itself as verification.
  sarvam: { completions: "https://api.sarvam.ai/v1/chat/completions" },

  // Added 2026-09-11, new providers from docs/models_source.md's watchlist audit — all confirmed base URL, bearer
  // auth, and a genuine (if sometimes trial/promotional) free tier this pass.
  siliconflow: { check: { url: "https://api.siliconflow.cn/v1/models", auth: "bearer" }, completions: "https://api.siliconflow.cn/v1/chat/completions" }, // 3 specific models fully free, no card, no usage limit
  novita: { check: { url: "https://api.novita.ai/openai/v1/models", auth: "bearer" }, completions: "https://api.novita.ai/openai/v1/chat/completions" }, // $0.50 trial credit
  fireworks: { check: { url: "https://api.fireworks.ai/inference/v1/models", auth: "bearer" }, completions: "https://api.fireworks.ai/inference/v1/chat/completions" }, // $1 trial credit
  featherless: { check: { url: "https://api.featherless.ai/v1/models", auth: "bearer" }, completions: "https://api.featherless.ai/v1/chat/completions" }, // 100,000 trial tokens on signup, no card
  hyperbolic: { check: { url: "https://api.hyperbolic.xyz/v1/models", auth: "bearer" }, completions: "https://api.hyperbolic.xyz/v1/chat/completions" }, // genuinely free Basic tier, no deposit
  nscale: { check: { url: "https://inference.api.nscale.com/v1/models", auth: "bearer" }, completions: "https://inference.api.nscale.com/v1/chat/completions" }, // $5 free credit on signup
  "byteplus-modelark": { check: { url: "https://ark.ap-southeast.bytepluses.com/api/v3/models", auth: "bearer" }, completions: "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions" }, // has an explicit "Free Tokens Only" mode, like Alibaba's
  deepinfra: { check: { url: "https://api.deepinfra.com/v1/openai/models", auth: "bearer" }, completions: "https://api.deepinfra.com/v1/openai/chat/completions" }, // trial/promotional balance, not a guaranteed durable free tier
  upstage: { check: { url: "https://api.upstage.ai/v1/models", auth: "bearer" }, completions: "https://api.upstage.ai/v1/chat/completions" }, // ~$10 credit valid 3 months
  stepfun: { check: { url: "https://api.stepfun.ai/v1/models", auth: "bearer" }, completions: "https://api.stepfun.ai/v1/chat/completions" }, // first month free on their Open Platform, then paid
  // Confirmed NOT free (needs a >=$1 recharge before any use) — wired for correctness/paid-lane routing, but
  // candidates from this provider must never be classified as a free model.
  moonshot: { check: { url: "https://api.moonshot.ai/v1/models", auth: "bearer" }, completions: "https://api.moonshot.ai/v1/chat/completions" },

  // Moved out of WIRING_PENDING 2026-09-12 after re-verification against each provider's own docs.
  // AI21: studio/v1/chat/completions is AI21's real (only) endpoint, not a separate proprietary API — its request/
  // response shape is OpenAI-message-compatible per AI21's own reference. No public /models list is documented, so
  // (like Kilo/Sarvam) there's no `check`: the completions call itself is the credential verification. $10 credit,
  // valid 3 months, no card required to start.
  ai21: { completions: "https://api.ai21.com/studio/v1/chat/completions" },
  // Baseten: "Model APIs" is a genuine shared, multi-tenant, self-serve product (distinct from Baseten's
  // bring-your-own-model Truss deployment product, which this app isn't wiring) — confirmed fully OpenAI-compatible
  // per Baseten's own API reference/changelog, with free signup credit and no card required.
  baseten: { check: { url: "https://inference.baseten.co/v1/models", auth: "bearer" }, completions: "https://inference.baseten.co/v1/chat/completions" },

  // Moved out of CUSTOM_ADAPTER_PROVIDERS 2026-09-19: GigaChat needs an OAuth2 client-credentials exchange (the
  // stored credential is the "Authorization key", not a usable Bearer token directly) and its hosts present a
  // Russian government CA chain Node doesn't trust by default — both handled in providers/gigachat.ts, which
  // discovery/verify.ts and providers/verify.ts swap in ahead of the generic bearer-token path below.
  gigachat: { check: { url: "https://gigachat.devices.sberbank.ru/api/v1/models", auth: "bearer" }, completions: "https://gigachat.devices.sberbank.ru/api/v1/chat/completions" },
  // Added 2026-09-19: additional providers with free tiers per freellm.net + community audits.
  // GitHub Models: requires X-GitHub-Api-Version: 2025-01-01 header; free tier 10 RPM/50 RPD for personal accounts.
  "github-models": { check: { url: "https://api.github.com/models", auth: "bearer" }, completions: "https://api.github.com/chat/completions" },
  // OVHcloud: European provider, 2 RPM anonymous/free tier, no credit card required.
  "ovhcloud": { check: { url: "https://api.ovhcloud.ai/v1/models", auth: "bearer" }, completions: "https://api.ovhcloud.ai/v1/chat/completions" },
  // Aion Labs: Israeli provider, 15 RPM / 20K TPD free tier.
  "aion-labs": { check: { url: "https://api.aionlabs.ai/v1/models", auth: "bearer" }, completions: "https://api.aionlabs.ai/v1/chat/completions" },
};

/** Providers this app expects to be automatable (catalog adapterCapability AUTOMATED/PARTIAL) that are
 *  deliberately not fully wired above, with the reason. Anything landing here is a tracked, visible gap —
 *  never a silent oversight — and providersWiring.test.ts enforces that every such provider is either wired
 *  or listed here. */
export const WIRING_PENDING: Readonly<Record<string, string>> = {
  "cloudflare-workers-ai": "completions endpoint is account-scoped — the user sets Base URL on the provider page",
  // Re-researched 2026-09-12: a real OpenAI-compatible base URL (api.lingyiwanwu.com/v1) shows up consistently
  // across third-party integration configs, but platform.01.ai / platform.lingyiwanwu.com's own docs are
  // JS-rendered and couldn't be independently confirmed, and no free tier/trial credit was found anywhere
  // (billing reads as prepay-only) — still not enough to wire a check/completions pair with confidence.
  // Added with the discovery-pipeline refactor: catalogued, but no completions endpoint has been confirmed with a real key.
  nebius: "Its model list is read from api.tokenfactory.nebius.com/v1/models (needs an API key), but its chat-completions endpoint has not been confirmed with a real key — set the Base URL on the provider page once you have one",
  "btl-runtime": "No completions endpoint has been confirmed for this provider yet — set the Base URL on the provider page",
  cline: "No completions endpoint has been confirmed for this provider yet — set the Base URL on the provider page",
  yi: "OpenAI-compatible surface plausible (api.lingyiwanwu.com/v1 per third-party integrations) but unconfirmed from 01.AI's own docs, and no free tier found — needs further research before wiring",
};

/** No cloud API to wire at all — a user-supplied Base URL is the entire connection. Not a gap: this is correct,
 *  intentional behavior, and Integration status should say so rather than imply something's broken or missing. */
export const SELF_HOSTED_PROVIDERS: ReadonlySet<string> = new Set(["lemonade", "local"]);

/** Providers whose real auth model can't be represented as this app's single static bearer/query credential —
 *  each needs its own token-exchange adapter and extra non-secret config (project/region/space ID) that don't
 *  exist yet. Tracked here (with the reason) so Integration status reports an honest "needs custom adapter" gap
 *  instead of a misleading generic "not wired", and so promotion never dangles a "Set base URL" fix that can't work. */
export const CUSTOM_ADAPTER_PROVIDERS: Readonly<Record<string, string>> = {
  "vertex-ai": "Needs OAuth service-account token exchange plus a project/region — not yet supported",
  "ibm-watsonx": "Needs IBM IAM token exchange plus a project/space ID — not yet supported",
};

export function supportsCredentialTest(slug: string): boolean {
  return Boolean(providerWiring[slug]?.check);
}

/** An explicit Base URL swaps in for a check endpoint's host+path prefix only when that check is itself
 *  `/models`-shaped (the OpenAI-compatible convention) — this is what fixes Alibaba-style region mismatches
 *  ("API keys from different regions are rejected with authentication errors", per Alibaba's own docs) without
 *  touching providers like Cloudflare whose check is a fixed, account-agnostic endpoint unrelated to their
 *  account-scoped completions Base URL. */
export function resolveCheck(slug: string, baseUrl?: string | null): ProviderCheck | null {
  const wiring = providerWiring[slug];
  if (!wiring?.check) return null;
  if (!baseUrl || !/\/models$/.test(wiring.check.url)) return wiring.check;
  return {...wiring.check, url: `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/models`};
}

/** The chat-completions URL a provider is reachable at — an explicit Base URL always wins (account-scoped or
 *  self-hosted providers), falling back to the wired default for everyone else. */
export function resolveCompletionsEndpoint(slug: string, baseUrl: string | null): string | null {
  // A complete completions URL (see endpointBaseHint) is used exactly as given.
  if (baseUrl && /\/chat\/completions\/?$/.test(baseUrl)) return baseUrl.replace(/\/$/, "");
  if (baseUrl) return `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
  return providerWiring[slug]?.completions ?? null;
}

/** SDK-style base URLs are what providers and datasets publish ("https://api.z.ai/api/paas/v4"): the OpenAI SDK appends
 *  `/chat/completions` to whatever it is given, with no assumption about a `/v1`. That is different from the Base URL a person
 *  types on the provider page, which resolveCompletionsEndpoint treats as a host. */
export function completionsUrlFromSdkBase(base: string): string {
  return `${base.trim().replace(/\/+$/, "")}/chat/completions`;
}

/** The value to pass as `baseUrl` to resolveCompletionsEndpoint for a provider, given what is known about it. Precedence: an
 *  explicit Base URL a person set; then the catalog's own wiring (nothing to pass); then the OpenAI-compatible base URL a
 *  source published for it, as a complete completions URL. Null when nothing is known, which is "no endpoint" (I3). */
export function endpointBaseHint(slug: string, baseUrl: string | null, offerBaseUrl: string | null): string | null {
  if (baseUrl) return baseUrl;
  if (providerWiring[slug]?.completions) return null;
  return offerBaseUrl ? completionsUrlFromSdkBase(offerBaseUrl) : null;
}

/**
 * What the Providers/Settings pages should actually say about a provider's integration — derived from this file's
 * wiring map, not the stale, unenforced `adapterCapability` label in catalog.ts. One source of truth, so a provider
 * can never again look "manual" in the UI while being fully wired underneath (or vice versa).
 */
export type IntegrationStatus = "LIVE" | "READY" | "NO_CREDENTIAL_NEEDED" | "SELF_HOSTED" | "NEEDS_CUSTOM_ADAPTER" | "NOT_WIRED";

export const integrationStatusLabels: Readonly<Record<IntegrationStatus, string>> = {
  LIVE: "Live", READY: "Ready", NO_CREDENTIAL_NEEDED: "No credential needed",
  SELF_HOSTED: "Self-hosted", NEEDS_CUSTOM_ADAPTER: "Needs custom adapter", NOT_WIRED: "Not wired",
};

export const integrationStatusTone: Readonly<Record<IntegrationStatus, "good" | "warn" | "bad" | "neutral">> = {
  LIVE: "good", NO_CREDENTIAL_NEEDED: "good", READY: "warn", NEEDS_CUSTOM_ADAPTER: "warn", SELF_HOSTED: "neutral", NOT_WIRED: "bad",
};

/**
 * Non-secret, per-provider extra credential fields a plain bearer key can't express, rendered as additional inputs
 * on the credential form and stored in providerCredentialReferences.config. Alibaba Model Studio's optional
 * Workspace ID is the first case: DashScope's newer workspace-scoped endpoints require it in the hostname, and
 * some workspace-scoped API keys are rejected on the shared compatible-mode host without it declared explicitly.
 */
export interface ExtraCredentialField { key: string; label: string; placeholder?: string; header: string; defaultValue?: string }
export const EXTRA_CREDENTIAL_FIELDS: Readonly<Record<string, readonly ExtraCredentialField[]>> = {
  "alibaba-model-studio": [{key: "workspaceId", label: "Workspace ID (optional)", placeholder: "llm-xxxxxxxxxxxxxxxx", header: "X-DashScope-WorkSpace"}],
  "github-models": [{key: "apiVersion", label: "API Version", header: "X-GitHub-Api-Version", defaultValue: "2025-01-01"}],
};

/** Turns a credential's stored config values into the extra HTTP headers this provider's requests need — applied
 *  to both our own check/completions calls. Unknown/empty config keys are silently ignored. */
export function buildExtraHeaders(slug: string, config: Record<string, string> | null | undefined): Record<string, string> {
  const fields = EXTRA_CREDENTIAL_FIELDS[slug];
  if (!fields || !config) return {};
  const headers: Record<string, string> = {};
  for (const field of fields) {
    const value = config[field.key] ?? field.defaultValue;
    if (value) headers[field.header] = value;
  }
  return headers;
}

export function getIntegrationStatus(slug: string, credential: {configured: boolean; verified: boolean}, hasLiveDeployments = false): IntegrationStatus {
  if (SELF_HOSTED_PROVIDERS.has(slug)) return "SELF_HOSTED";
  if (slug in CUSTOM_ADAPTER_PROVIDERS) return "NEEDS_CUSTOM_ADAPTER";
  const wiring = providerWiring[slug];
  // A provider outside every static registry (added ad hoc via "Add provider" in Settings, e.g. a custom
  // OpenAI-compatible endpoint) can still be demonstrably working — LiteLLM already has live deployments for it —
  // which is stronger, more current evidence than "not in our catalog" implies. Only report NOT_WIRED when there's
  // truly no sign it works.
  if (!wiring) return hasLiveDeployments ? "LIVE" : "NOT_WIRED";
  // Only an explicit credentialOptional flag means no key is required — the earlier `!wiring.check` fallback
  // wrongly swept in providers (like Sarvam) that DO need a credential but just have no safe check endpoint to
  // pre-validate it against; those should still read as READY, not falsely "no credential needed".
  if (wiring.credentialOptional) return "NO_CREDENTIAL_NEEDED";
  if (credential.verified) return "LIVE";
  return "READY";
}
