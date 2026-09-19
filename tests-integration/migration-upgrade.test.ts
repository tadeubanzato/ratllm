import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Upgrade test: bring a database to the schema the PREVIOUS release ran (through migration 0011), fill it with the kinds of
 * bad rows production actually contained, then apply every remaining migration exactly as the web container does on start.
 *
 * A fresh-database test cannot catch the real deployment risk: a migration that fails on old data, which stops the web
 * container from starting. This one can.
 */

const LAST_PREVIOUS_RELEASE_TAG = "0011_add_deployment_lifecycle";
const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
const created: string[] = [];

/** A folder holding only the migrations up to (and including) `lastTag`, in the layout drizzle's migrator expects. */
function migrationsUpTo(lastTag: string) {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  const cutoff = journal.entries.findIndex(entry => entry.tag === lastTag);
  if (cutoff < 0) throw new Error(`No migration tagged ${lastTag}`);
  const folder = mkdtempSync(join(tmpdir(), "ratllm-migrations-"));
  mkdirSync(join(folder, "meta"));
  const kept = journal.entries.slice(0, cutoff + 1);
  for (const entry of kept) copyFileSync(join("drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

async function freshDatabase() {
  const name = `upgrade_${Date.now()}_${created.length}`;
  await admin.unsafe(`create database ${name}`);
  created.push(name);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  return { client, db: drizzle(client) };
}

afterAll(async () => {
  for (const name of created) await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
});

/** Rows shaped like the ones the production audit found (see findings.md §21.12), written with raw SQL against the OLD schema. */
async function plantProductionShapedRows(client: postgres.Sql) {
  await client.unsafe(`
    insert into providers (id, slug, name, adapter_key, adapter_capability) values ('00000000-0000-4000-8000-000000000001', 'groq', 'Groq', 'groq', 'MANUAL');
    -- 3 candidates: (a) timestamps inverted by 238 microseconds, (b) token limits of 0 and -1, (c) perfectly fine
    insert into model_candidates (id, source, model_ref, display_name, source_url, first_seen_at, last_seen_at, context_window, max_output_tokens) values
      ('00000000-0000-4000-8000-0000000000a1', 's', 'skewed', 'skewed', 'u', '2026-09-04 03:29:00.000238+00', '2026-09-04 03:29:00+00', 8192, 1024),
      ('00000000-0000-4000-8000-0000000000a2', 's', 'zeroed', 'zeroed', 'u', now(), now(), 0, -1),
      ('00000000-0000-4000-8000-0000000000a3', 's', 'fine', 'fine', 'u', now(), now(), 131072, 4096);
    -- smoke tests: one storing status 0 ("no response"), one fine
    insert into smoke_tests (id, status, http_status, correlation_id) values
      ('00000000-0000-4000-8000-0000000000b1', 'FAILED', 0, 'zero'),
      ('00000000-0000-4000-8000-0000000000b2', 'PASSED', 200, 'ok');
    -- a credential whose display hint holds the first and last three characters of a key
    insert into provider_credential_references (id, provider_id, environment_variable, value_hint) values
      ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'GROQ_API_KEY', 'gsk••••wEB'),
      ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', 'OTHER_API_KEY', 'Configured');
  `);
}

describe("upgrading from the previous release's schema", () => {
  it("applies every new migration to production-shaped dirty data, repairs it, and never fails", async () => {
    const { client, db } = await freshDatabase();
    await migrate(db, { migrationsFolder: migrationsUpTo(LAST_PREVIOUS_RELEASE_TAG) });          // the previous release's schema
    await plantProductionShapedRows(client);

    await migrate(db, { migrationsFolder: "drizzle" });                                           // what `pnpm db:migrate` does on start

    // Bad rows repaired, good rows untouched.
    const candidates = await client.unsafe<{ model_ref: string; first_seen_at: string; last_seen_at: string; context_window: number | null; max_output_tokens: number | null }[]>(`select model_ref, first_seen_at, last_seen_at, context_window, max_output_tokens from model_candidates order by model_ref`);
    const byRef = Object.fromEntries(candidates.map(row => [row.model_ref, row]));
    expect(new Date(byRef.skewed.first_seen_at).getTime()).toBeLessThanOrEqual(new Date(byRef.skewed.last_seen_at).getTime());
    expect(byRef.skewed.context_window).toBe(8192);                       // its other data is kept
    expect(byRef.zeroed).toMatchObject({ context_window: null, max_output_tokens: null });
    expect(byRef.fine).toMatchObject({ context_window: 131072, max_output_tokens: 4096 });
    const smoke = await client.unsafe<{ correlation_id: string; http_status: number | null }[]>(`select correlation_id, http_status from smoke_tests order by correlation_id`);
    expect(smoke).toEqual([{ correlation_id: "ok", http_status: 200 }, { correlation_id: "zero", http_status: null }]);
    const hints = await client.unsafe<{ value_hint: string }[]>(`select value_hint from provider_credential_references`);
    expect(hints.map(row => row.value_hint)).toEqual(["Configured", "Configured"]);            // no partial key remains

    // New schema features are present.
    const statuses = (await client.unsafe<{ v: string }[]>(`select unnest(enum_range(null::run_status))::text as v`)).map(row => row.v);
    expect(statuses).toEqual(expect.arrayContaining(["PARTIAL", "DEFERRED"]));
    const constraints = await client.unsafe<{ conname: string; convalidated: boolean }[]>(`select conname, convalidated from pg_constraint where conname like '%\\_chk' escape '\\'`);
    expect(constraints.length).toBeGreaterThanOrEqual(13);
    expect(constraints.every(row => row.convalidated === false)).toBe(true);                      // NOT VALID: cannot have failed on old rows
    await client.end();
  });

  it("is a no-op the second time (the web container runs migrations on every start)", async () => {
    const { client, db } = await freshDatabase();
    await migrate(db, { migrationsFolder: "drizzle" });
    await expect(migrate(db, { migrationsFolder: "drizzle" })).resolves.toBeUndefined();
    const applied = await client.unsafe<{ n: number }[]>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied[0].n).toBe(JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries.length);
    await client.end();
  });

  it("still leaves the constraints enforcing new writes after an upgrade", async () => {
    const { client, db } = await freshDatabase();
    await migrate(db, { migrationsFolder: migrationsUpTo(LAST_PREVIOUS_RELEASE_TAG) });
    await plantProductionShapedRows(client);
    await migrate(db, { migrationsFolder: "drizzle" });
    await expect(client.unsafe(`insert into smoke_tests (status, http_status, correlation_id) values ('FAILED', 0, 'new-bad')`)).rejects.toThrow(/check constraint/i);
    await client.end();
  });
});
