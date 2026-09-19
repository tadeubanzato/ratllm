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
    expect(next.getUTCMinutes() % 10).toBe(0);
    expect(next.getUTCSeconds()).toBe(0);
  });

  it("never returns the same minute it was given (always strictly next)", () => {
    const onBoundary = new Date("2026-09-10T23:30:00Z");
    expect(nextCron("*/10 * * * *", onBoundary).getTime()).toBe(onBoundary.getTime() + 10 * MINUTE);
  });

  it("advances an hourly schedule to the next top of the hour", () => {
    const from = new Date("2026-09-10T23:23:00Z");
    const next = nextCron("0 * * * *", from);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(60 * MINUTE);
  });

  it("honours a minute offset on an every-6-hours schedule", () => {
    const next = nextCron("15 */6 * * *", new Date("2026-09-10T05:00:00Z"));
    expect(next.getUTCMinutes()).toBe(15);
    expect(next.getUTCHours() % 6).toBe(0);
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

describe("nextCron time zones", () => {
  it("defaults to UTC regardless of the server's own zone", () => {
    expect(nextCron("0 3 * * *", new Date("2026-09-10T12:00:00Z")).toISOString()).toBe("2026-09-11T03:00:00.000Z");
  });

  it("evaluates fields in the requested IANA zone", () => {
    // 03:00 in Los Angeles during PDT (UTC-7) is 10:00Z.
    expect(nextCron("0 3 * * *", new Date("2026-09-10T12:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-09-11T10:00:00.000Z");
  });

  it("stays at 03:00 local across spring-forward (a 23-hour day, so the UTC gap shrinks)", () => {
    // 2026-03-08: LA jumps 02:00 -> 03:00. 03:00 PST on Mar 7 is 11:00Z; 03:00 PDT on Mar 8 is 10:00Z.
    expect(nextCron("0 3 * * *", new Date("2026-03-07T12:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-03-08T10:00:00.000Z");
  });

  it("skips a local time that doesn't exist on spring-forward day", () => {
    // 02:30 doesn't exist on 2026-03-08 in LA, so the next real 02:30 is Mar 9 (PDT, 09:30Z).
    expect(nextCron("30 2 * * *", new Date("2026-03-08T00:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-03-09T09:30:00.000Z");
  });

  it("stays at 03:00 local across fall-back (a 25-hour day)", () => {
    // 2026-11-01: LA falls back 02:00 -> 01:00. 03:00 PDT Oct 31 is 10:00Z; 03:00 PST Nov 1 is 11:00Z.
    expect(nextCron("0 3 * * *", new Date("2026-10-31T12:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-01T11:00:00.000Z");
  });

  it("matches the weekday in the requested zone, not UTC", () => {
    // Sunday 23:00 in LA on 2026-09-13 is Monday 06:00Z. "0 23 * * 0" (Sundays 23:00) must find that instant.
    expect(nextCron("0 23 * * 0", new Date("2026-09-12T00:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-09-14T06:00:00.000Z");
  });

  it("rejects an unknown zone", () => {
    expect(() => nextCron("0 * * * *", new Date(), "Mars/Olympus")).toThrow(/time zone/i);
  });
});
