import { NextResponse } from "next/server";
import { apiError, correlationId } from "@/server/http";
import { detectCloudflareAccount } from "@/server/providers/autodetect";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = correlationId(request);
  try { return NextResponse.json({ ...(await detectCloudflareAccount((await params).id)), correlationId: id }); }
  catch (error) { return apiError("CLOUDFLARE_ACCOUNT_LOOKUP_FAILED", error instanceof Error ? error.message : "Lookup failed", 502, id); }
}
