import { describe, expect, it } from "vitest";
import { classifyCandidateLanes, LANE_FALLBACKS } from "@/server/lanes/rules";

const base = { modelRef: "acme/generic-model", displayName: "Generic Model", contextWindow: 32_000, supportsVision: null, supportsTools: null, supportsReasoning: null };
const slugs = (c: Parameters<typeof classifyCandidateLanes>[0]) => classifyCandidateLanes(c).map(m => m.slug);
const recommended = (c: Parameters<typeof classifyCandidateLanes>[0]) => classifyCandidateLanes(c).filter(m => m.recommended).map(m => m.slug);

describe("classifyCandidateLanes", () => {
  it("routes every chat model to smart-general", () => {
    expect(slugs(base)).toContain("smart-general");
    expect(recommended(base)).toContain("smart-general");
  });

  it("gates capability lanes on hard signals, never on a guess", () => {
    expect(slugs(base)).not.toContain("smart-vision");
    expect(slugs(base)).not.toContain("smart-agent");
    expect(slugs(base)).not.toContain("smart-deep");
    expect(slugs({ ...base, supportsVision: true })).toContain("smart-vision");
    expect(slugs({ ...base, supportsTools: true })).toContain("smart-agent");
    expect(slugs({ ...base, supportsReasoning: true })).toContain("smart-deep");
  });

  it("puts large-context models in smart-long", () => {
    expect(slugs({ ...base, contextWindow: 131_072 })).not.toContain("smart-long");
    expect(slugs({ ...base, contextWindow: 1_048_576 })).toContain("smart-long");
  });

  it("recommends smart-coding for a coding model by name", () => {
    expect(recommended({ ...base, modelRef: "deepseek/deepseek-coder-v2", displayName: "DeepSeek Coder V2" })).toContain("smart-coding");
    expect(recommended(base)).not.toContain("smart-coding");
  });

  it("only routes to smart-speech when the name says audio", () => {
    expect(slugs(base)).not.toContain("smart-speech");
    expect(slugs({ ...base, modelRef: "openai/whisper-large-v3", displayName: "Whisper Large v3" })).toContain("smart-speech");
  });

  it("keeps fallback chains within known lanes and non-self-referential", () => {
    for (const kind of ["general", "context_window"] as const) {
      for (const [from, targets] of Object.entries(LANE_FALLBACKS[kind])) {
        expect(targets).not.toContain(from);
        for (const target of targets ?? []) expect(target.startsWith("smart-")).toBe(true);
      }
    }
  });
});
