import type { DashboardData, DeploymentRow, LaneSummary, ProviderRow, RunRow } from "./queries";

const now = Date.now();
export const demoProviders: ProviderRow[] = [
  { id: "demo-groq", slug: "groq", name: "Groq", status: "ACTIVE", adapterCapability: "AUTOMATED", modelCount: 3, healthyCount: 3, credentialConfigured: true, lastDiscoveryAt: new Date(now - 22 * 60_000) },
  { id: "demo-cerebras", slug: "cerebras", name: "Cerebras", status: "ACTIVE", adapterCapability: "AUTOMATED", modelCount: 2, healthyCount: 2, credentialConfigured: true, lastDiscoveryAt: new Date(now - 25 * 60_000) },
  { id: "demo-nvidia", slug: "nvidia", name: "NVIDIA NIM", status: "DEGRADED", adapterCapability: "PARTIAL", modelCount: 2, healthyCount: 1, credentialConfigured: false, lastDiscoveryAt: new Date(now - 4 * 3_600_000) },
  { id: "demo-local", slug: "local", name: "Local OpenAI", status: "ACTIVE", adapterCapability: "MANUAL", modelCount: 1, healthyCount: 1, credentialConfigured: true, lastDiscoveryAt: null },
];

export const demoDeployments: DeploymentRow[] = [
  ["d1","gpt-oss-120b","GPT-OSS 120B","groq/openai/gpt-oss-120b","smart-general","Groq",true,"HEALTHY",94.2,"FREE_TIER",30000,8,24000,6,"HIGH",new Date(now-120000)],
  ["d2","qwen3-coder","Qwen3 Coder","cerebras/qwen-3-coder","smart-coding","Cerebras",true,"HEALTHY",91.8,"FREE_TIER",131072,30,24000,21,"HIGH",new Date(now-250000)],
  ["d3","llama-4-scout","Llama 4 Scout","groq/meta-llama/llama-4-scout","smart-vision","Groq",true,"HEALTHY",89.4,"RECURRING_DAILY",131072,20,18000,14,"MEDIUM",new Date(now-620000)],
  ["d4","deepseek-r1","DeepSeek R1","nvidia/deepseek-ai/deepseek-r1","smart-deep","NVIDIA NIM",false,"DEGRADED",86.1,"FREE_TIER",128000,null,null,null,"LOW",new Date(now-3600000)],
  ["d5","local-llama","Llama 3.3 Local","ollama/llama3.3:70b","local-general","Local OpenAI",false,"HEALTHY",82.7,"PERMANENT_FREE",32768,null,null,null,"UNKNOWN",new Date(now-420000)],
  ["d6","mistral-small","Mistral Small","openrouter/mistralai/mistral-small:free","smart-summary","OpenRouter",true,"HEALTHY",88.3,"FREE_TIER",32768,20,12000,14,"MEDIUM",new Date(now-800000)],
].map(([id,slug,modelName,providerModelId,litellmModelName,providerName,managed,health,score,freeType,contextWindow,rpmLimit,tpmLimit,safeRpm,confidence,lastTestedAt]) => ({ id, slug, modelName, providerModelId, litellmModelName, providerName, managed, health, score, freeType, contextWindow, rpmLimit, tpmLimit, safeRpm, safeTpm: safeRpm ? Number(tpmLimit) * .7 : null, confidence, lastTestedAt } as DeploymentRow));

export const demoLanes: LaneSummary[] = ["smart-general","smart-coding","smart-agent","smart-deep","smart-long","smart-vision","smart-summary","smart-speech"].map((slug, index) => ({ id: slug, slug, name: slug.replace("smart-", "Smart ").replace(/^./, c => c.toUpperCase()), enabled: true, healthy: [3,2,2,2,2,1,2,0][index], total: [3,3,2,2,2,2,2,0][index], minimumHealthy: index === 7 ? 1 : 2, status: index === 7 ? "UNASSIGNED" : [5].includes(index) ? "DEGRADED" : "HEALTHY", confidence: index === 7 ? "UNKNOWN" : index > 4 ? "MEDIUM" : "HIGH" }));

export const demoRuns: RunRow[] = [
  { id: "r1", type: "LITELLM_SYNC", status: "SUCCEEDED", createdAt: new Date(now-18*60_000), durationMs: 1840, summary: { deployments: 8, managed: 5, unmanaged: 3 } },
  { id: "r2", type: "SMOKE_TEST", status: "SUCCEEDED", createdAt: new Date(now-43*60_000), durationMs: 2180, summary: { passed: 7, failed: 0 } },
  { id: "r3", type: "DISCOVERY", status: "SUCCEEDED", createdAt: new Date(now-4*3_600_000), durationMs: 42130, summary: { providers: 4, discovered: 8 } },
];

export const demoDashboard: DashboardData = {
  demo: true, systems: { curator: "HEALTHY", database: "HEALTHY", litellm: "HEALTHY" },
  kpis: { providers: 4, models: 8, active: 6, healthy: 7, quarantined: 1, coverage: 88, errors429: 3, pendingChanges: 2 },
  lanes: demoLanes, providers: demoProviders, runs: demoRuns,
  incidents: [{ severity: "WARNING", title: "smart-speech has no eligible deployment", detail: "Lane is below its redundancy target", at: new Date(now-12*60_000) }, { severity: "INFO", title: "NVIDIA NIM latency elevated", detail: "p95 is 18% above the 7-day baseline", at: new Date(now-62*60_000) }],
};
