import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { apiError, correlationId } from "@/server/http";
import { N8nClient } from "@/server/n8n/client";
export async function GET(request:Request){const id=correlationId(request);if(!env.N8N_BASE_URL||!env.N8N_API_KEY)return NextResponse.json({connected:false,configuredUrl:Boolean(env.N8N_BASE_URL),configuredApiKey:Boolean(env.N8N_API_KEY),correlationId:id});try{return NextResponse.json({...await new N8nClient().status(),configuredUrl:true,configuredApiKey:true,correlationId:id})}catch(error){return apiError("N8N_CONNECTION_FAILED",error instanceof Error?error.message:"Unable to connect to n8n",502,id)}}
