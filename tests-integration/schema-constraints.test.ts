import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, canonicalModels, lanes, modelCandidates, modelDeployments, modelSources, providerCredentialReferences, providers, rateLimitProfiles, smokeTests, syncRuns } from "@/server/db/schema";
import { persistDiscoveredItems } from "@/server/discovery/run";
import type { DiscoveredCandidate } from "@/server/discovery/types";
import { syncLiteLLM } from "@/server/litellm/sync";

vi.mock("@/server/litellm/client", () => ({ HttpLiteLLMAdapter: class { async smokeTest() { return { ok: false, status: 0, latencyMs: 5, error: "connect ECONNREFUSED" }; } } }));

const MIGRATION = readFileSync("drizzle/0014_data_hygiene_and_constraints.sql", "utf8");
const statements = MIGRATION.split("--> statement-breakpoint").map(part => part.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").trim()).filter(Boolean);
const repairs = statements.filter(statement => /^UPDATE /i.test(statement));
const constraintNames = statements.flatMap(statement => statement.match(/ADD CONSTRAINT "([^"]+)"/)?.[1] ?? []);

const db = () => getDb();
const violates = async (run: Promise<unknown>) => { try { await run; return null; } catch (error) { return ((error as { cause?: { code?: string } }).cause?.code) ?? (error as { code?: string }).code ?? String(error); } };
const CHECK_VIOLATION = "23514";

async function provider() {
  return (await db().insert(providers).values({ slug: "acme", name: "Acme", adapterKey: "manual", adapterCapability: "MANUAL" }).returning())[0];
}
const candidate = (over: Record<string, unknown> = {}) => db().insert(modelCandidates).values({ source: "s", modelRef: `m-${Math.random()}`, displayName: "m", sourceUrl: "u", ...over } as never).returning();

describe("migration 0014 constraints", () => {
  it("adds every constraint as NOT VALID, so old rows can never make the migration fail", async () => {
    expect(constraintNames.length).toBe(13);
    const rows = await db().execute<{ conname: string; convalidated: boolean }>(sql`select conname, convalidated from pg_constraint where conname in (${sql.join(constraintNames.map(name => sql`${name}`), sql`, `)})`);
    expect(rows.map(row => row.conname).sort()).toEqual([...constraintNames].sort());
    expect(rows.every(row => row.convalidated === false)).toBe(true);
  });

  it("rejects the bad rows it was written to prevent", async () => {
    const p = await provider();
    const [c] = await candidate();
    const [model] = await db().insert(canonicalModels).values({ slug: "x", name: "x" }).returning();
    const deployment = async (over: Record<string, unknown>) => db().insert(modelDeployments).values({ canonicalModelId: model.id, providerId: p.id, providerModelId: `pm-${Math.random()}`, litellmModelName: "a", ...over } as never);

    expect(await violates(candidate({ firstSeenAt: new Date("2026-09-19T12:00:10Z"), lastSeenAt: new Date("2026-09-19T12:00:00Z") }))).toBe(CHECK_VIOLATION);
    expect(await violates(candidate({ contextWindow: 0 }))).toBe(CHECK_VIOLATION);
    expect(await violates(candidate({ maxOutputTokens: -5 }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(canonicalModels).values({ slug: "y", name: "y", contextWindow: 0 }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(smokeTests).values({ status: "FAILED", httpStatus: 0, correlationId: "c" }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(smokeTests).values({ status: "FAILED", latencyMs: -1, correlationId: "c" }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(candidateChecks).values({ candidateId: c.id, status: "x", httpStatus: 700 }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(lanes).values({ slug: "l1", name: "l", description: "d", minimumHealthy: 5, maximumDeployments: 3 }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(syncRuns).values({ type: "T", status: "SUCCEEDED", correlationId: "c", startedAt: new Date("2026-09-19T12:00:10Z"), finishedAt: new Date("2026-09-19T12:00:00Z") }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(modelSources).values({ name: "n", type: "MANUAL", discoveredModelCount: -1 }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(providerCredentialReferences).values({ providerId: p.id, environmentVariable: "lower_case" }))).toBe(CHECK_VIOLATION);
    expect(await violates(deployment({ lifecycle: "ACTIVE", litellmDeploymentId: null }))).toBe(CHECK_VIOLATION);
    expect(await violates(deployment({ managed: true, managedBy: null }))).toBe(CHECK_VIOLATION);
    expect(await violates(deployment({ managed: true, managedBy: "" }))).toBe(CHECK_VIOLATION);
    const deploymentRow = (await deployment({ litellmDeploymentId: "r-1" }).then(() => db().select().from(modelDeployments)))[0];
    expect(await violates(db().insert(rateLimitProfiles).values({ deploymentId: deploymentRow.id, rpmLimit: 0 }))).toBe(CHECK_VIOLATION);
    expect(await violates(db().insert(rateLimitProfiles).values({ deploymentId: deploymentRow.id, confidenceScore: 1.5 }))).toBe(CHECK_VIOLATION);
  });

  it("still accepts every legitimate shape: unknowns as NULL, and the boundaries", async () => {
    const p = await provider();
    expect(await violates(candidate({ contextWindow: null, maxOutputTokens: null }))).toBeNull();
    expect(await violates(candidate({ contextWindow: 1 }))).toBeNull();
    expect(await violates(db().insert(smokeTests).values([{ status: "FAILED", httpStatus: null, correlationId: "a" }, { status: "PASSED", httpStatus: 100, correlationId: "b" }, { status: "PASSED", httpStatus: 599, correlationId: "c" }]))).toBeNull();
    // Clock skew of a few hundred microseconds between the two timestamps is allowed; that is what the audit found.
    expect(await violates(candidate({ firstSeenAt: new Date("2026-09-19T12:00:00.000Z"), lastSeenAt: new Date("2026-09-19T11:59:59.999Z") }))).toBeNull();
    expect(await violates(db().insert(providerCredentialReferences).values({ providerId: p.id, environmentVariable: "GOOD_API_KEY_2" }))).toBeNull();
    expect(await violates(db().insert(lanes).values({ slug: "l2", name: "l", description: "d", minimumHealthy: 0, maximumDeployments: 0 }))).toBeNull();
  });
});

describe("migration 0014 repairs (run against deliberately bad rows)", () => {
  // The next test drops the constraints so it can plant bad rows; put them back so later test files see the real schema.
  afterAll(async () => {
    for (const statement of statements.filter(text => /ADD CONSTRAINT/.test(text))) {
      const name = statement.match(/ADD CONSTRAINT "([^"]+)"/)![1];
      const table = statement.match(/ALTER TABLE "([^"]+)"/)![1];
      await db().execute(sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`));
      await db().execute(sql.raw(statement));
    }
  });
  it("fixes each kind of bad row the audit found, and leaves good rows alone", async () => {
    // The constraints would refuse these rows, so drop them for this test only (the harness database is disposable).
    for (const name of constraintNames) {
      const table = MIGRATION.match(new RegExp(`ALTER TABLE "([^"]+)" ADD CONSTRAINT "${name}"`))![1];
      await db().execute(sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`));
    }
    const skewedFirst = new Date("2026-09-19T12:00:00.000Z"), skewedLast = new Date("2026-09-19T11:59:59.999Z");
    const [bad] = await candidate({ firstSeenAt: skewedFirst, lastSeenAt: skewedLast, contextWindow: 0, maxOutputTokens: -1 });
    const [good] = await candidate({ contextWindow: 8192, maxOutputTokens: 1024 });
    await db().insert(smokeTests).values([{ status: "FAILED", httpStatus: 0, correlationId: "zero" }, { status: "PASSED", httpStatus: 200, correlationId: "ok" }]);

    expect(repairs.length).toBeGreaterThanOrEqual(5);
    for (const statement of repairs) await db().execute(sql.raw(statement));

    const fixed = (await db().select().from(modelCandidates).where(eq(modelCandidates.id, bad.id)))[0];
    expect(fixed.firstSeenAt.getTime()).toBe(fixed.lastSeenAt.getTime());   // first never after last
    expect(fixed.lastSeenAt.getTime()).toBe(skewedLast.getTime());          // last_seen_at (the truth) is kept
    expect(fixed.contextWindow).toBeNull();
    expect(fixed.maxOutputTokens).toBeNull();
    const untouched = (await db().select().from(modelCandidates).where(eq(modelCandidates.id, good.id)))[0];
    expect(untouched).toMatchObject({ contextWindow: 8192, maxOutputTokens: 1024 });
    const statuses = (await db().select().from(smokeTests)).map(row => [row.correlationId, row.httpStatus]).sort();
    expect(statuses).toEqual([["ok", 200], ["zero", null]]);
  });

  it("is idempotent", async () => {
    await candidate({ contextWindow: 0 });
    for (const statement of repairs) await db().execute(sql.raw(statement));
    const once = JSON.stringify(await db().select().from(modelCandidates));
    for (const statement of repairs) await db().execute(sql.raw(statement));
    expect(JSON.stringify(await db().select().from(modelCandidates))).toBe(once);
  });
});

describe("the code no longer writes the bad data", () => {
  const item = (over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => ({ source: "s", modelRef: "m-1", displayName: "m", providerName: "Groq", freeType: "FREE_TIER", verifiedFree: false, sourceUrl: "u", evidence: {}, ...over });
  const state = () => ({ providerIdBySlug: new Map<string, string>(), touchedProviderIds: new Set<string>() });

  it("discovery inserts first_seen_at and last_seen_at from one clock", async () => {
    await persistDiscoveredItems(db(), Array.from({ length: 50 }, (_, i) => item({ modelRef: `m-${i}` })), state());
    const rows = await db().select().from(modelCandidates);
    expect(rows).toHaveLength(50);
    for (const row of rows) expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.firstSeenAt.getTime());
  });

  it("discovery stores an unknown token limit as NULL, never 0 or a negative", async () => {
    await persistDiscoveredItems(db(), [item({ modelRef: "zero", contextWindow: 0, maxOutputTokens: 0 }), item({ modelRef: "neg", contextWindow: -5 }), item({ modelRef: "real", contextWindow: 131072, maxOutputTokens: 4096 }), item({ modelRef: "nan", contextWindow: Number.NaN })], state());
    const byRef = Object.fromEntries((await db().select().from(modelCandidates)).map(row => [row.modelRef, [row.contextWindow, row.maxOutputTokens]]));
    expect(byRef).toEqual({ zero: [null, null], neg: [null, null], real: [131072, 4096], nan: [null, null] });
  });

  it("a refresh normalizes too", async () => {
    await persistDiscoveredItems(db(), [item({ modelRef: "r", contextWindow: 8192 })], state());
    await persistDiscoveredItems(db(), [item({ modelRef: "r", contextWindow: 0 })], state());
    expect((await db().select().from(modelCandidates))[0].contextWindow).toBeNull();
  });

  it("a manual smoke test with no HTTP response stores NULL, not 0", async () => {
    const inventory = { listDeployments: async () => [{ model_name: "smart-agent", litellm_params: { model: "groq/x" }, model_info: { id: "r-smoke" } }] } as never;
    await syncLiteLLM({}, inventory);
    const deployment = (await db().select().from(modelDeployments))[0];
    const { POST } = await import("@/app/api/litellm/smoke/route");
    await POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ deploymentId: deployment.id, model: "smart-agent" }) }));
    const rows = await db().select().from(smokeTests);
    expect(rows).toHaveLength(1);
    expect(rows[0].httpStatus).toBeNull();
  });
});
