import { describe, expect, it } from "vitest";
import { newlyDiscoveredIds, NEW_CANDIDATE_WINDOW_MS, SOURCE_BASELINE_MS, type NewnessInput } from "../src/server/discovery/new-candidates";

const NOW = Date.parse("2026-09-20T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);
let n = 0;
const row = (over: Partial<NewnessInput> = {}): NewnessInput => ({
  id: `c${++n}`, source: "models_dev", providerId: "p1", modelRef: `vendor/model-${n}-7b`, firstSeenAt: hoursAgo(2),
  liteLLMLifecycle: null, liteLLMDeploymentId: null, ...over,
});
// Every source needs an older row, otherwise all of its rows are its own first ingest.
const anchor = (source = "models_dev") => row({ source, providerId: "p9", modelRef: `anchor-${source}-1b`, firstSeenAt: hoursAgo(24 * 30) });
const idsFor = (rows: NewnessInput[]) => newlyDiscoveredIds(rows, NOW);

describe("newlyDiscoveredIds", () => {
  it("flags a model a later run found for a tracked provider", () => {
    const fresh = row();
    expect(idsFor([anchor(), fresh]).has(fresh.id)).toBe(true);
  });

  it("never flags a model that is already in LiteLLM, in any state", () => {
    const live = row({ liteLLMDeploymentId: "dep", liteLLMLifecycle: "ACTIVE" });
    const deactivated = row({ liteLLMLifecycle: "DEACTIVATED" });
    const removed = row({ liteLLMLifecycle: "REMOVED" });
    const result = idsFor([anchor(), live, deactivated, removed]);
    expect([live, deactivated, removed].some(r => result.has(r.id))).toBe(false);
  });

  it("never flags a candidate with no resolved provider", () => {
    const unresolved = row({ providerId: null });
    expect(idsFor([anchor(), unresolved]).has(unresolved.id)).toBe(false);
  });

  it("does not flag a source's first ingest, but does flag what it finds afterwards", () => {
    const first = row({ source: "fireworks_ai", firstSeenAt: hoursAgo(20) });
    const sameRun = row({ source: "fireworks_ai", firstSeenAt: new Date(hoursAgo(20).getTime() + SOURCE_BASELINE_MS - 1) });
    const later = row({ source: "fireworks_ai", firstSeenAt: hoursAgo(2) });
    const result = idsFor([first, sameRun, later]);
    expect(result.has(first.id)).toBe(false);
    expect(result.has(sameRun.id)).toBe(false);
    expect(result.has(later.id)).toBe(true);
  });

  it("does not flag a model an older row already covers under another source or formatting", () => {
    const original = row({ source: "groq", providerId: "p1", modelRef: "llama-3.3-70b-versatile", firstSeenAt: hoursAgo(24 * 10) });
    const otherSource = row({ source: "models_dev", providerId: "p1", modelRef: "meta-llama/Llama-3.3-70B-Versatile", firstSeenAt: hoursAgo(2) });
    expect(idsFor([anchor("models_dev"), original, otherSource]).has(otherSource.id)).toBe(false);
  });

  it("still flags the same model name under a different provider", () => {
    const original = row({ providerId: "p1", modelRef: "shared-model-9b", firstSeenAt: hoursAgo(24 * 10) });
    const otherProvider = row({ providerId: "p2", modelRef: "shared-model-9b", firstSeenAt: hoursAgo(2) });
    expect(idsFor([anchor(), original, otherProvider]).has(otherProvider.id)).toBe(true);
  });

  it("flags two sources that found the same brand-new model in the same run", () => {
    const at = hoursAgo(3);
    const a = row({ source: "groq", modelRef: "brand-new-8b", firstSeenAt: at });
    const b = row({ source: "models_dev", modelRef: "brand-new-8b", firstSeenAt: at });
    const result = idsFor([anchor("groq"), anchor("models_dev"), a, b]);
    expect(result.has(a.id) && result.has(b.id)).toBe(true);
  });

  it("expires exactly at the window edge", () => {
    const inside = row({ firstSeenAt: new Date(NOW - NEW_CANDIDATE_WINDOW_MS + 1) });
    const outside = row({ firstSeenAt: new Date(NOW - NEW_CANDIDATE_WINDOW_MS) });
    const result = idsFor([anchor(), inside, outside]);
    expect(result.has(inside.id)).toBe(true);
    expect(result.has(outside.id)).toBe(false);
  });
});
