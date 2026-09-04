import { getDb } from "./client";
import { lanes, providers, systemSettings } from "./schema";
import { LANE_IDS } from "@/lib/constants";
import { providerDefinitions } from "@/server/providers/catalog";

async function main() {
  const db=getDb();
  for(const provider of providerDefinitions) await db.insert(providers).values(provider).onConflictDoNothing();
  for(const slug of LANE_IDS) await db.insert(lanes).values({slug,name:slug.replace("smart-","Smart ").replace(/^./,c=>c.toUpperCase()),description:`Stable ${slug.replace("smart-","")} routing alias`,minimumHealthy:slug==="smart-speech"?1:2,eligibility:{healthy:true},weights:{reliability:0.25,latency:0.15,freeSustainability:0.15}}).onConflictDoNothing();
  await db.insert(systemSettings).values({key:"rate_learning.safety_factor",value:0.7,description:"Conservative multiplier applied to observed limits"}).onConflictDoNothing();
  console.info("Seed data applied");
}
main().then(() => process.exit(0)).catch((error: unknown) => { console.error(error); process.exit(1); });
