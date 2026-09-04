import type { N8nWorkflow } from "./types";
import { env } from "@/server/config";

const schedules = [
  ["01 · Okame daily curation", "0 4 * * *", "/api/internal/candidates/verify-due"],
  ["02 · Okame health monitor", "*/10 * * * *", "/api/internal/smoke-tests/run"],
  ["03 · Okame rate-limit learning", "15 */6 * * *", "/api/internal/probes/run"],
  ["04 · Okame deploy approved plans", "*/5 * * * *", "/api/internal/change-plans/apply-approved"],
  ["05 · Okame weekly deep benchmark", "0 3 * * 0", "/api/internal/benchmarks/run"],
  ["06 · Okame cleanup maintenance", "30 2 * * *", "/api/internal/maintenance/run"],
] as const;

function workflow(name: string, expression: string, path: string, curatorUrl: string, secret: string): N8nWorkflow {
  const trigger = "Schedule"; const request = "Call Okame";
  return {
    name,
    nodes: [
      { id: `${name.slice(0,2)}-schedule`, name: trigger, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0,0], parameters: { rule: { interval: [{ field: "cronExpression", expression }] } } },
      { id: `${name.slice(0,2)}-request`, name: request, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [260,0], parameters: { method: "POST", url: `${curatorUrl}${path}`, sendHeaders: true, headerParameters: { parameters: [{ name: "x-okame-internal-secret", value: secret }] }, options: { timeout: 300000 } } },
    ],
    connections: { [trigger]: { main: [[{ node: request, type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1", saveManualExecutions: true, timezone: "America/Los_Angeles" },
  };
}

export function buildOkameWorkflows() {
  if (!env.CURATOR_PUBLIC_URL || !env.INTERNAL_API_SECRET) throw new Error("CURATOR_PUBLIC_URL and INTERNAL_API_SECRET must be configured");
  return schedules.map(([name, expression, path]) => workflow(name, expression, path, env.CURATOR_PUBLIC_URL!, env.INTERNAL_API_SECRET!));
}
