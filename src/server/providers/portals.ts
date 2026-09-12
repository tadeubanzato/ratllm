import "server-only";
import { providerSlug } from "./catalog";
export interface ProviderPortal {
  url: string;
  label: "Generate API key" | "Open provider console";
}

const providerPortals: Readonly<Record<string, ProviderPortal>> = {
  groq: { url: "https://console.groq.com/keys", label: "Generate API key" },
  cerebras: { url: "https://cloud.cerebras.ai/", label: "Open provider console" },
  nvidia: { url: "https://build.nvidia.com/", label: "Open provider console" },
  "google-ai-studio": { url: "https://aistudio.google.com/apikey", label: "Generate API key" },
  openrouter: { url: "https://openrouter.ai/settings/keys", label: "Generate API key" },
  mistral: { url: "https://console.mistral.ai/api-keys", label: "Generate API key" },
  sambanova: { url: "https://cloud.sambanova.ai/apis", label: "Generate API key" },
  cohere: { url: "https://dashboard.cohere.com/api-keys", label: "Generate API key" },
  kilo: { url: "https://app.kilo.ai/", label: "Open provider console" },
  "vercel-ai-gateway": { url: "https://vercel.com/ai-gateway", label: "Open provider console" },
  "opencode-zen": { url: "https://opencode.ai/auth", label: "Open provider console" },
  llm7: { url: "https://token.llm7.io/", label: "Generate API key" },
  "hugging-face": { url: "https://huggingface.co/settings/tokens", label: "Generate API key" },
  "cloudflare-workers-ai": { url: "https://dash.cloudflare.com/profile/api-tokens", label: "Generate API key" },
  "alibaba-model-studio": { url: "https://modelstudio.console.alibabacloud.com/", label: "Open provider console" },
  "ibm-watsonx": { url: "https://cloud.ibm.com/iam/apikeys", label: "Generate API key" },
  zhipu: { url: "https://z.ai/manage-apikey/apikey-list", label: "Generate API key" },
  "vertex-ai": { url: "https://console.cloud.google.com/apis/credentials", label: "Open provider console" },
  "volcengine-ark": { url: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", label: "Generate API key" },
  gigachat: { url: "https://developers.sber.ru/docs/ru/gigachat/individuals-quickstart", label: "Open provider console" },
  "together-ai": { url: "https://api.together.ai/settings/api-keys", label: "Generate API key" },
  sarvam: { url: "https://dashboard.sarvam.ai/key-management", label: "Generate API key" },
  "public-ai": { url: "https://platform.publicai.co/", label: "Open provider console" },
  deepseek: { url: "https://platform.deepseek.com/", label: "Generate API key" },
  minimax: { url: "https://platform.minimax.io/", label: "Generate API key" },
  scaleway: { url: "https://console.scaleway.com/iam/api-keys", label: "Generate API key" },
  "ollama-cloud": { url: "https://ollama.com/settings/keys", label: "Generate API key" },
  modelscope: { url: "https://modelscope.cn/my/myaccesstoken", label: "Generate API key" },
  pollinations: { url: "https://enter.pollinations.ai/keys", label: "Generate API key" },
  wandb: { url: "https://wandb.ai/authorize", label: "Generate API key" },
  typhoon: { url: "https://playground.opentyphoon.ai/api-key", label: "Generate API key" },
  siliconflow: { url: "https://cloud.siliconflow.cn/account/ak", label: "Generate API key" },
  novita: { url: "https://novita.ai/settings/key-management", label: "Generate API key" },
  fireworks: { url: "https://fireworks.ai/account/api-keys", label: "Generate API key" },
  featherless: { url: "https://featherless.ai/account/api-keys", label: "Generate API key" },
  hyperbolic: { url: "https://app.hyperbolic.xyz/settings", label: "Generate API key" },
  nscale: { url: "https://console.nscale.com/", label: "Open provider console" },
  "byteplus-modelark": { url: "https://console.byteplus.com/ark", label: "Open provider console" },
  deepinfra: { url: "https://deepinfra.com/dash/api_keys", label: "Generate API key" },
  upstage: { url: "https://console.upstage.ai/api-keys", label: "Generate API key" },
  stepfun: { url: "https://platform.stepfun.com/", label: "Open provider console" },
  moonshot: { url: "https://platform.moonshot.ai/console/api-keys", label: "Generate API key" },
  ai21: { url: "https://studio.ai21.com/account/api-key", label: "Generate API key" },
  baseten: { url: "https://app.baseten.co/settings/api_keys", label: "Generate API key" },
  yi: { url: "https://platform.01.ai/apikeys", label: "Generate API key" },
};

export function getProviderPortal(slug: string): ProviderPortal | null {
  return providerPortals[slug] ?? null;
}

export function getCandidateProviderPortal(source:string,providerName:string|null,modelRef:string):ProviderPortal|null {
  if(source==="openrouter")return getProviderPortal("openrouter");
  const slug=providerSlug(providerName,modelRef);
  return slug?getProviderPortal(slug):null;
}
