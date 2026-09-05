import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/server/config";
import { getDb } from "@/server/db/client";
import { systemSettings } from "@/server/db/schema";
import { decryptCredential, encryptCredential } from "@/server/credentials/crypto";

export type Integration = "litellm";
type Saved = { baseUrl?: string; encryptedMasterKey?: string; lastSuccess?: string; lastTestAt?: string; status?: string; error?: string; deploymentCount?: number; version?: string | null };
export const connectionInput = z.object({
  baseUrl: z.string().url().refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, "Use an HTTP(S) URL without credentials, query, or fragment"),
  masterKey: z.string().min(8).max(10000).optional(),
});
async function saved(kind: Integration): Promise<Saved> {
  const [row] = await getDb().select().from(systemSettings).where(eq(systemSettings.key, `${kind}.config`));
  return (row?.value ?? {}) as Saved;
}
async function write(kind: Integration, value: Saved) {
  await getDb().insert(systemSettings).values({key: `${kind}.config`, value}).onConflictDoUpdate({target: systemSettings.key, set: {value, updatedAt: new Date()}});
}
export async function connectionConfig(kind: Integration) {
  const value = await saved(kind);
  return {baseUrl: value.baseUrl ?? env.LITELLM_BASE_URL, key: value.encryptedMasterKey ? decryptCredential(value.encryptedMasterKey) : env.LITELLM_MASTER_KEY};
}
export async function connectionSummary(kind: Integration) {
  const value = await saved(kind);
  const baseUrl = value.baseUrl ?? env.LITELLM_BASE_URL ?? "";
  const configured = Boolean(value.encryptedMasterKey || env.LITELLM_MASTER_KEY);
  const stale = value.lastTestAt && Date.now() - Date.parse(value.lastTestAt) > 15 * 60_000;
  return {baseUrl, configured, status: !baseUrl ? "NOT_CONFIGURED" : stale ? "STALE" : value.status ?? "NOT_TESTED", lastSuccess: value.lastSuccess ?? null, lastTestAt: value.lastTestAt ?? null, error: value.error ?? null, deploymentCount: value.deploymentCount ?? null, version: value.version ?? null};
}
export async function saveConnection(kind: Integration, input: z.infer<typeof connectionInput>) {
  const value = await saved(kind);
  await write(kind, {...value, baseUrl: input.baseUrl.replace(/\/$/, ""), ...(input.masterKey ? {encryptedMasterKey: encryptCredential(input.masterKey)} : {}), status: "NOT_TESTED", lastTestAt: undefined, lastSuccess: undefined, error: undefined});
}
export async function recordConnection(kind: Integration, result: {ok: boolean; error?: string; deploymentCount?: number; version?: string | null}) {
  const {ok, ...details} = result;
  const now = new Date().toISOString();
  await write(kind, {...await saved(kind), ...details, error: result.error, status: ok ? "HEALTHY" : "UNAVAILABLE", lastTestAt: now, ...(ok ? {lastSuccess: now} : {})});
}
/** Only allow known diagnostic categories; never return remote bodies or exception text. */
export function connectionError(error: unknown): string {
  const value = error as {status?: number; name?: string; cause?: {code?: string}};
  if (value?.status === 401 || value?.status === 403) return "Authentication rejected. Check the configured credential and its permissions.";
  if (value?.status) return `Service returned HTTP ${value.status}. Check the base URL and service availability.`;
  if (value?.cause?.code === "ECONNREFUSED") return "Connection refused. Check that the service is running, the base URL is correct, and Docker/network connectivity is available.";
  if (value?.name === "TimeoutError" || value?.name === "AbortError") return "Connection timed out. Check service availability and Docker/network connectivity.";
  return "Connection failed. Check the base URL, server credential configuration, and Docker/network connectivity.";
}
