import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { sqlClient?: ReturnType<typeof postgres> };

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const client = globalDb.sqlClient ?? postgres(url, { max: process.env.NODE_ENV === "production" ? 10 : 2, prepare: false });
  if (process.env.NODE_ENV !== "production") globalDb.sqlClient = client;
  return drizzle(client, { schema });
}

export async function databaseHealth() {
  const started = performance.now();
  await getDb().execute(sql`select 1`);
  return { status: "healthy" as const, latencyMs: Math.round(performance.now() - started) };
}

import { sql } from "drizzle-orm";
