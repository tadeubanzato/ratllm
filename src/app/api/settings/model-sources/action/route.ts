import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelSources } from "@/server/db/schema";
import { apiError, correlationId } from "@/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  const {sourceId, action} = await request.json().catch(() => ({}));
  const source = (await getDb().select().from(modelSources).where(eq(modelSources.id, sourceId)).limit(1))[0];
  if (!source) return apiError("SOURCE_NOT_FOUND", "Model source not found", 404, id);
  try {
    let count = source.discoveredModelCount;
    if (action === "sync" && source.url) {
      const response = await fetch(source.url, {signal: AbortSignal.timeout(10_000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      count = Array.isArray(body) ? body.length : Array.isArray(body.data) ? body.data.length : count;
    }
    await getDb().update(modelSources).set({status: count > 0 ? "HEALTHY" : "DEGRADED", lastSyncAt: new Date(), discoveredModelCount: count, updatedAt: new Date()}).where(eq(modelSources.id, source.id));
    return NextResponse.json({ok: true, count, correlationId: id});
  } catch (error) {
    await getDb().update(modelSources).set({status: "FAILED", updatedAt: new Date()}).where(eq(modelSources.id, source.id));
    return apiError("SOURCE_CONNECTION_FAILED", error instanceof Error ? error.message : "Connection failed", 502, id);
  }
}
