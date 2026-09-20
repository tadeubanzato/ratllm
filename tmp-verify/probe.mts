import { readFileSync } from "node:fs";
for (const line of readFileSync(".env","utf8").split("\n")) { const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m && m[1]==="CREDENTIAL_ENCRYPTION_KEY") process.env[m[1]]=m[2].replace(/^["']|["']$/g,""); }
process.env.DATABASE_URL="postgresql://postgres:test@127.0.0.1:55433/curator";
const { getDb } = await import("../src/server/db/client.ts");
const { providers, providerCredentialReferences } = await import("../src/server/db/schema.ts");
const { eq, and } = await import("drizzle-orm");
const { resolveCredentialSecret } = await import("../src/server/discovery/verify.ts");
const db = getDb();
const T: Array<[string,string,string|null]> = [
 ["gemini(openai-compat)","https://generativelanguage.googleapis.com/v1beta/openai/models","google-ai-studio"],
 ["vercel gateway","https://ai-gateway.vercel.sh/v1/models",null],
 ["groq","https://api.groq.com/openai/v1/models","groq"],
 ["nvidia","https://integrate.api.nvidia.com/v1/models","nvidia"],
 ["alibaba intl","https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models","alibaba-model-studio"],
 ["zai","https://api.z.ai/api/paas/v4/models","zhipu"],
 ["modelscope","https://api-inference.modelscope.cn/v1/models","modelscope"],
 ["nebius studio","https://api.studio.nebius.com/v1/models","nebius"],
 ["nebius tokenfactory","https://api.tokenfactory.nebius.com/v1/models","nebius"],
 ["baseten","https://inference.baseten.co/v1/models","baseten"],
 ["pollinations /openai/models","https://text.pollinations.ai/openai/models",null],
 ["pollinations /models","https://text.pollinations.ai/models",null],
 ["fireworks","https://api.fireworks.ai/inference/v1/models","fireworks"],
 ["together","https://api.together.xyz/v1/models","together-ai"],
 ["chutes","https://llm.chutes.ai/v1/models","chutes"],
 ["kilo gateway","https://api.kilo.ai/api/gateway/models","kilo"],
 ["kilo openrouter","https://api.kilo.ai/api/openrouter/models","kilo"],
 ["mistral","https://api.mistral.ai/v1/models","mistral"],
 ["cohere","https://api.cohere.com/v1/models","cohere"],
 ["minimax","https://api.minimax.chat/v1/models","minimax"],
 ["cerebras","https://api.cerebras.ai/v1/models","cerebras"],
 ["deepseek","https://api.deepseek.com/v1/models","deepseek"],
];
for (const [label,url,slug] of T) {
  let secret: string|null = null;
  if (slug) { const p=(await db.select().from(providers).where(eq(providers.slug,slug)).limit(1))[0]; if(p){ const c=(await db.select().from(providerCredentialReferences).where(and(eq(providerCredentialReferences.providerId,p.id),eq(providerCredentialReferences.disabled,false))).limit(1))[0]; secret=c?resolveCredentialSecret(c):null; } }
  try {
    const r = await fetch(url,{headers:{accept:"application/json",...(secret?{authorization:`Bearer ${secret}`}:{})},signal:AbortSignal.timeout(20000)});
    const txt = await r.text(); let n:any="?", shape="", sample="";
    try { const j=JSON.parse(txt); const arr = Array.isArray(j)?j:(j.data??j.models??j.result??[]); shape=Array.isArray(j)?"[array]":Object.keys(j).slice(0,4).join(","); n=Array.isArray(arr)?arr.length:"?"; sample=(Array.isArray(arr)?arr.slice(0,2).map((m:any)=>m.id??m.name??m.model??JSON.stringify(m).slice(0,40)):[]).join(" | "); } catch { shape="non-json:"+txt.slice(0,50).replace(/\s+/g," "); }
    console.log(`${label.padEnd(26)} key=${secret?"yes":"no "} http=${r.status} n=${n} shape=${shape} sample=${sample}`);
  } catch (e:any) { console.log(`${label.padEnd(26)} key=${secret?"yes":"no "} ERROR ${String(e.message).slice(0,70)}`); }
}
process.exit(0);
