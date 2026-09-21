import { NextResponse } from "next/server";
import { z } from "zod";
import { LANE_IDS } from "@/lib/constants";
import { apiError, correlationId } from "@/server/http";
import { promoteCandidate, PromotionBlocked } from "@/server/lanes/promote";

const input = z.object({
  lanes: z.array(z.enum(LANE_IDS)).optional(),
  directAlias: z.boolean().optional(),
  allowNonChat: z.boolean().optional(),
}).nullable();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = correlationId(request);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_PROMOTE_REQUEST", "lanes must be known smart-* slugs", 400, id);
  try {
    const result = await promoteCandidate((await params).id, { lanes: parsed.data?.lanes, directAlias: parsed.data?.directAlias, allowNonChat: parsed.data?.allowNonChat });
    return NextResponse.json({ ...result, correlationId: id }, { status: result.ok ? 200 : 207 });
  } catch (error) {
    const blocked = error instanceof PromotionBlocked;
    return apiError(blocked ? "CANDIDATE_PROMOTE_BLOCKED" : "CANDIDATE_PROMOTE_FAILED", error instanceof Error ? error.message : "Adding this model to LiteLLM failed", blocked ? 422 : 502, id);
  }
}
