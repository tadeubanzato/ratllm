export type FreeType = "FREE_TIER" | "UNKNOWN" | "RECURRING_CREDIT" | "TRIAL_QUOTA" | "PROVIDER_SPECIFIC_FREE"
  | "PERMANENT_FREE" | "RECURRING_DAILY" | "RECURRING_MONTHLY" | "TRIAL_CREDIT" | "PROMOTIONAL" | "OPEN_WEIGHT_SELF_HOSTED" | "PAID";

export interface DiscoveredCandidate {
  source: string;
  modelRef: string;
  displayName: string;
  providerName?: string;
  freeType: FreeType;
  /** The source states this model is free, with evidence in `evidence` (a zero price, a `:free` variant, an `isFree` flag). Not proof it works. */
  verifiedFree: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  /** Set when the source itself says this is not a chat model (an embedding, image, audio, rerank or moderation model),
   *  so it is never sent a chat-completion test (docs/DISCOVERY-PIPELINE.md §6). */
  nonChatReason?: string;
  sourceUrl: string;
  evidence: Record<string, unknown>;
}

/** What a source says about a provider's free offer. The text fields are the source's own wording, kept verbatim (§2). */
export interface ProviderOffer {
  source: string;
  providerName: string;
  /** The dataset's own id for the provider ("google-gemini"), a second chance to match the catalog when the name does not. */
  slugHint?: string;
  freeType: FreeType;
  freeTierText?: string;
  rateLimitsText?: string;
  notes?: string;
  expiresAt?: string;
  cardRequired?: boolean;
  phoneRequired?: boolean;
  commercialOk?: boolean;
  openaiBaseUrl?: string;
  docsUrl?: string;
  sourceVerified?: boolean;
  sourceLastVerified?: string;
}

export interface DiscoveryResult {
  candidates: DiscoveredCandidate[];
  offers?: ProviderOffer[];
  /** Items the adapter saw but could not turn into a candidate (no id, wrong shape). Reported, so a source that quietly
   *  drops most of its rows shows up as DEGRADED instead of looking healthy with a small number. */
  rejected?: number;
}

export interface DiscoverySource {
  readonly id: string;
  /** Fewer candidates than this is a FAILED run for this source, never a success (I4). Defaults to 1. */
  readonly minExpected?: number;
  /** Set when the source is one provider's own catalog: every candidate belongs to that catalog provider (I1). */
  readonly providerSlug?: string;
  discover(): Promise<DiscoveredCandidate[] | DiscoveryResult>;
}

/** Thrown by a source that cannot run yet for an expected, fixable reason (a required credential isn't configured). It is a
 *  waiting state, not a failure: the run records the source as BLOCKED, doesn't degrade it, and doesn't consume its refresh
 *  interval, so it is tried again on the next run once the credential exists. */
export class SourceBlockedError extends Error {
  constructor(message: string) { super(message); this.name = "SourceBlockedError"; }
}

export const normalizeDiscoveryResult = (value: DiscoveredCandidate[] | DiscoveryResult): Required<DiscoveryResult> =>
  Array.isArray(value) ? { candidates: value, offers: [], rejected: 0 } : { candidates: value.candidates, offers: value.offers ?? [], rejected: value.rejected ?? 0 };
