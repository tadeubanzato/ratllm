import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { apiError,correlationId,secretMatches } from "@/server/http";
import { verifyDueCandidates } from "@/server/discovery/verify-due";
import { runDiscovery } from "@/server/discovery/run";
export async function POST(request:Request){const id=correlationId(request);const supplied=request.headers.get("x-internal-api-secret")??request.headers.get("x-ratllm-internal-secret")??request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");if(!secretMatches(supplied??null,env.INTERNAL_API_SECRET))return apiError("UNAUTHORIZED","Valid internal API secret required",401,id);try{const discovery=await runDiscovery();return NextResponse.json({discovery,verification:await verifyDueCandidates(),correlationId:id})}catch(error){return apiError("CANDIDATE_VERIFICATION_FAILED",error instanceof Error?error.message:"Candidate verification failed",502,id)}}
