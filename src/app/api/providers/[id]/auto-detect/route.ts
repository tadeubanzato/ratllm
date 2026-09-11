import { NextResponse } from "next/server";
import { apiError, correlationId } from "@/server/http";
import { autoDetectCompletionsEndpoint } from "@/server/providers/autodetect";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = correlationId(request);
  try { return NextResponse.json({ ...(await autoDetectCompletionsEndpoint((await params).id)), correlationId: id }); }
  catch (error) { return apiError("AUTO_DETECT_FAILED", error instanceof Error ? error.message : "Auto-detect failed", 502, id); }
}
