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
  "alibaba-model-studio": { url: "https://bailian.console.alibabacloud.com/", label: "Open provider console" },
  "ibm-watsonx": { url: "https://cloud.ibm.com/iam/apikeys", label: "Generate API key" },
  zhipu: { url: "https://open.bigmodel.cn/usercenter/apikeys", label: "Generate API key" },
};

export function getProviderPortal(slug: string): ProviderPortal | null {
  return providerPortals[slug] ?? null;
}

const providerAliases: Readonly<Record<string,string>> = {
  gemini: "google-ai-studio",
  google: "google-ai-studio",
  google_ai_studio: "google-ai-studio",
  nvidia_nim: "nvidia",
  huggingface: "hugging-face",
  hugging_face: "hugging-face",
  cloudflare: "cloudflare-workers-ai",
  cloudflare_ai: "cloudflare-workers-ai",
  watsonx: "ibm-watsonx",
  watsonx_ai: "ibm-watsonx",
  zai: "zhipu",
  zhipuai: "zhipu",
  vercel_ai_gateway: "vercel-ai-gateway",
};

export function getCandidateProviderPortal(source:string,providerName:string|null,modelRef:string):ProviderPortal|null {
  if(source==="openrouter")return getProviderPortal("openrouter");
  const raw=(providerName??modelRef.split("/",1)[0]??"").trim().toLowerCase().replace(/[ .]+/g,"-");
  const normalized=providerAliases[raw]??providerAliases[raw.replaceAll("-","_")]??raw;
  return getProviderPortal(normalized);
}
