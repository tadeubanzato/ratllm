import { readFileSync } from "node:fs";
for (const line of readFileSync(".env","utf8").split("\n")) { const m=line.match(/^([A-Z0-9_]+)=(.*)$/); if(m && m[1]==="CREDENTIAL_ENCRYPTION_KEY") process.env[m[1]]=m[2].replace(/^["']|["']$/g,""); }
process.env.DATABASE_URL="postgresql://postgres:test@127.0.0.1:55433/curator";
const { getDb } = await import("../src/server/db/client.ts");
const { providers, providerCredentialReferences } = await import("../src/server/db/schema.ts");
const { eq, and } = await import("drizzle-orm");
const { resolveCredentialSecret } = await import("../src/server/discovery/verify.ts");
const db = getDb();
const T: Array<[string,string,string|null]> = [
 ["vercel","https://ai-gateway.vercel.sh/v1/models",null],["kilo","https://api.kilo.ai/api/gateway/models","kilo"],["together","https://api.together.xyz/v1/models","together-ai"],
 ["chutes","https://llm.chutes.ai/v1/models",null],["groq","https://api.groq.com/openai/v1/models","groq"],["nvidia","https://integrate.api.nvidia.com/v1/models","nvidia"],
 ["alibaba","https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models","alibaba-model-studio"],["modelscope","https://api-inference.modelscope.cn/v1/models",null],["gemini","https://generativelanguage.googleapis.com/v1beta/openai/models","google-ai-studio"],
];
for (const [label,url,slug] of T) {
  let secret:string|null=null;
  if (slug){const p=(await db.select().from(providers).where(eq(providers.slug,slug)).limit(1))[0]; if(p){const c=(await db.select().from(providerCredentialReferences).where(and(eq(providerCredentialReferences.providerId,p.id),eq(providerCredentialReferences.disabled,false))).limit(1))[0]; secret=c?resolveCredentialSecret(c):null;}}
  const j:any = await (await fetch(url,{headers:secret?{authorization:`Bearer ${secret}`}:{}})).json();
  const arr = Array.isArray(j)?j:j.data; const free = arr.find((m:any)=>JSON.stringify(m.pricing??{}).match(/"0(\.0+)?"|:0[,}]/))??arr[1];
  console.log(`\n== ${label} (${arr.length}) fields: ${Object.keys(arr[0]).join(",")}\n   ${JSON.stringify(free).slice(0,420)}`);
}
process.exit(0);
