import "server-only";
import { desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments, rateLimitProfiles, smokeTests } from "@/server/db/schema";
/** Backfills a profile row for any deployment that doesn't have one yet — nothing else in the app creates these, so without this the learning pass has permanently had zero rows to work with. */
async function ensureProfiles(db: ReturnType<typeof getDb>) {
  const [deployments, existing] = await Promise.all([db.select({ id: modelDeployments.id }).from(modelDeployments), db.select({ deploymentId: rateLimitProfiles.deploymentId }).from(rateLimitProfiles)]);
  const have = new Set(existing.map(row => row.deploymentId));
  const missing = deployments.filter(row => !have.has(row.id));
  if (missing.length) await db.insert(rateLimitProfiles).values(missing.map(row => ({ deploymentId: row.id })));
}
/** Records recent smoke-test outcomes per deployment. It deliberately does NOT publish RPM/TPM estimates: smoke tests are
 *  spaced probes, not a measured requests-per-minute window, so any number derived from them (the previous
 *  "70% of non-429 tests" figure) was precise-looking but meaningless. Observed/safe values are cleared instead, so
 *  nothing displays or routes on an invented limit. Real learning needs LiteLLM usage telemetry or provider
 *  rate-limit headers — see findings.md F-08. Manual overrides are never touched. */
export async function learnRateLimits(){
  const db=getDb();await ensureProfiles(db);
  const profiles=await db.select().from(rateLimitProfiles).where(isNotNull(rateLimitProfiles.deploymentId));
  let updated=0;
  for(const profile of profiles){
    if(profile.manualRpm||profile.manualTpm)continue;
    const tests=await db.select().from(smokeTests).where(eq(smokeTests.deploymentId,profile.deploymentId)).orderBy(desc(smokeTests.createdAt)).limit(30);
    const latest429=tests.find(test=>test.httpStatus===429);
    await db.update(rateLimitProfiles).set({observedRpm:null,observedTpm:null,safeRpm:null,safeTpm:null,confidence:"UNKNOWN",confidenceScore:0,sampleCount:tests.length,lastProbeAt:new Date(),last429At:latest429?.createdAt??profile.last429At,updatedAt:new Date()}).where(eq(rateLimitProfiles.id,profile.id));
    updated++;
  }
  return {profiles:profiles.length,updated,measured:false};
}
