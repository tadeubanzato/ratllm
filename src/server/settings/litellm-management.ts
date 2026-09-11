import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { systemSettings } from "@/server/db/schema";

export interface LiteLLMManagementSettings { autoAdd: boolean; autoRemove: boolean }
const KEY = "litellm.management";
const DEFAULTS: LiteLLMManagementSettings = { autoAdd: false, autoRemove: false };

export async function getLiteLLMManagementSettings(): Promise<LiteLLMManagementSettings> {
  const [row] = await getDb().select().from(systemSettings).where(eq(systemSettings.key, KEY));
  const value = (row?.value ?? {}) as Partial<LiteLLMManagementSettings>;
  return { autoAdd: value.autoAdd ?? DEFAULTS.autoAdd, autoRemove: value.autoRemove ?? DEFAULTS.autoRemove };
}

export async function setLiteLLMManagementSettings(patch: Partial<LiteLLMManagementSettings>): Promise<LiteLLMManagementSettings> {
  const next = { ...(await getLiteLLMManagementSettings()), ...patch };
  await getDb().insert(systemSettings).values({ key: KEY, value: next }).onConflictDoUpdate({ target: systemSettings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}
