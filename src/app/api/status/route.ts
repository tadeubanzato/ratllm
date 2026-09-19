import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { getOperationalStatus } from "@/server/operational-status";

/** Is RatLLM actually doing its job? (`/api/health` only says the process is alive.) Always HTTP 200 while the web process can
 *  answer, so monitors can poll it; the body's `status` and `reasons` carry the verdict. */
export async function GET() {
  if (env.DEMO_MODE) return NextResponse.json({ status: "healthy", reasons: [], demo: true, timestamp: new Date().toISOString() });
  try {
    const { status, reasons, facts, environment } = await getOperationalStatus();
    return NextResponse.json({ status, reasons, environment, facts: { ...facts, now: undefined }, timestamp: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "degraded", reasons: [{ severity: "degraded", area: "worker", message: "Status could not be computed — the database may be unreachable." }], timestamp: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  }
}
