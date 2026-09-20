/** Canonical provider identities. Discovery feeds are inconsistent, so callers
 * resolve through this catalogue instead of deriving a slug from raw text. */
export interface ProviderDefinition { slug:string; name:string; adapterKey:string; adapterCapability:"AUTOMATED"|"PARTIAL"|"MANUAL"; }
export const providerDefinitions:readonly ProviderDefinition[]=[
  {slug:"groq",name:"Groq",adapterKey:"openai-compatible",adapterCapability:"AUTOMATED"},{slug:"cerebras",name:"Cerebras",adapterKey:"openai-compatible",adapterCapability:"AUTOMATED"},{slug:"nvidia",name:"NVIDIA NIM",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"google-ai-studio",name:"Google AI Studio",adapterKey:"google-ai-studio",adapterCapability:"PARTIAL"},{slug:"vertex-ai",name:"Google Cloud Vertex AI",adapterKey:"vertex-ai",adapterCapability:"MANUAL"},{slug:"openrouter",name:"OpenRouter",adapterKey:"openrouter",adapterCapability:"AUTOMATED"},{slug:"mistral",name:"Mistral",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"sambanova",name:"SambaNova",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"cohere",name:"Cohere",adapterKey:"cohere",adapterCapability:"MANUAL"},
  {slug:"hugging-face",name:"Hugging Face Inference",adapterKey:"manual",adapterCapability:"PARTIAL"},{slug:"cloudflare-workers-ai",name:"Cloudflare Workers AI",adapterKey:"manual",adapterCapability:"PARTIAL"},{slug:"alibaba-model-studio",name:"Alibaba Cloud Model Studio",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"zhipu",name:"Z.AI / Zhipu",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"volcengine-ark",name:"Volcengine Ark",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"gigachat",name:"GigaChat",adapterKey:"gigachat",adapterCapability:"MANUAL"},
  {slug:"together-ai",name:"Together AI",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"public-ai",name:"PublicAI",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"sarvam",name:"Sarvam AI",adapterKey:"sarvam",adapterCapability:"MANUAL"},
  {slug:"deepseek",name:"DeepSeek",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"minimax",name:"MiniMax",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  // Lemonade is a self-hosted OpenAI-compatible server, not a credential vendor.
  {slug:"lemonade",name:"Lemonade Server",adapterKey:"openai-compatible",adapterCapability:"MANUAL"},{slug:"ibm-watsonx",name:"IBM watsonx.ai",adapterKey:"manual",adapterCapability:"MANUAL"},{slug:"kilo",name:"Kilo",adapterKey:"manual",adapterCapability:"MANUAL"},{slug:"vercel-ai-gateway",name:"Vercel AI Gateway",adapterKey:"manual",adapterCapability:"MANUAL"},{slug:"opencode-zen",name:"OpenCode Zen",adapterKey:"manual",adapterCapability:"MANUAL"},{slug:"llm7",name:"LLM7",adapterKey:"manual",adapterCapability:"MANUAL"},{slug:"local",name:"Local OpenAI-compatible",adapterKey:"openai-compatible",adapterCapability:"MANUAL"},
  {slug:"scaleway",name:"Scaleway Generative APIs",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"ollama-cloud",name:"Ollama Cloud",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"modelscope",name:"ModelScope API-Inference",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"pollinations",name:"Pollinations.ai",adapterKey:"manual",adapterCapability:"MANUAL"},{slug:"wandb",name:"W&B Inference",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"typhoon",name:"Typhoon (SCB 10X)",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  // Added 2026-09-11 per docs/models_source.md's provider watchlist audit. High/medium-confidence bearer +
  // OpenAI-compatible providers with a real (if sometimes trial/promotional) free tier, confirmed against each
  // provider's own docs this pass — see wiring.ts for per-provider confidence notes.
  {slug:"siliconflow",name:"SiliconFlow",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"novita",name:"Novita AI",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"fireworks",name:"Fireworks AI",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"featherless",name:"Featherless AI",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"hyperbolic",name:"Hyperbolic",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"nscale",name:"Nscale",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"byteplus-modelark",name:"BytePlus ModelArk",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"deepinfra",name:"DeepInfra",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"upstage",name:"Upstage",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"stepfun",name:"StepFun",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  // Confirmed NOT free this pass (Moonshot needs a >=$1 recharge before use at all) — still worth wiring/cataloging
  // for completeness and future paid-lane routing, just never treat as a free-model source.
  {slug:"moonshot",name:"Moonshot AI (Kimi)",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  // Moved from WIRING_PENDING 2026-09-12: re-researched against each provider's own current docs. AI21's Jamba
  // API is the real (only) endpoint, OpenAI-message-shaped, $10/3-month credit, no card required — it just has no
  // separate /models list, so (like Kilo/Sarvam) the completions call itself is the verification. Baseten's
  // "Model APIs" product is a genuine shared, self-serve, OpenAI-compatible surface with free signup credit,
  // distinct from its bring-your-own-model Truss deployment product this repo isn't wiring.
  {slug:"ai21",name:"AI21",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},{slug:"baseten",name:"Baseten",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  // Lower confidence: endpoint shape/free-tier access not independently confirmed this pass. Catalogued (visible,
  // portal-linked) but deliberately NOT wired — see WIRING_PENDING in wiring.ts for the specific reason each needs
  // verification before a check/completions pair is added.
  {slug:"yi",name:"01.AI / Yi",adapterKey:"manual",adapterCapability:"MANUAL"},
  // Added 2026-09-19: additional providers with free tiers per freellm.net + community audits.
  {slug:"github-models",name:"GitHub Models",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"ovhcloud",name:"OVHcloud AI Endpoints",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"aion-labs",name:"Aion Labs",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  // Added 2026-09-20: additional free providers found during web audit — permanent free tiers or generous trial credits.
  {slug:"chutes",name:"Chutes AI",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"nebius",name:"Nebius Token Factory",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"btl-runtime",name:"BTL Runtime",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
  {slug:"cline",name:"Cline",adapterKey:"openai-compatible",adapterCapability:"PARTIAL"},
] as const;
const bySlug=new Map(providerDefinitions.map(item=>[item.slug,item]));
/** The catalog entry for a provider slug (e.g. one read back from the providers table), or null if it isn't catalogued. */
export function providerDefinitionBySlug(slug:string|null|undefined):ProviderDefinition|null{return slug?bySlug.get(slug)??null:null;}
const aliases:Readonly<Record<string,string>>={gemini:"google-ai-studio",google:"google-ai-studio",google_ai_studio:"google-ai-studio",google_gemini:"google-ai-studio",nvidia_nim:"nvidia",huggingface:"hugging-face",hugging_face:"hugging-face",cloudflare:"cloudflare-workers-ai",cloudflare_ai:"cloudflare-workers-ai",watsonx:"ibm-watsonx",watsonx_ai:"ibm-watsonx",zai:"zhipu",zhipuai:"zhipu",z_ai:"zhipu",zai_glm:"zhipu",codestral:"mistral",together_ai:"together-ai",publicai:"public-ai",volcengine:"volcengine-ark",vertex_ai:"vertex-ai",vertex_ai_llama_models:"vertex-ai",vercel_ai_gateway:"vercel-ai-gateway",ollama_cloud:"ollama-cloud",wandb_inference:"wandb",byteplus:"byteplus-modelark",modelark:"byteplus-modelark",kimi:"moonshot",moonshot_ai:"moonshot","01_ai":"yi","01ai":"yi",zero_one_ai:"yi",lingyiwanwu:"yi",fireworks_ai:"fireworks",featherless_ai:"featherless",
  // These are models.dev's own display names for providers already in providerDefinitions above — without an
  // alias here, a normalized name-match miss used to fall through to guessing a provider from the model ref's
  // own path prefix (see below), which is how e.g. an EdenAI or LLM Gateway routing entry like "deepinfra/foo"
  // got misfiled onto the real DeepInfra provider despite never having come from DeepInfra's own catalog.
  deep_infra:"deepinfra","stepfun_china":"stepfun","minimax_minimax_io":"minimax",coreweave:"wandb",kilo_gateway:"kilo",sarvam_ai:"sarvam",ai21_labs:"ai21","github_models":"github-models","ovhcloud":"ovhcloud","aion_labs":"aion-labs","sambanova_cloud":"sambanova","llm7":"llm7","opencode_zen":"opencode-zen"};
const normalized=(value:string)=>value.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
// A provider's own display name ("W&B Inference", "Chutes AI", "Novita AI") is what discovery sources store as
// providerName once a record has been matched to it, and it never appears in `aliases` — so without this a
// perfectly catalogued provider fell through to "unresolved" purely because its name isn't spelled like its slug.
const byName=new Map(providerDefinitions.map(item=>[normalized(item.name),item]));

/** Resolve source metadata and bare community model IDs to a known provider. The model-ref-prefix guess (a
 *  provider slug happens to be the model id's first path segment) is only trusted when there's no providerName
 *  to check it against, or when providerName itself corroborates the same provider — otherwise a providerName
 *  that's present but unmapped means "a real source we haven't catalogued" (e.g. models.dev's "edenai"/
 *  "llmgateway-providers" aggregator buckets), and must stay unresolved. Those buckets reuse other providers'
 *  names as routing prefixes in their own model ids — EdenAI's "deepinfra/ByteDance/Seed-2.0-mini" is EdenAI's
 *  id, not a real DeepInfra model, and providerName ("EdenAI") doesn't corroborate "deepinfra" — while a source
 *  like ModelScope's own listing has providerName "ModelScope API-Inference" *and* a "modelscope/..." modelRef,
 *  which do corroborate each other and should still resolve. */
export function resolveProvider(providerName:string|null|undefined,modelRef:string):ProviderDefinition|null {const raw=normalized(providerName??"");const candidate=aliases[raw]??aliases[raw.replaceAll("-","_")]??raw;if(candidate&&bySlug.has(candidate))return bySlug.get(candidate)??null;if(raw&&byName.has(raw))return byName.get(raw)??null;const model=modelRef.trim().toLowerCase();const prefix=model.split("/",1)[0]??"";const mappedPrefix=aliases[normalized(prefix)]??normalized(prefix);if(bySlug.has(mappedPrefix)&&(!raw||raw.includes(mappedPrefix)))return bySlug.get(mappedPrefix)??null;if(/^(?:zai-org\/)?glm[-_]/.test(model))return bySlug.get("zhipu")??null;if(/^(?:qwen|tongyi)[-_]/.test(model))return bySlug.get("alibaba-model-studio")??null;return null;}
export function providerSlug(providerName:string|null|undefined,modelRef:string):string|null{return resolveProvider(providerName,modelRef)?.slug??null;}
