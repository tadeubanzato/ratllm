import { NextResponse } from "next/server";
import { apiError, correlationId } from "@/server/http";
import { verifyCandidateNow } from "@/server/discovery/verify-due";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = correlationId(request);
  try { return NextResponse.json({ ...(await verifyCandidateNow((await params).id)), correlationId: id }); }
  catch (error) { return apiError("CANDIDATE_TEST_FAILED", error instanceof Error ? error.message : "Candidate test failed", 502, id); }
}
