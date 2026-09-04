import { NextResponse } from "next/server";
import { apiError,correlationId } from "@/server/http";
import { runDiscovery } from "@/server/discovery/run";
export async function POST(request:Request){const id=correlationId(request);try{return NextResponse.json(await runDiscovery())}catch(error){return apiError("DISCOVERY_FAILED",error instanceof Error?error.message:"Discovery failed",502,id)}}
