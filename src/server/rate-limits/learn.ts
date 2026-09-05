import "server-only";
import { eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments, rateLimitProfiles, smokeTests } from "@/server/db/schema";
/** Backfills a profile row for any deployment that doesn't have one yet — nothing else in the app creates these, so without this the learning pass has permanently had zero rows to work with. */
async function ensureProfiles(db: ReturnType<typeof getDb>) {
  const [deployments, existing] = await Promise.all([db.select({ id: modelDeployments.id }).from(modelDeployments), db.select({ deploymentId: rateLimitProfiles.deploymentId }).from(rateLimitProfiles)]);
  const have = new Set(existing.map(row => row.deploymentId));
  const missing = deployments.filter(row => !have.has(row.id));
  if (missing.length) await db.insert(rateLimitProfiles).values(missing.map(row => ({ deploymentId: row.id })));
}
export async function learnRateLimits(){const db=getDb();await ensureProfiles(db);const profiles=await db.select().from(rateLimitProfiles).where(isNotNull(rateLimitProfiles.deploymentId));let updated=0;for(const profile of profiles){if(profile.manualRpm||profile.manualTpm)continue;const tests=await db.select().from(smokeTests).where(eq(smokeTests.deploymentId,profile.deploymentId)).limit(30);const limited=tests.filter(test=>test.httpStatus===429);const observed=Math.max(1,tests.length-limited.length);const safe=Math.max(1,Math.floor(observed*.7));await db.update(rateLimitProfiles).set({observedRpm:observed,safeRpm:safe,confidence:tests.length>=10?"MEDIUM":"LOW",confidenceScore:Math.min(.9,tests.length/20),sampleCount:profile.sampleCount+tests.length,lastProbeAt:new Date(),last429At:limited[0]?.createdAt??profile.last429At,updatedAt:new Date()}).where(eq(rateLimitProfiles.id,profile.id));updated++;}return {profiles:profiles.length,updated,conservative:true};}
