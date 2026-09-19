import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { apiError, correlationId } from "@/server/http";
import { getDb } from "@/server/db/client";
import { laneAssignments, lanes, modelCandidates, modelDeployments } from "@/server/db/schema";
import { bareModelKey } from "@/server/discovery/model-key";
import { classifyCandidateLanes, LANE_RULES } from "@/server/lanes/rules";
import { getDeploymentsForProvider } from "@/server/lanes/shared";
import { liveLaneMember } from "@/server/lanes/membership";
import { PromotionBlocked, resolvePromotionContext } from "@/server/lanes/promote";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = correlationId(request);
  const candidateId = (await params).id;
  const db = getDb();

  const candidate = (await db.select().from(modelCandidates).where(eq(modelCandidates.id, candidateId)).limit(1))[0];
  if (!candidate) return apiError("CANDIDATE_NOT_FOUND", "Candidate not found", 404, id);

  let blocked: string | null = null;
  let directAliasName: string | null = null;
  let members: string[] = [];
  try {
    const ctx = await resolvePromotionContext(candidateId);
    directAliasName = ctx.directAliasName;
    const key = bareModelKey(`openai/${ctx.bareModel}`);
    const deploymentIds = (await getDeploymentsForProvider(ctx.providerRow.id))
      .filter(row => bareModelKey(row.providerModelId) === key)
      .map(row => row.id);
    if (deploymentIds.length) {
      members = (await db.select({ slug: lanes.slug }).from(laneAssignments)
        .innerJoin(lanes, eq(laneAssignments.laneId, lanes.id))
        .where(and(inArray(laneAssignments.deploymentId, deploymentIds), eq(laneAssignments.excluded, false)))).map(row => row.slug);
    }
  } catch (error) {
    blocked = error instanceof PromotionBlocked ? error.message : "Cannot add this candidate to LiteLLM";
  }

  const counts = await db.select({ slug: lanes.slug, total: sql<number>`count(*)` }).from(laneAssignments)
    .innerJoin(lanes, eq(laneAssignments.laneId, lanes.id))
    .innerJoin(modelDeployments, eq(laneAssignments.deploymentId, modelDeployments.id))
    .where(liveLaneMember)
    .groupBy(lanes.slug);
  const countFor = (slug: string) => Number(counts.find(row => row.slug === slug)?.total ?? 0);

  const matches = classifyCandidateLanes(candidate).map(match => ({
    ...match,
    alreadyIn: members.includes(match.slug),
    full: countFor(match.slug) >= LANE_RULES[match.slug].maxDeployments,
  }));

  return NextResponse.json({ candidateId, displayName: candidate.displayName, blocked, directAliasName, members, matches, correlationId: id });
}
