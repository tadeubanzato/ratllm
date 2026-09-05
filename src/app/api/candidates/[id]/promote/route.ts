import { NextResponse } from "next/server";
import { apiError,correlationId } from "@/server/http";
import { promoteCandidateToLiteLLM } from "@/server/discovery/promote";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){const id=correlationId(request);try{return NextResponse.json({...await promoteCandidateToLiteLLM((await params).id),correlationId:id})}catch(error){return apiError("CANDIDATE_PROMOTE_FAILED",error instanceof Error?error.message:"Adding this model to LiteLLM failed",422,id)}}
