import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { automationJobs, syncRuns } from "@/server/db/schema";
import { defaultScheduleFor, ensureAutomationJobs, JOB_TYPES, nextCron, type AutomationType } from "@/server/automation/service";
import { apiError, correlationId } from "@/server/http";

const input = z.object({
  enabled: z.boolean().optional(),
  schedule: z.string().min(9).max(100).optional(),
  timezone: z.string().min(1).max(100).optional(),
  resetSchedule: z.boolean().optional(),
});

const knownType = (type: string): type is AutomationType => (JOB_TYPES as readonly string[]).includes(type);

export async function GET() {
  await ensureAutomationJobs();
  const db = getDb();
  const rows = await db.select().from(automationJobs).orderBy(automationJobs.type);
  // The most recent run of each job type, so a caller that queued a run can show its result once it finishes.
  const latest = await db.selectDistinctOn([syncRuns.type], { type: syncRuns.type, status: syncRuns.status, summary: syncRuns.summary, error: syncRuns.error, finishedAt: syncRuns.finishedAt })
    .from(syncRuns).where(inArray(syncRuns.type, rows.map(row => row.type))).orderBy(syncRuns.type, desc(syncRuns.createdAt));
  const byType = new Map(latest.map(run => [run.type, run]));
  return NextResponse.json(rows.map(row => ({ ...row, defaultSchedule: knownType(row.type) ? defaultScheduleFor(row.type) : null, lastRun: byType.get(row.type) ?? null })));
}

export async function PATCH(request: Request) {
  const id = correlationId(request);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_AUTOMATION_JOB", "Invalid schedule or configuration", 400, id);
  const type = new URL(request.url).searchParams.get("type");
  if (!type) return apiError("INVALID_AUTOMATION_JOB", "Job type is required", 400, id);

  try {
    const zone = (await getDb().select({ timezone: automationJobs.timezone }).from(automationJobs).where(eq(automationJobs.type, type)).limit(1))[0]?.timezone ?? "UTC";
    let patch: Record<string, unknown>;
    if (parsed.data.resetSchedule) {
      if (!knownType(type)) return apiError("INVALID_AUTOMATION_JOB", "Unknown job type", 400, id);
      const schedule = defaultScheduleFor(type);
      patch = { schedule, customSchedule: false, nextRunAt: nextCron(schedule, new Date(), zone), updatedAt: new Date() };
    } else {
      patch = {
        ...parsed.data,
        ...(parsed.data.schedule ? { customSchedule: true, nextRunAt: nextCron(parsed.data.schedule, new Date(), zone) } : {}),
        updatedAt: new Date(),
      };
      delete (patch as { resetSchedule?: unknown }).resetSchedule;
    }
    const [row] = await getDb().update(automationJobs).set(patch).where(eq(automationJobs.type, type)).returning();
    if (!row) return apiError("NOT_FOUND", "Automation job not found", 404, id);
    return NextResponse.json({ ...row, defaultSchedule: knownType(row.type) ? defaultScheduleFor(row.type) : null });
  } catch (error) {
    return apiError("INVALID_CRON", error instanceof Error ? error.message : "Invalid cron", 400, id);
  }
}
