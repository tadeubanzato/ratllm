export interface DiscoveredCandidate {
  source: string;
  modelRef: string;
  displayName: string;
  providerName?: string;
  freeType: "FREE_TIER" | "UNKNOWN";
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
