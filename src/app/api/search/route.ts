import { NextResponse } from "next/server";
import { eq, ilike, or, desc } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { canonicalModels, modelDeployments, providers, lanes, syncRuns } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export interface SearchResult { type: string; label: string; sublabel?: string; href: string }

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });
  const db = getDb();
  const like = `%${q}%`;

  const [providerRows, modelRows, laneRows, runRows] = await Promise.all([
    db.select({ id: providers.id, name: providers.name }).from(providers).where(ilike(providers.name, like)).limit(5),
    db.select({
      id: modelDeployments.id, name: canonicalModels.name, litellmModelName: modelDeployments.litellmModelName, providerName: providers.name,
    }).from(modelDeployments)
      .innerJoin(canonicalModels, eq(modelDeployments.canonicalModelId, canonicalModels.id))
      .innerJoin(providers, eq(modelDeployments.providerId, providers.id))
      .where(or(ilike(canonicalModels.name, like), ilike(modelDeployments.litellmModelName, like)))
      .limit(8),
    db.select({ id: lanes.id, slug: lanes.slug, name: lanes.name }).from(lanes).where(or(ilike(lanes.name, like), ilike(lanes.slug, like))).limit(5),
    db.select({ id: syncRuns.id, type: syncRuns.type, status: syncRuns.status }).from(syncRuns).where(ilike(syncRuns.type, like)).orderBy(desc(syncRuns.createdAt)).limit(5),
  ]);

  const results: SearchResult[] = [
    ...providerRows.map(p => ({ type: "Provider", label: p.name, href: `/providers/${p.id}` })),
    ...modelRows.map(m => ({ type: "Model", label: m.name, sublabel: `${m.providerName} · ${m.litellmModelName}`, href: `/models/${m.id}` })),
    ...laneRows.map(l => ({ type: "Lane", label: l.name, sublabel: l.slug, href: `/lanes` })),
    ...runRows.map(r => ({ type: "Run", label: r.type.replaceAll("_", " "), sublabel: r.status, href: `/runs/${r.id}` })),
  ];

  return NextResponse.json({ results });
}
