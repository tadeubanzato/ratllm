import "server-only";
import { env } from "@/server/config";
import type { N8nWorkflow, WorkflowInstallResult } from "./types";
import { okameWorkflowDefinitions } from "./workflows";

export class N8nApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "N8nApiError"; }
}

export class N8nClient {
  constructor(private readonly baseUrl = env.N8N_BASE_URL, private readonly apiKey = env.N8N_API_KEY) {
    if (!baseUrl || !apiKey) throw new N8nApiError("N8N_BASE_URL and N8N_API_KEY must be configured");
  }
  private async request(path: string, init?: RequestInit) {
    const response = await fetch(`${this.baseUrl!.replace(/\/$/, "")}/api/v1${path}`, { ...init, headers: { accept: "application/json", "content-type": "application/json", "x-n8n-api-key": this.apiKey!, ...init?.headers }, signal: AbortSignal.timeout(30_000), cache: "no-store" });
    if (!response.ok) throw new N8nApiError(`n8n ${init?.method ?? "GET"} ${path} returned ${response.status}: ${(await response.text()).slice(0,200)}`, response.status);
    return response.status === 204 ? null : response.json();
  }
  async listWorkflows() {
    const results: N8nWorkflow[]=[]; let cursor: string | undefined;
    do { const suffix=cursor?`?limit=100&cursor=${encodeURIComponent(cursor)}`:"?limit=100"; const body=await this.request(`/workflows${suffix}`) as {data?:N8nWorkflow[];nextCursor?:string}; results.push(...(body.data??[])); cursor=body.nextCursor; } while(cursor);
    return results;
  }
  async upsertWorkflows(workflows: N8nWorkflow[], activate = true): Promise<WorkflowInstallResult[]> {
    const existing=new Map((await this.listWorkflows()).map(item=>[item.name,item])); const results:WorkflowInstallResult[]=[];
    for(const definition of workflows){const prior=existing.get(definition.name);const payload={name:definition.name,nodes:definition.nodes,connections:definition.connections,settings:definition.settings};const saved=await this.request(prior?.id?`/workflows/${prior.id}`:"/workflows",{method:prior?.id?"PUT":"POST",body:JSON.stringify(payload)}) as N8nWorkflow;const id=String(saved.id??prior?.id??"");if(!id)throw new N8nApiError(`n8n did not return an ID for ${definition.name}`);if(activate)await this.request(`/workflows/${id}/activate`,{method:"POST"});results.push({id,name:definition.name,action:prior?"updated":"created",active:activate});}
    return results;
  }
  async activateWorkflow(id:string){await this.request(`/workflows/${id}/activate`,{method:"POST"});}
  async status(){const workflows=await this.listWorkflows();const managedNames=new Set(okameWorkflowDefinitions.map(item=>item.name));return {connected:true,workflowCount:workflows.length,okameWorkflows:workflows.filter(item=>managedNames.has(item.name)).map(item=>({id:item.id,name:item.name,active:Boolean(item.active)}))};}
}
