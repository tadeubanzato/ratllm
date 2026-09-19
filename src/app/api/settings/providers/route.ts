import { NextResponse } from "next/server";
import { OutboundPolicyError, assertSafeOutboundUrl } from "@/server/net/outbound-policy";
import { z } from "zod";
import { apiError, correlationId } from "@/server/http";
import { createCustomProvider, DuplicateProviderError, listProviderSettings, ProviderNotFoundError, setProviderBaseUrl, setProviderEnabled } from "@/server/providers/registry";

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
  if (parsed.data.baseUrl) {
    try { await assertSafeOutboundUrl(parsed.data.baseUrl, {allowPrivate: true}); }
    catch (error) { if (error instanceof OutboundPolicyError) return apiError("URL_NOT_ALLOWED", error.message, 400, id); throw error; }
  }
  try {
    const provider = await createCustomProvider({name: parsed.data.name, baseUrl: parsed.data.baseUrl || undefined, apiKey: parsed.data.apiKey || undefined}, id);
    return NextResponse.json({id: provider.id, slug: provider.slug, name: provider.name});
  } catch (error) {
    if (error instanceof DuplicateProviderError) return apiError("INVALID_PROVIDER", error.message, 400, id);
    return apiError("PROVIDER_CREATE_FAILED", error instanceof Error ? error.message : "Unable to create provider", 503, id);
  }
}

const patchInput = z.object({
  id: z.string().uuid(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().optional().or(z.literal("")),
}).refine(value => value.enabled !== undefined || value.baseUrl !== undefined, "Provide enabled and/or baseUrl");

export async function PATCH(request: Request) {
  const id = correlationId(request);
  const parsed = patchInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_PROVIDER_SETTING", "Provider ID and at least one of enabled/baseUrl are required", 400, id);
  if (parsed.data.baseUrl) {
    try { await assertSafeOutboundUrl(parsed.data.baseUrl, {allowPrivate: true}); }
    catch (error) { if (error instanceof OutboundPolicyError) return apiError("URL_NOT_ALLOWED", error.message, 400, id); throw error; }
  }
  try {
    let result: unknown = null;
    if (parsed.data.enabled !== undefined) result = await setProviderEnabled(parsed.data.id, parsed.data.enabled);
    if (parsed.data.baseUrl !== undefined) result = await setProviderBaseUrl(parsed.data.id, parsed.data.baseUrl || null);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProviderNotFoundError) return apiError("PROVIDER_NOT_FOUND", "Provider not found", 404, id);
    throw error;
  }
}
