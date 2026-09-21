import { describe, expect, it } from "vitest";
import { historyTimestamp } from "@/lib/utils";

/** Regression cover for the uptime-strip history queries: they read timestamps through a raw db.execute(), which
 *  skips drizzle's type parsers, so postgres-js hands back timestamptz wire text rather than a Date. Every bar's
 *  tooltip and ordering depends on that text becoming the right instant. */
describe("historyTimestamp", () => {
  it("parses postgres timestamptz wire text as the same instant", () => {
    expect(historyTimestamp("2026-09-20 13:20:13.099062+00").toISOString()).toBe("2026-09-20T13:20:13.099Z");
    expect(historyTimestamp("2026-09-05 01:38:13.905702+00").toISOString()).toBe("2026-09-05T01:38:13.905Z");
  });

  it("handles whole-second timestamps and non-UTC offsets", () => {
    expect(historyTimestamp("2026-09-20 13:20:13+00").toISOString()).toBe("2026-09-20T13:20:13.000Z");
    // +02 must shift back two hours, not be dropped as an unparsed suffix.
    expect(historyTimestamp("2026-09-20 15:20:13+02").toISOString()).toBe("2026-09-20T13:20:13.000Z");
  });

  it("passes a real Date straight through, so a builder-backed query is unaffected", () => {
    const date = new Date("2026-09-20T13:20:13.099Z");
    expect(historyTimestamp(date)).toBe(date);
  });

  it("preserves ordering, which is the contract StatusHistoryStrip relies on", () => {
    const newest = historyTimestamp("2026-09-20 13:20:13.099062+00");
    const older = historyTimestamp("2026-09-19 13:20:13.099062+00");
    expect(newest.getTime()).toBeGreaterThan(older.getTime());
  });

  it("already-ISO text still parses, so a driver that starts returning ISO is not a regression", () => {
    expect(historyTimestamp("2026-09-20T13:20:13.099Z").toISOString()).toBe("2026-09-20T13:20:13.099Z");
  });
});
