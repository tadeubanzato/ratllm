import { LANE_IDS, type LaneId } from "@/lib/constants";

/**
 * Capability-based routing rules for the `smart-*` lanes. These are the single
 * source of truth the "Add to LiteLLM" flow and the lane reconciler both read;
 * the seed mirrors a serialized copy into `lanes.eligibility` for audit only.
 */

export type LaneCapability = "vision" | "tools" | "reasoning";

export interface LaneCandidate {
  modelRef: string;
  displayName: string;
  contextWindow: number | null;
  supportsVision: boolean | null;
  supportsTools: boolean | null;
  supportsReasoning: boolean | null;
}

export interface LaneMatch {
  slug: LaneId;
  score: number; // 0..1
  recommended: boolean;
  reason: string;
}

interface LaneRule {
  /** All must be true (null/unknown counts as not-supported — we never guess a capability into a lane). */
  requires: LaneCapability[];
  /** Minimum advertised context window, in tokens. */
  contextMin?: number;
  /** Positive name signal — boosts the score, and gates the lane when `nameGated`. */
  namePattern?: RegExp;
  nameGated?: boolean;
  /** Any chat model qualifies (the score then decides whether it is recommended). */
  universal?: boolean;
  baseScore: number;
  recommendThreshold: number;
  /** Soft cap on managed members; the reconciler will not auto-add past this. */
  maxDeployments: number;
}

export const LANE_RULES: Record<LaneId, LaneRule> = {
  "smart-general": { requires: [], universal: true, baseScore: 0.6, recommendThreshold: 0.5, maxDeployments: 12 },
  "smart-coding": { requires: [], universal: true, namePattern: /cod(e|er|ing)|deepseek|qwen[-_. ]?coder|codestral|starcoder|laguna|devstral|codex/i, baseScore: 0.28, recommendThreshold: 0.55, maxDeployments: 12 },
  "smart-agent": { requires: ["tools"], baseScore: 0.75, recommendThreshold: 0.5, maxDeployments: 12 },
  "smart-deep": { requires: ["reasoning"], baseScore: 0.75, recommendThreshold: 0.5, maxDeployments: 10 },
  "smart-long": { requires: [], contextMin: 200_000, baseScore: 0.72, recommendThreshold: 0.5, maxDeployments: 8 },
  "smart-vision": { requires: ["vision"], baseScore: 0.85, recommendThreshold: 0.5, maxDeployments: 8 },
  "smart-summary": { requires: [], universal: true, namePattern: /mini|flash|lite|nano|small|tiny|instant|turbo|[-_ ]([1-9]|1[0-9]|2[0-4])b\b/i, baseScore: 0.28, recommendThreshold: 0.55, maxDeployments: 6 },
  "smart-speech": { requires: [], namePattern: /whisper|[-_ ]tts|[-_ ]stt|speech|audio|transcri|voice/i, nameGated: true, baseScore: 0.9, recommendThreshold: 0.5, maxDeployments: 4 },
};

const hasCapability = (value: boolean | null | undefined) => value === true;

function reasonFor(slug: LaneId, rule: LaneRule, nameHit: boolean, candidate: LaneCandidate): string {
  const bits: string[] = [];
  if (rule.requires.includes("vision")) bits.push("handles image input");
  if (rule.requires.includes("tools")) bits.push("supports tool calls");
  if (rule.requires.includes("reasoning")) bits.push("reasoning model");
  if (rule.contextMin != null) bits.push(`${(candidate.contextWindow ?? 0).toLocaleString()}-token context`);
  if (nameHit && slug === "smart-coding") bits.push("name indicates a coding model");
  if (nameHit && slug === "smart-summary") bits.push("small, fast model");
  if (nameHit && slug === "smart-speech") bits.push("audio / speech model");
  if (rule.universal && bits.length === 0) bits.push("general-purpose chat model");
  return bits.join(" · ") || "eligible";
}

/** Ranks the lanes a candidate is eligible for, best score first. */
export function classifyCandidateLanes(candidate: LaneCandidate): LaneMatch[] {
  const haystack = `${candidate.modelRef} ${candidate.displayName}`.toLowerCase();
  const capFor = (capability: LaneCapability) =>
    capability === "vision" ? hasCapability(candidate.supportsVision)
      : capability === "tools" ? hasCapability(candidate.supportsTools)
        : hasCapability(candidate.supportsReasoning);

  const matches: LaneMatch[] = [];
  for (const slug of LANE_IDS) {
    const rule = LANE_RULES[slug];
    if (rule.requires.some(capability => !capFor(capability))) continue;
    if (rule.contextMin != null && (candidate.contextWindow ?? 0) < rule.contextMin) continue;
    const nameHit = rule.namePattern ? rule.namePattern.test(haystack) : false;
    if (rule.nameGated && !nameHit) continue;
    if (!rule.universal && rule.requires.length === 0 && rule.contextMin == null && !rule.nameGated) continue;

    let score = rule.baseScore + (nameHit ? 0.3 : 0) + rule.requires.length * 0.05;
    score = Math.min(1, Number(score.toFixed(2)));
    matches.push({ slug, score, recommended: score >= rule.recommendThreshold, reason: reasonFor(slug, rule, nameHit, candidate) });
  }
  return matches.sort((a, b) => b.score - a.score);
}

export type FallbackKind = "general" | "context_window";

/** Cross-lane fallback chains pushed to LiteLLM. A member of `smart-general` is therefore also the
 *  fallback pool for `smart-coding`, `smart-agent`, and (via `default_fallbacks`) everything else. */
export const LANE_FALLBACKS: Record<FallbackKind, Partial<Record<LaneId, LaneId[]>>> = {
  general: {
    "smart-general": ["smart-coding", "smart-deep"],
    "smart-coding": ["smart-general", "smart-deep"],
    "smart-agent": ["smart-general", "smart-deep"],
    "smart-deep": ["smart-long", "smart-general"],
    "smart-long": ["smart-deep", "smart-general"],
    "smart-vision": ["smart-deep", "smart-general"],
    "smart-summary": ["smart-general"],
  },
  context_window: {
    "smart-general": ["smart-long"],
    "smart-coding": ["smart-long"],
    "smart-deep": ["smart-long"],
    "smart-agent": ["smart-long"],
    "smart-summary": ["smart-long"],
  },
};

/** Serializable copy of the rules for `lanes.eligibility` (audit / display only). */
export function laneEligibilityRecord(slug: LaneId) {
  const rule = LANE_RULES[slug];
  return {
    requires: rule.requires,
    contextMin: rule.contextMin ?? null,
    namePattern: rule.namePattern?.source ?? null,
    nameGated: Boolean(rule.nameGated),
    universal: Boolean(rule.universal),
    maxDeployments: rule.maxDeployments,
  };
}
