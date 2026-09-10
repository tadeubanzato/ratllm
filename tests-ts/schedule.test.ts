import { describe, expect, it } from "vitest";
import { JOB_TYPES, defaultScheduleFor, nextCron } from "@/server/automation/schedule";
import { cronToSchedule, scheduleToCron } from "@/lib/schedule";

const MINUTE = 60_000;

describe("nextCron", () => {
  it("advances a */10 minute schedule to the next 10-minute boundary in the future", () => {
    const from = new Date("2026-09-10T23:23:00Z");
    const next = nextCron("*/10 * * * *", from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(10 * MINUTE);
    expect(next.getMinutes() % 10).toBe(0);
    expect(next.getSeconds()).toBe(0);
  });

  it("never returns the same minute it was given (always strictly next)", () => {
    const onBoundary = new Date("2026-09-10T23:30:00Z");
    expect(nextCron("*/10 * * * *", onBoundary).getTime()).toBe(onBoundary.getTime() + 10 * MINUTE);
  });

  it("advances an hourly schedule to the next top of the hour", () => {
    const from = new Date("2026-09-10T23:23:00Z");
    const next = nextCron("0 * * * *", from);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(60 * MINUTE);
  });

  it("honours a minute offset on an every-6-hours schedule", () => {
    const next = nextCron("15 */6 * * *", new Date("2026-09-10T05:00:00Z"));
    expect(next.getMinutes()).toBe(15);
    expect(next.getHours() % 6).toBe(0);
  });

  it("rejects malformed expressions", () => {
    expect(() => nextCron("not a cron")).toThrow();
    expect(() => nextCron("* * * *")).toThrow();
    expect(() => nextCron("*/0 * * * *")).toThrow();
  });

  it("produces a plausible next run for every code-default schedule", () => {
    for (const type of JOB_TYPES) {
      const next = nextCron(defaultScheduleFor(type));
      expect(next.getTime()).toBeGreaterThan(Date.now());
      // no default should be rarer than daily — a monitor parked days out is the bug this guards
      expect(next.getTime()).toBeLessThan(Date.now() + 25 * 60 * MINUTE);
    }
  });
});

describe("simple schedule <-> cron", () => {
  it("round-trips the interval forms the picker offers", () => {
    for (const [n, unit] of [[10, "MINUTE"], [1, "HOUR"], [6, "HOUR"], [1, "DAY"], [2, "DAY"]] as const) {
      const cron = scheduleToCron(n, unit);
      expect(cronToSchedule(cron)).toEqual({ n, unit });
      expect(() => nextCron(cron)).not.toThrow();
    }
  });

  it("falls back to raw cron for a fixed time of day the picker cannot represent", () => {
    expect(cronToSchedule("0 3 * * *")).toBeNull();
    expect(cronToSchedule("30 3 * * *")).toBeNull();
  });
});
