import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providerOffers, providers } from "@/server/db/schema";
import { providerWiring, resolveCompletionsEndpoint, supportsCredentialTest } from "@/server/providers/wiring";

/** Why no test call can be made for a candidate right now (docs/DISCOVERY-PIPELINE.md §6, invariant I6). A blocker is a fact
 *  about the candidate or its provider, not a check result: it is never recorded as history, and it neither breaks nor
 *  extends a streak. It clears the moment its cause is fixed, and the candidate becomes due immediately. */
export type CheckBlocker = "PROVIDER_UNRESOLVED" | "NOT_CHAT_MODEL" | "NO_ENDPOINT" | "CREDENTIAL_MISSING" | "CREDENTIAL_UNVERIFIED";

export const BLOCKER_LABELS: Readonly<Record<CheckBlocker, string>> = {
  PROVIDER_UNRESOLVED: "No provider",
  NOT_CHAT_MODEL: "Not a chat model",
  NO_ENDPOINT: "Needs a base URL",
  CREDENTIAL_MISSING: "Needs a credential",
  CREDENTIAL_UNVERIFIED: "Credential not verified",
};

export interface ProviderTestState {
  slug: string;
  baseUrl: string | null;
  /** The OpenAI-compatible base URL a source published for this provider: a fallback when the catalog has no wiring for it. */
  offerBaseUrl: string | null;
  hasCredential: boolean;
  credentialVerified: boolean;
}

/** What stops any model at this provider from being tested (null = testable). Mirrors verifyCandidateDirectly's own gates
 *  exactly, so a candidate is never "testable" here and then rejected there, or the reverse. Pure. */
export function providerBlocker(state: ProviderTestState): CheckBlocker | null {
  if (!resolveCompletionsEndpoint(state.slug, state.baseUrl ?? state.offerBaseUrl)) return "NO_ENDPOINT";
  if (!state.hasCredential) return providerWiring[state.slug]?.credentialOptional ? null : "CREDENTIAL_MISSING";
  if (!state.credentialVerified && supportsCredentialTest(state.slug)) return "CREDENTIAL_UNVERIFIED";
  return null;
}

const changed = (result: unknown) => (result as { count?: number }).count ?? 0;

/** Recomputes every candidate's blocker with a handful of set-based updates (one per provider, plus two global), so it is
 *  cheap enough to run after every discovery and before every verification pass however many candidates exist (I12).
 *  Order matters: a model that is not a chat model at all is blocked as such whatever its provider looks like. A blocker
 *  that clears makes the candidate due right now. Returns how many candidates changed. */
export async function reconcileCheckBlockers(db: ReturnType<typeof getDb>): Promise<number> {
  const [providerRows, credentialRows, offerRows] = await Promise.all([
    db.select({ id: providers.id, slug: providers.slug, baseUrl: providers.baseUrl }).from(providers),
    db.select({ providerId: providerCredentialReferences.providerId, valid: providerCredentialReferences.valid }).from(providerCredentialReferences).where(sql`${providerCredentialReferences.disabled} = false`),
    db.select({ providerId: providerOffers.providerId, openaiBaseUrl: providerOffers.openaiBaseUrl }).from(providerOffers),
  ]);
  let updated = 0;
  updated += changed(await db.execute(sql`update model_candidates set check_blocker = 'NOT_CHAT_MODEL', updated_at = now() where (evidence->>'nonChatReason') is not null and check_blocker is distinct from 'NOT_CHAT_MODEL'`));
  updated += changed(await db.execute(sql`update model_candidates set check_blocker = 'PROVIDER_UNRESOLVED', updated_at = now() where provider_id is null and (evidence->>'nonChatReason') is null and check_blocker is distinct from 'PROVIDER_UNRESOLVED'`));
  for (const provider of providerRows) {
    const credentials = credentialRows.filter(row => row.providerId === provider.id);
    const blocker = providerBlocker({
      slug: provider.slug, baseUrl: provider.baseUrl,
      offerBaseUrl: offerRows.find(row => row.providerId === provider.id && row.openaiBaseUrl)?.openaiBaseUrl ?? null,
      hasCredential: credentials.length > 0, credentialVerified: credentials.some(row => row.valid === true),
    });
    // A cleared blocker means the candidate can be tested now, so it is made due; a set or changed one leaves its schedule alone.
    updated += changed(await db.execute(sql`update model_candidates set check_blocker = ${blocker}, next_check_at = case when ${blocker}::text is null then now() else next_check_at end, updated_at = now() where provider_id = ${provider.id} and (evidence->>'nonChatReason') is null and check_blocker is distinct from ${blocker}::text`));
  }
  return updated;
}
