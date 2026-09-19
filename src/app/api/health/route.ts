import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { readWorkerHealth } from "@/server/worker-heartbeat";

/** Liveness plus worker/scheduler state. Always HTTP 200 while the web process can answer: the container healthcheck
 *  points here, and a stopped worker must surface as `degraded` in the body, not restart-loop the web container. */
export async function GET() {
  const timestamp = new Date().toISOString();
  if (env.DEMO_MODE) return NextResponse.json({ status: "healthy", checks: { app: { status: "healthy" } }, timestamp });
  try {
    const worker = await readWorkerHealth();
    const workerOk = worker.status === "alive" && worker.overdueJobs === 0;
    return NextResponse.json({
      status: workerOk ? "healthy" : "degraded",
      checks: { app: { status: "healthy" }, worker: { status: workerOk ? "healthy" : worker.status === "alive" ? "lagging" : worker.status, heartbeatAgeMs: worker.ageMs, overdueJobs: worker.overdueJobs } },
      timestamp,
    });
  } catch {
    return NextResponse.json({ status: "degraded", checks: { app: { status: "healthy" }, worker: { status: "unknown" } }, timestamp });
  }
}
