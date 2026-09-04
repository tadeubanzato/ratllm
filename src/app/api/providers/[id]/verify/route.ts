import { NextResponse } from "next/server";
import { apiError,correlationId } from "@/server/http";
import { verifyProvider } from "@/server/providers/verify";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){const correlation=correlationId(request);const{id}=await params;try{const result=await verifyProvider(id);return NextResponse.json({...result,correlationId:correlation},{status:result.ok?200:result.supported?502:422})}catch(error){const message=error instanceof Error?error.message:"Verification failed";return apiError("PROVIDER_VERIFICATION_FAILED",message,message==="Provider not found"?404:400,correlation)}}
