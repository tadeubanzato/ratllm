import { getDb } from "./client";
import { lanes, providers, systemSettings } from "./schema";
import { LANE_IDS } from "@/lib/constants";
import { providerDefinitions } from "@/server/providers/catalog";
import { LANE_RULES, laneEligibilityRecord } from "@/server/lanes/rules";

async function main() {
  const db=getDb();
  for(const provider of providerDefinitions) await db.insert(providers).values(provider).onConflictDoNothing();
  for(const slug of LANE_IDS) {
    const eligibility=laneEligibilityRecord(slug);
    const values={slug,name:slug.replace("smart-","Smart ").replace(/^./,c=>c.toUpperCase()),description:`Stable ${slug.replace("smart-","")} routing alias`,minimumHealthy:slug==="smart-speech"?1:2,maximumDeployments:LANE_RULES[slug].maxDeployments,eligibility,weights:{reliability:0.25,latency:0.15,freeSustainability:0.15}};
    await db.insert(lanes).values(values).onConflictDoUpdate({target:lanes.slug,set:{eligibility,maximumDeployments:values.maximumDeployments,updatedAt:new Date()}});
  }
  await db.insert(systemSettings).values({key:"rate_learning.safety_factor",value:0.7,description:"Conservative multiplier applied to observed limits"}).onConflictDoNothing();
  console.info("Seed data applied");
}
main().then(() => process.exit(0)).catch((error: unknown) => { console.error(error); process.exit(1); });
