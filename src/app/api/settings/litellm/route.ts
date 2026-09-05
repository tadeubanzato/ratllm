import { NextResponse } from "next/server";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { connectionInput, connectionSummary, saveConnection, recordConnection, connectionError } from "@/server/settings/connections";
export async function GET() {
  try { return NextResponse.json(await connectionSummary("litellm"), {headers: {"Cache-Control": "no-store"}}); }
  catch { return NextResponse.json({error: {message: "Unable to load connection settings. Check database connectivity."}}, {status: 503}); }
}
export async function PUT(request: Request) {
  const parsed = connectionInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({error: {message: "Provide an HTTP(S) base URL without embedded credentials and an optional credential of at least 8 characters."}}, {status: 400});
  try { await saveConnection("litellm", parsed.data); return NextResponse.json({saved: true}); }
  catch { return NextResponse.json({error: {message: "Unable to save securely. Check database connectivity and CREDENTIAL_ENCRYPTION_KEY on the server."}}, {status: 503}); }
}
export async function POST() {
  try { const client = new HttpLiteLLMAdapter(); const deployments = await client.listDeployments(); const version = await client.getVersion(); const result = {ok: true, deploymentCount: deployments.length, version}; await recordConnection("litellm", result); return NextResponse.json(result); }
  catch (error) { const message = connectionError(error); await recordConnection("litellm", {ok: false, error: message}).catch(() => undefined); return NextResponse.json({error: {message: "litellm connection failed. " + message}}, {status: 502}); }
}
