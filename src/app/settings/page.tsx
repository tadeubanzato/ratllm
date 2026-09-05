import { PageShell } from "@/components/page-shell";
import { getLanes, getRuns, getSmokeTests } from "@/server/queries";
import { env } from "@/server/config";
import { SettingsClient } from "./settings-client";
export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const [lanes, runs, smoke] = await Promise.all([getLanes(), getRuns(), getSmokeTests(14)]);
  return <PageShell title="Settings" eyebrow="Control plane configuration">
    <SettingsClient
      environment={env.DEMO_MODE ? "Demo" : process.env.NODE_ENV === "production" ? "Production" : "Development"}
      lanes={lanes.map(({slug,minimumHealthy}) => ({slug,minimumHealthy}))}
      initialHistory={runs.map(run => ({at:run.createdAt.toISOString(),status:run.status,label:run.type,detail:Object.entries(run.summary).map(([key,value])=>`${key}: ${String(value)}`).join(" · "),href:`/runs/${run.id}`}))}
      smokeHistory={smoke.map(test => ({at:test.createdAt.toISOString(),status:test.httpStatus===429?"RATE_LIMITED":test.errorCode??test.status,label:test.status,detail:`${test.latencyMs??"—"}ms · HTTP ${test.httpStatus??"—"}${test.error?` · ${test.error}`:""}${test.runId?` · run ${test.runId.slice(0,8)}`:""}`,href:test.runId?`/runs/${test.runId}`:undefined}))}
    />
  </PageShell>;
}
