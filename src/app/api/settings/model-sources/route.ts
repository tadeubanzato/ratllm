import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { modelSources } from "@/server/db/schema";
import { apiError, correlationId } from "@/server/http";
import { ensureModelSources } from "@/server/discovery/model-sources";
import { getSourceYield } from "@/server/queries";
import { sourceRegistry } from "@/server/discovery/registry";

const input = z.object({id: z.string().uuid().optional(), name: z.string().min(1).max(120), type: z.enum(["PROVIDER_API", "OPENAI_COMPATIBLE", "JSON_FEED", "MANUAL", "CUSTOM_ADAPTER"]), providerId: z.string().uuid().nullable().optional(), url: z.string().url().nullable().optional(), enabled: z.boolean().default(true), priority: z.number().int().min(0).max(10000).default(100), credentialReference: z.string().max(120).nullable().optional(), adapterReference: z.string().max(200).nullable().optional()});

const tierByAdapterReference=new Map(sourceRegistry.map(source=>[source.id,source.tier]));

export async function GET() {
  await ensureModelSources();
  const [rows,yields]=await Promise.all([getDb().select().from(modelSources).orderBy(modelSources.priority, desc(modelSources.createdAt)),getSourceYield()]);
  return NextResponse.json(rows.map(row=>({
    ...row,
    tier:row.adapterReference?tierByAdapterReference.get(row.adapterReference)??null:null,
    yield:row.adapterReference?yields.get(row.adapterReference)??null:null,
  })));
}

export async function POST(request: Request) {
  const id = correlationId(request);
  const p = input.safeParse(await request.json().catch(() => null));
  if (!p.success) return apiError("INVALID_SOURCE", "Invalid model source", 400, id);
  const db = getDb();
  const values = {...p.data, providerId: p.data.providerId ?? null, url: p.data.url ?? null, credentialReference: p.data.credentialReference ?? null, adapterReference: p.data.adapterReference ?? null};
  const [row] = p.data.id ? await db.update(modelSources).set({...values, updatedAt: new Date()}).where(eq(modelSources.id, p.data.id)).returning() : await db.insert(modelSources).values(values).returning();
  return NextResponse.json(row, {status: p.data.id ? 200 : 201});
}

export async function DELETE(request: Request) {
  const id = correlationId(request);
  const sourceId = new URL(request.url).searchParams.get("id");
  if (!sourceId) return apiError("INVALID_SOURCE", "Source id required", 400, id);
  const source = (await getDb().select().from(modelSources).where(eq(modelSources.id, sourceId)).limit(1))[0];
  if (source?.adapterReference) return apiError("BUILTIN_SOURCE", "Built-in sources can't be deleted — disable them instead", 400, id);
  await getDb().delete(modelSources).where(eq(modelSources.id, sourceId));
  return new NextResponse(null, {status: 204});
}
