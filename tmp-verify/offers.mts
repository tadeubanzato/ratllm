import { readFileSync } from "node:fs";
import { attributeProvider, attributeOfferProvider } from "../src/server/providers/attribution.ts";
const d = JSON.parse(readFileSync("/tmp/claude-1000/-home-tbanzato-ratllm/19b5ece6-9240-4366-9808-e7b63f321c6a/scratchpad/hub.json","utf8"));
let cat=0, viaFallback=0, derived=0; const rows:string[]=[];
for (const p of d.providers) {
  const byName = attributeProvider(p.name, ""); const full = attributeOfferProvider({providerName:p.name, slugHint:p.slug, openaiBaseUrl:p.openai_base_url});
  const how = byName?.origin==="CATALOG" ? "name" : full?.origin==="CATALOG" ? "slug/host" : "DERIVED";
  if (how==="name") cat++; else if (how==="slug/host") viaFallback++; else derived++;
  if (how!=="name") rows.push(`${how.padEnd(9)} ${p.name.padEnd(44)} slug=${String(p.slug).padEnd(22)} -> ${full?.slug}`);
}
console.log({ total: d.providers.length, byCatalogName: cat, viaSlugOrHost: viaFallback, derived }); console.log(rows.join("\n"));
