export const CURATOR_MANAGED_BY = "ratllm-curator";
export const CURATOR_VERSION = "0.1.0";

/** Reply budget of every availability test, direct or through LiteLLM. Reasoning models spend it on hidden thinking before they answer, so at
 *  128 tokens they came back empty and were judged unavailable while answering normally; 256 is enough for every one seen so far. */
export const PROBE_MAX_TOKENS = 256;

export const LANE_IDS = [
  "smart-general",
  "smart-coding",
  "smart-agent",
  "smart-deep",
  "smart-long",
  "smart-vision",
  "smart-summary",
  "smart-speech",
] as const;

export type LaneId = (typeof LANE_IDS)[number];
