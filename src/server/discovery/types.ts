export interface DiscoveredCandidate {
  source: "openrouter" | "litellm-cost-map" | "community-lists";
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
  readonly id: DiscoveredCandidate["source"];
  discover(): Promise<DiscoveredCandidate[]>;
}
