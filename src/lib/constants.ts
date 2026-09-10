export const CURATOR_MANAGED_BY = "ratllm-curator";
export const CURATOR_VERSION = "0.1.0";

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
