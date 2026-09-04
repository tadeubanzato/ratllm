import { NextResponse } from "next/server";
import { apiError,correlationId } from "@/server/http";
import { connectCandidate } from "@/server/discovery/connect";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){const id=correlationId(request);try{return NextResponse.json({...await connectCandidate((await params).id),correlationId:id})}catch(error){return apiError("CANDIDATE_CONNECT_FAILED",error instanceof Error?error.message:"Candidate connection failed",422,id)}}
