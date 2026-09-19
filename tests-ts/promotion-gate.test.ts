import { describe, expect, it } from "vitest";
import { candidateOnlyBlockReason } from "../src/server/discovery/promotion-gate";
import { sourceRegistry } from "../src/server/discovery/registry";

const communityId = sourceRegistry.find(source => source.candidateOnly)!.id;
const officialId = sourceRegistry.find(source => !source.candidateOnly && source.tier === "A1")!.id;

describe("candidateOnlyBlockReason", () => {
  it("blocks a candidate reported only by a candidate-only source", () => {
    expect(candidateOnlyBlockReason({ source: communityId, evidence: {} })).toMatch(/community/i);
  });

  it("does not block a candidate from an authoritative source", () => {
    expect(candidateOnlyBlockReason({ source: officialId, evidence: {} })).toBeNull();
  });

  it("stays blocked when the only corroboration is another candidate-only source", () => {
    const other = sourceRegistry.filter(source => source.candidateOnly)[1].id;
    expect(candidateOnlyBlockReason({ source: communityId, evidence: { corroboratingSources: [{ source: other }] } })).not.toBeNull();
  });

  it("allows a candidate-only winner that an authoritative source also reported", () => {
    expect(candidateOnlyBlockReason({ source: communityId, evidence: { corroboratingSources: [{ source: officialId }] } })).toBeNull();
  });

  it("tolerates missing or malformed evidence", () => {
    expect(candidateOnlyBlockReason({ source: communityId, evidence: null })).not.toBeNull();
    expect(candidateOnlyBlockReason({ source: communityId, evidence: { corroboratingSources: "nope" } })).not.toBeNull();
  });

  it("marks every candidate-only registry entry as blocked (registry and gate cannot drift)", () => {
    for (const source of sourceRegistry.filter(entry => entry.candidateOnly)) expect(candidateOnlyBlockReason({ source: source.id })).not.toBeNull();
  });
});
