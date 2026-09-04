import { getDb } from "./client";
import { lanes, providers, systemSettings } from "./schema";
import { LANE_IDS } from "@/lib/constants";

const providerSeeds=[
  ["groq","Groq","openai-compatible","AUTOMATED"],["cerebras","Cerebras","openai-compatible","AUTOMATED"],["nvidia","NVIDIA NIM","openai-compatible","PARTIAL"],
  ["google-ai-studio","Google AI Studio","google-ai-studio","PARTIAL"],["openrouter","OpenRouter","openrouter","AUTOMATED"],["mistral","Mistral","openai-compatible","PARTIAL"],
  ["sambanova","SambaNova","openai-compatible","PARTIAL"],["cohere","Cohere","cohere","MANUAL"],["kilo","Kilo","manual","MANUAL"],
  ["vercel-ai-gateway","Vercel AI Gateway","manual","MANUAL"],["opencode-zen","OpenCode Zen","manual","MANUAL"],["llm7","LLM7","manual","MANUAL"],
  ["hugging-face","Hugging Face Inference","manual","PARTIAL"],["cloudflare-workers-ai","Cloudflare Workers AI","manual","PARTIAL"],["alibaba-model-studio","Alibaba Model Studio","manual","MANUAL"],
  ["ibm-watsonx","IBM watsonx.ai","manual","MANUAL"],["zhipu","Z.AI / Zhipu","manual","MANUAL"],["local","Local OpenAI-compatible","openai-compatible","MANUAL"],
] as const;
async function main() {
  const db=getDb();
  for(const [slug,name,adapterKey,capability] of providerSeeds) await db.insert(providers).values({slug,name,adapterKey,adapterCapability:capability}).onConflictDoNothing();
  for(const slug of LANE_IDS) await db.insert(lanes).values({slug,name:slug.replace("smart-","Smart ").replace(/^./,c=>c.toUpperCase()),description:`Stable ${slug.replace("smart-","")} routing alias`,minimumHealthy:slug==="smart-speech"?1:2,eligibility:{healthy:true},weights:{reliability:0.25,latency:0.15,freeSustainability:0.15}}).onConflictDoNothing();
  await db.insert(systemSettings).values({key:"rate_learning.safety_factor",value:0.7,description:"Conservative multiplier applied to observed limits"}).onConflictDoNothing();
  console.info("Seed data applied");
}
main().then(() => process.exit(0)).catch((error: unknown) => { console.error(error); process.exit(1); });
