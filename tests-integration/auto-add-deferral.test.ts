import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelCandidates } from "@/server/db/schema";
import { markAutoAddDeferred } from "@/server/discovery/verify-due";
import { isAutoAddDeferred } from "@/server/discovery/auto-add-policy";

const insert = async (evidence: Record<string, unknown>) =>
  (await getDb().insert(modelCandidates).values({ source: "openrouter", modelRef: "m", displayName: "m", sourceUrl: "u", evidence }).returning())[0];
const evidenceOf = async (id: string) => (await getDb().select().from(modelCandidates).where(eq(modelCandidates.id, id)))[0].evidence;

describe("markAutoAddDeferred", () => {
  it("adds the deferral marker without disturbing any existing evidence", async () => {
    const row = await insert({ testedAt: "2026-09-18T00:00:00Z", consecutiveAvailable: 3, corroboratingSources: [{ source: "x", sourceUrl: "y" }] });
    await markAutoAddDeferred(getDb(), row.id);
    const evidence = await evidenceOf(row.id);
    expect(evidence).toMatchObject({ testedAt: "2026-09-18T00:00:00Z", consecutiveAvailable: 3, corroboratingSources: [{ source: "x", sourceUrl: "y" }] });
    expect(isAutoAddDeferred(evidence)).toBe(true);
  });

  it("works on a candidate with empty evidence, and refreshes an older marker", async () => {
    const row = await insert({});
    await markAutoAddDeferred(getDb(), row.id);
    expect(isAutoAddDeferred(await evidenceOf(row.id))).toBe(true);
    await getDb().update(modelCandidates).set({ evidence: { autoAddDeferredUntil: "2020-01-01T00:00:00Z" } }).where(eq(modelCandidates.id, row.id));
    expect(isAutoAddDeferred(await evidenceOf(row.id))).toBe(false);
    await markAutoAddDeferred(getDb(), row.id);
    expect(isAutoAddDeferred(await evidenceOf(row.id))).toBe(true);
  });
});
