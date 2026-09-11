import { PageShell } from "@/components/page-shell";
import { getLanes, getRunHistoryByType, getSmokeTests } from "@/server/queries";
import { JOB_TYPES } from "@/server/automation/service";
import { env } from "@/server/config";
import { formatSummary } from "@/lib/utils";
import { SettingsClient } from "./settings-client";
export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const [lanes, historyByType, smoke] = await Promise.all([getLanes(), getRunHistoryByType(JOB_TYPES, 20), getSmokeTests(14)]);
  const initialHistory = Object.values(historyByType).flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(run => ({at: run.createdAt.toISOString(), status: run.status, label: run.type, detail: formatSummary(run.summary), href: `/runs/${run.id}`}));
  return <PageShell title="Settings" eyebrow="Control plane configuration" showSearch={false}>
    <SettingsClient
      environment={env.DEMO_MODE ? "Demo" : process.env.NODE_ENV === "production" ? "Production" : "Development"}
      lanes={lanes.map(({slug,minimumHealthy}) => ({slug,minimumHealthy}))}
      initialHistory={initialHistory}
      smokeHistory={smoke.map(test => ({at:test.createdAt.toISOString(),status:test.httpStatus===429?"RATE_LIMITED":test.errorCode??test.status,label:test.status,detail:`${test.latencyMs??"—"}ms · HTTP ${test.httpStatus??"—"}${test.error?` · ${test.error}`:""}${test.runId?` · run ${test.runId.slice(0,8)}`:""}`,href:test.runId?`/runs/${test.runId}`:undefined}))}
    />
  </PageShell>;
}
