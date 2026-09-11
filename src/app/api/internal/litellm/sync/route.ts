import { NextResponse } from "next/server";
import { env } from "@/server/config";
import { apiError, correlationId, secretMatches } from "@/server/http";
import { syncLiteLLM } from "@/server/litellm/sync";

export async function POST(request: Request) {
  const id = correlationId(request);
  const supplied = request.headers.get("x-ratllm-internal-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(supplied, env.INTERNAL_API_SECRET)) return apiError("UNAUTHORIZED", "Valid internal API secret required", 401, id);
  try { return NextResponse.json(await syncLiteLLM(), { headers: { "x-correlation-id": id } }); }
  catch (error) { return apiError("LITELLM_SYNC_FAILED", error instanceof Error ? error.message : "Inventory synchronization failed", 502, id); }
}
