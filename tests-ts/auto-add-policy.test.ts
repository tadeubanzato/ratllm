import { describe, expect, it } from "vitest";
import { FLAP_LIMIT, REMOVE_COOLDOWN_MS, inRemovalCooldown, isAutoReAddBlocked, isFlapLimited, removalHistoryOf } from "../src/server/discovery/auto-add-policy";

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
