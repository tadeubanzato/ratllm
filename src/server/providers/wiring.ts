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
}

export const providerWiring: Readonly<Record<string, ProviderWiring>> = {
  groq: { check: { url: "https://api.groq.com/openai/v1/models", auth: "bearer" }, completions: "https://api.groq.com/openai/v1/chat/completions" },
  cerebras: { check: { url: "https://api.cerebras.ai/v1/models", auth: "bearer" }, completions: "https://api.cerebras.ai/v1/chat/completions" },
  nvidia: { check: { url: "https://integrate.api.nvidia.com/v1/models", auth: "bearer" }, completions: "https://integrate.api.nvidia.com/v1/chat/completions" },
  "google-ai-studio": { check: { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "query" }, completions: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
  openrouter: { check: { url: "https://openrouter.ai/api/v1/auth/key", auth: "bearer" }, completions: "https://openrouter.ai/api/v1/chat/completions" },
  mistral: { check: { url: "https://api.mistral.ai/v1/models", auth: "bearer" }, completions: "https://api.mistral.ai/v1/chat/completions" },
  sambanova: { check: { url: "https://api.sambanova.ai/v1/models", auth: "bearer" }, completions: "https://api.sambanova.ai/v1/chat/completions" },
  "alibaba-model-studio": { check: { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/models", auth: "bearer" }, completions: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions" },
  zhipu: { check: { url: "https://open.bigmodel.cn/api/paas/v4/models", auth: "bearer" }, completions: "https://open.bigmodel.cn/api/paas/v4/chat/completions" },
  deepseek: { check: { url: "https://api.deepseek.com/models", auth: "bearer" }, completions: "https://api.deepseek.com/chat/completions" },
  "public-ai": { check: { url: "https://api.publicai.co/v1/models", auth: "bearer" }, completions: "https://api.publicai.co/v1/chat/completions" },

  // Fixed 2026-09-11: were credential-checkable but had no completions entry at all, so every candidate was
  // permanently stuck on "no known endpoint" no matter how correct the credential was. Confirmed against each
  // provider's own current documentation, not memory.
  "hugging-face": { check: { url: "https://huggingface.co/api/whoami-v2", auth: "bearer" }, completions: "https://router.huggingface.co/v1/chat/completions" },
  "opencode-zen": { check: { url: "https://opencode.ai/zen/v1/models", auth: "bearer" }, completions: "https://opencode.ai/zen/v1/chat/completions" },
  llm7: { check: { url: "https://api.llm7.io/v1/models", auth: "bearer" }, completions: "https://api.llm7.io/v1/chat/completions" },
  minimax: { check: { url: "https://api.minimax.io/v1/models", auth: "bearer" }, completions: "https://api.minimax.io/v1/chat/completions" },
  pollinations: { check: { url: "https://gen.pollinations.ai/v1/models", auth: "bearer" }, completions: "https://gen.pollinations.ai/v1/chat/completions" },
  cohere: { check: { url: "https://api.cohere.com/v1/models", auth: "bearer" }, completions: "https://api.cohere.ai/compatibility/v1/chat/completions" },

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
  // so this one relies entirely on the gate fallthrough: the real completions call is the only verification available.
  kilo: { completions: "https://api.kilo.ai/api/gateway/chat/completions" },

  "cloudflare-workers-ai": { check: { url: "https://api.cloudflare.com/client/v4/user/tokens/verify", auth: "bearer" } }, // completions needs the account-scoped Base URL set on the provider page
};

/** Providers this app expects to be automatable (catalog adapterCapability AUTOMATED/PARTIAL) that are
 *  deliberately not fully wired above, with the reason. Anything landing here is a tracked, visible gap —
 *  never a silent oversight — and providersWiring.test.ts enforces that every such provider is either wired
 *  or listed here. */
export const WIRING_PENDING: Readonly<Record<string, string>> = {
  "cloudflare-workers-ai": "completions endpoint is account-scoped — the user sets Base URL on the provider page",
};

export function supportsCredentialTest(slug: string): boolean {
  return Boolean(providerWiring[slug]?.check);
}

export function resolveCheck(slug: string): ProviderCheck | null {
  return providerWiring[slug]?.check ?? null;
}

/** The chat-completions URL a provider is reachable at — an explicit Base URL always wins (account-scoped or
 *  self-hosted providers), falling back to the wired default for everyone else. */
export function resolveCompletionsEndpoint(slug: string, baseUrl: string | null): string | null {
  if (baseUrl) return `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
  return providerWiring[slug]?.completions ?? null;
}
