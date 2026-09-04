import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { apiError,correlationId } from "@/server/http";
import { runDiscovery } from "@/server/discovery/run";

export async function POST(request:Request){const id=correlationId(request);const supplied=request.headers.get("x-internal-api-secret")??request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");if(!env.INTERNAL_API_SECRET||supplied!==env.INTERNAL_API_SECRET)return apiError("UNAUTHORIZED","Valid internal API secret required",401,id);try{return NextResponse.json(await runDiscovery())}catch(error){return apiError("DISCOVERY_FAILED",error instanceof Error?error.message:"Discovery failed",502,id)}}
