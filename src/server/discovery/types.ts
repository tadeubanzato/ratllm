export type FreeType = "FREE_TIER" | "UNKNOWN" | "RECURRING_CREDIT" | "TRIAL_QUOTA" | "PROVIDER_SPECIFIC_FREE";

export interface DiscoveredCandidate {
  source: string;
  modelRef: string;
  displayName: string;
  providerName?: string;
  freeType: FreeType;
  verifiedFree: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  sourceUrl: string;
  evidence: Record<string, unknown>;
}

export interface DiscoverySource {
  readonly id: string;
  discover(): Promise<DiscoveredCandidate[]>;
}

/** Thrown by a source that cannot run yet for an expected, fixable reason (a required credential isn't configured). It is a
 *  waiting state, not a failure: the run records the source as BLOCKED, doesn't degrade it, and doesn't consume its refresh
 *  interval, so it is tried again on the next run once the credential exists. */
export class SourceBlockedError extends Error {
  constructor(message: string) { super(message); this.name = "SourceBlockedError"; }
}
