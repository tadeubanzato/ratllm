import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { env } from "@/server/config";
import { getDb } from "@/server/db/client";
import {
  auditEvents,
  modelDeployments,
  smokeTests,
  syncRuns,
} from "@/server/db/schema";
import { apiError, correlationId, secretMatches } from "@/server/http";
import { healthFromSmokeResult } from "@/server/status";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";

// Ten checks per scheduled tick covers the full inventory in a rolling 24-hour
// window while keeping each n8n execution bounded.
const DAILY_BATCH_SIZE = 10;

export async function POST(request: Request) {
  const id = correlationId(request);

  const supplied =
    request.headers.get("x-okame-internal-secret") ??
    request.headers.get("x-internal-api-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!secretMatches(supplied ?? null, env.INTERNAL_API_SECRET)) {
    return apiError(
      "UNAUTHORIZED",
      "Valid internal API secret required",
      401,
      id,
    );
  }

  try {
    const db = getDb();

    const deployments = await db
      .select()
      .from(modelDeployments)
      .where(sql`${modelDeployments.litellmDeploymentId} is not null and (${modelDeployments.lastTestedAt} is null or ${modelDeployments.lastTestedAt} < now() - interval '24 hours')`)
      .orderBy(sql`${modelDeployments.lastTestedAt} asc nulls first`).limit(DAILY_BATCH_SIZE);

    const [run] = await db
      .insert(syncRuns)
      .values({
        type: "LITELLM_DAILY_EVALUATION",
        status: "RUNNING",
        correlationId: id,
        startedAt: new Date(),
      })
      .returning();

    const adapter = new HttpLiteLLMAdapter();

    let passed = 0;
    let failed = 0;

    const results = [];

    for (const deployment of deployments) {
      const model = deployment.litellmModelName;

      if (!model) continue;

      try {
        const result = await adapter.smokeTest(model);

        if (result.ok) passed++;
        else failed++;

        await db.insert(smokeTests).values({
          runId: run.id,
          deploymentId: deployment.id,
          lane: model,
          status: result.ok ? "PASSED" : "FAILED",
          latencyMs: result.latencyMs,
          httpStatus: result.status,
          errorCode: result.status ? `HTTP_${result.status}` : "CONNECTION_ERROR",
          error: result.error,
          responseExcerpt: result.content,
          correlationId: id,
        });

        await db
          .update(modelDeployments)
          .set({
            health: healthFromSmokeResult(result.ok, result.status),
            lastTestedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(modelDeployments.id, deployment.id));

        results.push({
          deploymentId: deployment.id,
          model,
          ok: result.ok,
          status: result.status,
          latencyMs: result.latencyMs,
          error: result.error,
        });
      } catch (error) {
        failed++;

        const message =
          error instanceof Error ? error.message : "Smoke test failed";

        await db
          .update(modelDeployments)
          .set({
            health: "UNAVAILABLE",
            lastTestedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(modelDeployments.id, deployment.id));

        results.push({
          deploymentId: deployment.id,
          model,
          ok: false,
          status: 500,
          error: message,
        });
      }
    }

    await db
      .update(syncRuns)
      .set({
        status: failed === 0 ? "SUCCEEDED" : "FAILED",
        finishedAt: new Date(),
        summary: {
          processed: results.length,
          batchSize: DAILY_BATCH_SIZE,
          passed,
          failed,
        },
        updatedAt: new Date(),
      })
      .where(eq(syncRuns.id, run.id));

    await db.insert(auditEvents).values({
      actor: "n8n",
      action: "litellm.batch_smoke_tested",
      entityType: "system",
      entityId: run.id,
      after: {
        processed: results.length,
        passed,
        failed,
      },
      correlationId: id,
    });

    return NextResponse.json({
      ok: failed === 0,
      processed: results.length,
      passed,
      failed,
      results,
      correlationId: id,
    });
  } catch (error) {
    return apiError(
      "SMOKE_TEST_RUN_FAILED",
      error instanceof Error ? error.message : "Smoke test run failed",
      502,
      id,
    );
  }
}
