import type { N8nWorkflow, OkameWorkflowDefinition } from "./types";
/** n8n is optional and only receives RATLLM events. It never schedules RATLLM. */
export const okameWorkflowDefinitions: readonly OkameWorkflowDefinition[]=[{name:"RATLLM Notification Workflow",schedule:"manual",endpoint:"/webhook/ratllm-events",description:"Receives RATLLM event payloads for notifications."}] as const;
export function buildOkameWorkflows(): N8nWorkflow[]{return [{name:"RATLLM Notification Workflow",nodes:[{id:"ratllm-webhook",name:"RATLLM events",type:"n8n-nodes-base.webhook",typeVersion:2,position:[0,0],parameters:{httpMethod:"POST",path:"ratllm-events",responseMode:"onReceived"}}],connections:{},settings:{executionOrder:"v1",saveManualExecutions:true,timezone:"UTC"}}];}
