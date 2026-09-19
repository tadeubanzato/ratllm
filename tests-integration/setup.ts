import { beforeEach } from "vitest";
import { sql } from "drizzle-orm";

// Hard safety rail: these tests TRUNCATE every table. They may only ever run against the disposable container that
// scripts/test-integration.sh starts on localhost:55432 — never a real database, whatever DATABASE_URL was in the shell.
const url = process.env.DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1):55432\//.test(url)) {
  throw new Error("Refusing to run integration tests: DATABASE_URL must point at the disposable test database on localhost:55432. Use scripts/test-integration.sh.");
}

beforeEach(async () => {
  const { getDb } = await import("@/server/db/client");
  const db = getDb();
  const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  if (tables.length) await db.execute(sql.raw(`truncate table ${tables.map(row => `"${row.tablename}"`).join(", ")} restart identity cascade`));
});
