import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { systemSettings } from "@/server/db/schema";

const KEY = "deployment.identity";

/**
 * A random id stored IN the database, created the first time it is seeded. Anything looking at that database — the server, or a
 * workstation pointed at it — reads the same id. A stray local stack with its own empty database shows a DIFFERENT one, which
 * turns "why is my page empty?" into a glance: the id on the workstation doesn't match the id on the server.
 */
export async function ensureDeploymentIdentity(db: ReturnType<typeof getDb> = getDb()) {
  await db.insert(systemSettings).values({ key: KEY, value: { id: randomUUID(), createdAt: new Date().toISOString() } }).onConflictDoNothing();
}

export async function getDeploymentIdentity(): Promise<{ id: string; short: string; createdAt: string } | null> {
  const [row] = await getDb().select().from(systemSettings).where(eq(systemSettings.key, KEY));
  const value = row?.value as { id?: string; createdAt?: string } | undefined;
  return value?.id ? { id: value.id, short: value.id.slice(0, 8), createdAt: value.createdAt ?? "" } : null;
}
