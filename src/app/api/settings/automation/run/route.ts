import { NextResponse } from "next/server";
import { z } from "zod";
import { JOB_TYPES, requestRun } from "@/server/automation/service";
import { apiError, correlationId } from "@/server/http";
import { readWorkerHealth } from "@/server/worker-heartbeat";

const input = z.object({ type: z.enum(JOB_TYPES), scope: z.enum(["due", "connected"]).optional() });

/**
 * "Run now": records the request and returns immediately (202). The worker starts the job on its next tick, under the same lease
 * and reporting as a scheduled run — it no longer runs inside this web request, where a job that takes minutes held the
 * connection open, could be abandoned by a dropped browser, and ran in the wrong process. Poll GET /api/settings/automation for
 * progress (`runRequestedAt` clears when it starts; `status` becomes RUNNING, then SUCCEEDED or FAILED).
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_JOB", "Unknown automation job", 400, id);
  const worker = await readWorkerHealth().catch(() => null);
  const result = await requestRun(parsed.data.type, parsed.data.scope ? { candidateScope: parsed.data.scope } : undefined);
  return NextResponse.json({ ...result, workerAlive: worker?.status === "alive", correlationId: id }, { status: 202 });
}
