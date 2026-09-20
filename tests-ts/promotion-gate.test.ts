import { describe, expect, it } from "vitest";
import { candidateOnlyBlockReason } from "../src/server/discovery/promotion-gate";
import { sourceRegistry } from "../src/server/discovery/registry";

// The registry currently has no candidate-only source (every source is either an official catalog or a provider's own API),
// so the rule is exercised with an explicit set instead of whatever the registry happens to contain today.
const communityId = "community-list";
const officialId = "official-catalog";
const candidateOnly = new Set([communityId]);
const reason = (candidate: Parameters<typeof candidateOnlyBlockReason>[0]) => candidateOnlyBlockReason(candidate, candidateOnly);

describe("candidateOnlyBlockReason", () => {
  it("blocks a candidate reported only by a candidate-only source", () => {
    expect(reason({ source: communityId, evidence: {} })).toMatch(/community/i);
  });

  it("does not block a candidate from an authoritative source", () => {
    expect(reason({ source: officialId, evidence: {} })).toBeNull();
  });

  it("still blocks when the only corroboration is another candidate-only source", () => {
    expect(candidateOnlyBlockReason({ source: communityId, evidence: { corroboratingSources: [{ source: "another-list" }] } }, new Set([communityId, "another-list"]))).not.toBeNull();
  });

  it("unblocks a candidate an authoritative source also reported", () => {
    expect(reason({ source: communityId, evidence: { corroboratingSources: [{ source: officialId }] } })).toBeNull();
  });

  it("treats missing or malformed evidence as uncorroborated", () => {
    expect(reason({ source: communityId, evidence: null })).not.toBeNull();
    expect(reason({ source: communityId, evidence: { corroboratingSources: "nope" } })).not.toBeNull();
  });

  it("defaults to the registry's own candidate-only sources, so none of them can slip through", () => {
    for (const source of sourceRegistry.filter(entry => entry.candidateOnly)) expect(candidateOnlyBlockReason({ source: source.id })).not.toBeNull();
  });
});
