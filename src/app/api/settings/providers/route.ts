import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, correlationId } from "@/server/http";
import { createCustomProvider, DuplicateProviderError, listProviderSettings, ProviderNotFoundError, setProviderEnabled } from "@/server/providers/registry";

export async function GET() {
  return NextResponse.json(await listProviderSettings(), {headers: {"Cache-Control": "no-store"}});
}

const createInput = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().optional().or(z.literal("")),
  apiKey: z.string().min(8).max(10000).optional().or(z.literal("")),
});

export async function POST(request: Request) {
  const id = correlationId(request);
  const parsed = createInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_PROVIDER", "Provide a provider name; base URL and API key are optional", 400, id);
  try {
    const provider = await createCustomProvider({name: parsed.data.name, baseUrl: parsed.data.baseUrl || undefined, apiKey: parsed.data.apiKey || undefined}, id);
    return NextResponse.json({id: provider.id, slug: provider.slug, name: provider.name});
  } catch (error) {
    if (error instanceof DuplicateProviderError) return apiError("INVALID_PROVIDER", error.message, 400, id);
    return apiError("PROVIDER_CREATE_FAILED", error instanceof Error ? error.message : "Unable to create provider", 503, id);
  }
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
