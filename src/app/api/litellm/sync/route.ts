import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { apiError, correlationId } from "@/server/http";
import { syncLiteLLM } from "@/server/litellm/sync";
export async function POST(request:Request){const id=correlationId(request);if(env.DEMO_MODE)return NextResponse.json({demo:true,deployments:6,managed:4,unmanaged:2,correlationId:id});try{return NextResponse.json(await syncLiteLLM(),{headers:{"x-correlation-id":id}})}catch(error){return apiError("LITELLM_SYNC_FAILED",error instanceof Error?error.message:"Inventory synchronization failed",502,id)}}
