import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, correlationId } from "@/server/http";
import { listProviderSettings, ProviderNotFoundError, setProviderEnabled } from "@/server/providers/registry";

export async function GET() {
  return NextResponse.json(await listProviderSettings(), {headers: {"Cache-Control": "no-store"}});
}

export async function PATCH(request: Request) {
  const id = correlationId(request);
  const parsed = z.object({id: z.string().uuid(), enabled: z.boolean()}).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_PROVIDER_SETTING", "Provider ID and enabled state are required", 400, id);
  try {
    return NextResponse.json(await setProviderEnabled(parsed.data.id, parsed.data.enabled));
  } catch (error) {
    if (error instanceof ProviderNotFoundError) return apiError("PROVIDER_NOT_FOUND", "Provider not found", 404, id);
    throw error;
  }
}
