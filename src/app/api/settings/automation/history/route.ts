import { NextResponse } from "next/server";
import { formatSummary } from "@/lib/utils";
import { getRunHistoryByType } from "@/server/queries";
import { JOB_TYPES } from "@/server/automation/service";

export const dynamic = "force-dynamic";

/** Per-job run history for the settings page — the last N runs of each job type, so a frequent job never hides a rare one. */
export async function GET() {
  const byType = await getRunHistoryByType(JOB_TYPES, 20);
  const items = Object.values(byType).flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(run => ({ at: run.createdAt.toISOString(), status: run.status, label: run.type, detail: formatSummary(run.summary), href: `/runs/${run.id}` }));
  return NextResponse.json(items);
}
