import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { sqlClient?: ReturnType<typeof postgres> };

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  // A server process must own one pool. Creating a fresh `postgres()` client
  // for every request in production exhausts PostgreSQL's connection limit
  // under normal page/API traffic.
  const client = globalDb.sqlClient ?? postgres(url, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  globalDb.sqlClient = client;
  return drizzle(client, { schema });
}

export async function databaseHealth() {
  const started = performance.now();
  await getDb().execute(sql`select 1`);
  return { status: "healthy" as const, latencyMs: Math.round(performance.now() - started) };
}

import { sql } from "drizzle-orm";
