import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { apiError, correlationId } from "@/server/http";
import { N8nClient } from "@/server/n8n/client";
import { buildOkameWorkflows } from "@/server/n8n/workflows";
export async function POST(request:Request){const id=correlationId(request);if(!env.N8N_API_KEY)return apiError("N8N_API_KEY_MISSING","Add N8N_API_KEY to .env and recreate the web container",409,id);try{const client=new N8nClient();const workflows=await client.upsertWorkflows(buildOkameWorkflows(),false);const daily=workflows.find(item=>item.name.startsWith("01 ·"));if(daily?.id)await client.activateWorkflow(daily.id);return NextResponse.json({installed:workflows.length,activated:daily?.id?1:0,workflows:workflows.map(item=>({...item,active:item.id===daily?.id})),notice:"Daily discovery and due-candidate verification activated. Other workflows remain inactive until their endpoints are enabled.",correlationId:id})}catch(error){return apiError("N8N_INSTALL_FAILED",error instanceof Error?error.message:"Workflow installation failed",502,id)}}
