import { NextResponse } from "next/server";
import { z } from "zod";
import { getLiteLLMManagementSettings, setLiteLLMManagementSettings } from "@/server/settings/litellm-management";

const input = z.object({ autoAdd: z.boolean().optional(), autoRemove: z.boolean().optional() });

export async function GET() {
  try { return NextResponse.json(await getLiteLLMManagementSettings(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: { message: "Unable to load LiteLLM management settings. Check database connectivity." } }, { status: 503 }); }
}

export async function PATCH(request: Request) {
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { message: "Provide autoAdd and/or autoRemove as booleans." } }, { status: 400 });
  try { return NextResponse.json(await setLiteLLMManagementSettings(parsed.data)); }
  catch { return NextResponse.json({ error: { message: "Unable to save. Check database connectivity." } }, { status: 503 }); }
}
