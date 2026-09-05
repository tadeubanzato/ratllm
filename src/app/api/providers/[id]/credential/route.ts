import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, correlationId } from "@/server/http";
import { CredentialNotFoundError, deleteProviderCredential, EnvironmentCredentialMissingError, ProviderNotFoundError, saveProviderCredential, setProviderCredentialDisabled } from "@/server/providers/credentials";

const input = z.object({apiKey: z.string().min(8).max(10000).optional(), environmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/)});

export async function PUT(request: Request, {params}: {params: Promise<{id: string}>}) {
  const correlation = correlationId(request);
  const {id} = await params;
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_CREDENTIAL", "Provide an API key and uppercase environment variable name", 400, correlation);
  try {
    const result = await saveProviderCredential(id, parsed.data, correlation);
    return NextResponse.json({...result, correlationId: correlation});
  } catch (error) {
    if (error instanceof ProviderNotFoundError) return apiError("PROVIDER_NOT_FOUND", "Provider not found", 404, correlation);
    if (error instanceof EnvironmentCredentialMissingError) return apiError("ENVIRONMENT_CREDENTIAL_MISSING", error.message, 400, correlation);
    return apiError("CREDENTIAL_ENCRYPTION_UNAVAILABLE", "Unable to save securely. Check the server encryption key and database connection", 503, correlation);
  }
}

export async function PATCH(request: Request, {params}: {params: Promise<{id: string}>}) {
  const correlation = correlationId(request);
  const {id} = await params;
  const {environmentVariable, disabled} = await request.json().catch(() => ({}));
  if (typeof environmentVariable !== "string" || typeof disabled !== "boolean") return apiError("INVALID_CREDENTIAL", "Credential reference and disabled state required", 400, correlation);
  try {
    const row = await setProviderCredentialDisabled(id, environmentVariable, disabled);
    return NextResponse.json(row);
  } catch (error) {
    if (error instanceof CredentialNotFoundError) return apiError("CREDENTIAL_NOT_FOUND", "Credential not found", 404, correlation);
    throw error;
  }
}

export async function DELETE(request: Request, {params}: {params: Promise<{id: string}>}) {
  const correlation = correlationId(request);
  const {id} = await params;
  const environmentVariable = new URL(request.url).searchParams.get("environmentVariable");
  if (!environmentVariable) return apiError("INVALID_CREDENTIAL", "Credential reference required", 400, correlation);
  await deleteProviderCredential(id, environmentVariable);
  return new NextResponse(null, {status: 204});
}
