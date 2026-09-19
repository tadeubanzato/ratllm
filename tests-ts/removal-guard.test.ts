import { describe, expect, it } from "vitest";
import { shouldApplyRemovals } from "../src/server/litellm/removal-guard";

describe("shouldApplyRemovals", () => {
  it("applies removals for a normal, non-empty inventory", () => {
    expect(shouldApplyRemovals({ identifiedRemoteCount: 12, liveLocalCount: 54, previousIdentifiedRemoteCount: 54 })).toEqual({ apply: true });
  });

  it("refuses to act on a single empty result while live deployments exist", () => {
    expect(shouldApplyRemovals({ identifiedRemoteCount: 0, liveLocalCount: 54, previousIdentifiedRemoteCount: 54 })).toEqual({ apply: false, reason: "empty_inventory_unconfirmed" });
  });

  it("refuses when there is no previous sync to confirm against", () => {
    expect(shouldApplyRemovals({ identifiedRemoteCount: 0, liveLocalCount: 3, previousIdentifiedRemoteCount: null }).apply).toBe(false);
  });

  it("believes a second consecutive empty result, so a genuinely emptied router converges", () => {
    expect(shouldApplyRemovals({ identifiedRemoteCount: 0, liveLocalCount: 54, previousIdentifiedRemoteCount: 0 }).apply).toBe(true);
  });

  it("has nothing to protect when no deployment is live locally", () => {
    expect(shouldApplyRemovals({ identifiedRemoteCount: 0, liveLocalCount: 0, previousIdentifiedRemoteCount: 54 }).apply).toBe(true);
  });
});
