import { describe, expect, it } from "vitest";
import { AUTO_ADD_DEFER_MS, FLAP_LIMIT, REMOVE_COOLDOWN_MS, autoAddDeferredUntil, isAutoAddDeferred, inRemovalCooldown, isAutoReAddBlocked, isFlapLimited, removalHistoryOf, withRemoval, SAME_REMOVAL_EVENT_MS } from "../src/server/discovery/auto-add-policy";

const NOW = new Date("2026-09-13T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60_000).toISOString();
const record = (at: string) => ({ at, reason: "5 consecutive failed health checks" });

describe("removalHistoryOf", () => {
  it("returns an empty history when evidence has none", () => {
    expect(removalHistoryOf({})).toEqual([]);
  });

  it("ignores a malformed non-array value instead of throwing", () => {
    expect(removalHistoryOf({ removalHistory: "not-an-array" })).toEqual([]);
  });

  it("returns the stored history as-is", () => {
    const history = [record(hoursAgo(1))];
    expect(removalHistoryOf({ removalHistory: history })).toEqual(history);
  });
});

describe("inRemovalCooldown", () => {
  it("is false with no removal history", () => {
    expect(inRemovalCooldown([], NOW)).toBe(false);
  });

  it("is true immediately after a removal", () => {
    expect(inRemovalCooldown([record(hoursAgo(0.1))], NOW)).toBe(true);
  });

  it("is true right up to the cooldown boundary", () => {
    const justInside = new Date(NOW - (REMOVE_COOLDOWN_MS - 1000)).toISOString();
    expect(inRemovalCooldown([record(justInside)], NOW)).toBe(true);
  });

  it("clears once the cooldown has fully elapsed", () => {
    const justOutside = new Date(NOW - (REMOVE_COOLDOWN_MS + 1000)).toISOString();
    expect(inRemovalCooldown([record(justOutside)], NOW)).toBe(false);
  });

  it("only looks at the most recent removal", () => {
    expect(inRemovalCooldown([record(daysAgo(10)), record(hoursAgo(1))], NOW)).toBe(true);
  });
});

describe("isFlapLimited", () => {
  it("is false below the flap limit", () => {
    const history = Array.from({ length: FLAP_LIMIT - 1 }, () => record(daysAgo(1)));
    expect(isFlapLimited(history, NOW)).toBe(false);
  });

  it("trips once the flap limit is reached within the window", () => {
    const history = Array.from({ length: FLAP_LIMIT }, () => record(daysAgo(1)));
    expect(isFlapLimited(history, NOW)).toBe(true);
  });

  it("never counts removals that have aged out of the rolling window", () => {
    const history = Array.from({ length: FLAP_LIMIT + 2 }, () => record(daysAgo(45)));
    expect(isFlapLimited(history, NOW)).toBe(false);
  });

  it("counts only the removals still inside the window when history spans the boundary", () => {
    const history = [record(daysAgo(45)), record(daysAgo(45)), record(daysAgo(1)), record(daysAgo(1))];
    expect(isFlapLimited(history, NOW)).toBe(false);
  });
});

describe("isAutoReAddBlocked", () => {
  it("allows re-add with no removal history at all", () => {
    expect(isAutoReAddBlocked({}, NOW)).toBe(false);
  });

  it("blocks during the post-removal cooldown even with only one removal ever", () => {
    expect(isAutoReAddBlocked({ removalHistory: [record(hoursAgo(1))] }, NOW)).toBe(true);
  });

  it("blocks once flap-limited even outside the cooldown window", () => {
    const history = Array.from({ length: FLAP_LIMIT }, () => record(daysAgo(2)));
    expect(isAutoReAddBlocked({ removalHistory: history }, NOW)).toBe(true);
  });

  it("allows re-add for a single old removal well outside both cooldown and flap window", () => {
    expect(isAutoReAddBlocked({ removalHistory: [record(daysAgo(10))] }, NOW)).toBe(false);
  });
});


describe("auto-add deferral", () => {
  const T0 = new Date("2026-09-18T12:00:00Z").getTime();

  it("is not deferred without a marker", () => {
    expect(isAutoAddDeferred({}, T0)).toBe(false);
  });

  it("is deferred until the marker time, then eligible again", () => {
    const until = autoAddDeferredUntil(T0);
    expect(new Date(until).getTime() - T0).toBe(AUTO_ADD_DEFER_MS);
    expect(isAutoAddDeferred({ autoAddDeferredUntil: until }, T0 + AUTO_ADD_DEFER_MS - 1)).toBe(true);
    expect(isAutoAddDeferred({ autoAddDeferredUntil: until }, T0 + AUTO_ADD_DEFER_MS)).toBe(false);
  });

  it("ignores a malformed marker instead of blocking forever", () => {
    expect(isAutoAddDeferred({ autoAddDeferredUntil: "garbage" }, T0)).toBe(false);
    expect(isAutoAddDeferred({ autoAddDeferredUntil: 12345 }, T0)).toBe(false);
  });
});

describe("withRemoval", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  it("counts the several deployments of one model, removed together, as one event", () => {
    let history = withRemoval([], { at: at(0), reason: "5 consecutive failed health checks" });
    history = withRemoval(history, { at: at(2_000), reason: "5 consecutive failed health checks" });
    history = withRemoval(history, { at: at(4_000), reason: "5 consecutive failed health checks" });
    expect(history).toHaveLength(1);
    expect(isFlapLimited(history, NOW + 10_000)).toBe(false);          // a model in three lanes must not be flap-limited by one incident
  });
  it("counts removals further apart as separate events, so a model that keeps dying still hits the flap limit", () => {
    let history = withRemoval([], { at: at(0), reason: "r" });
    history = withRemoval(history, { at: at(SAME_REMOVAL_EVENT_MS + 1), reason: "r" });
    history = withRemoval(history, { at: at(2 * (SAME_REMOVAL_EVENT_MS + 1)), reason: "r" });
    expect(history).toHaveLength(FLAP_LIMIT);
    expect(isFlapLimited(history, NOW + 3 * SAME_REMOVAL_EVENT_MS)).toBe(true);
  });
  it("does not mutate the history it was given", () => {
    const history = [{ at: at(0), reason: "r" }];
    withRemoval(history, { at: at(1_000), reason: "r" });
    expect(history).toHaveLength(1);
  });
});
