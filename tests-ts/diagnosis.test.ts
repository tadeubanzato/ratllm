import { describe, expect, it } from "vitest";
import { classifyFailure, diagnose, FAILING_MIN_CONSECUTIVE, type ProbeSample } from "../src/server/health/diagnosis";

const NOW = new Date("2026-09-19T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);
const pass = (h: number): ProbeSample => ({ at: hoursAgo(h), passed: true, httpStatus: 200, error: null });
const fail = (h: number, httpStatus: number | null = 500, error: string | null = null): ProbeSample => ({ at: hoursAgo(h), passed: false, httpStatus, error });

describe("classifyFailure", () => {
  it.each([
    [429, null, "rate_limited"], [503, null, "overloaded"], [500, null, "overloaded"], [401, null, "auth"], [403, null, "auth"], [404, null, "gone"], [410, null, "gone"],
    [null, "The operation was aborted due to timeout", "timeout"], [null, "request timed out", "timeout"], [400, null, "error"], [null, "ECONNRESET", "error"],
  ])("http %s / %s -> %s", (httpStatus, error, kind) => { expect(classifyFailure({ httpStatus, error }).kind).toBe(kind); });
});

describe("diagnose — the cases behind the live 'needs a decision' list", () => {
  it("calls a model that mostly passes but just timed out INTERMITTENT, and says no action is needed", () => {
    // Like nemotron-3.5-lightning: alternating passes and 30-second timeouts.
    const samples = [fail(0.5, null, "The operation was aborted due to timeout"), pass(2), fail(4, null, "The operation was aborted due to timeout"), pass(6), pass(8), pass(10)];
    const result = diagnose(samples, NOW);
    expect(result.verdict).toBe("intermittent");
    expect(result.kind).toBe("timeout");
    expect(result.recommendation).toMatch(/Intermittent: 67% of the last 6 checks passed/);
    expect(result.recommendation).toMatch(/No action needed/);
  });

  it("calls a rate-limited free-tier model intermittent when it passed recently", () => {
    const result = diagnose([fail(1, 429), fail(2, 429), fail(3, 503), pass(9), pass(10)], NOW);
    expect(result.verdict).toBe("intermittent");
    expect(result.kind).toBe("rate_limited");
  });

  it("is healthy when the latest check passed, however many failed before it", () => {
    const result = diagnose([pass(0.5), fail(1), fail(2), fail(3), fail(4), fail(5), fail(6)], NOW);
    expect(result.verdict).toBe("healthy");
    expect(result.consecutiveFailures).toBe(0);
  });

  it("only calls it FAILING after enough consecutive failures AND a full day with no pass", () => {
    const stuck = Array.from({ length: 8 }, (_, i) => fail(30 - i * 3, 500));           // failed every 3 hours for a day and a bit
    expect(diagnose([...stuck, pass(40)], NOW).verdict).toBe("failing");
    // Same run of failures, but it passed 5 hours ago: still intermittent.
    expect(diagnose([fail(1), fail(2), fail(3), fail(4), fail(4.5), fail(4.8), pass(5)], NOW).verdict).toBe("intermittent");
    // A day with no pass, but too few checks to be sure.
    expect(diagnose([fail(1), fail(2), pass(30)], NOW).verdict).toBe("intermittent");
    expect(FAILING_MIN_CONSECUTIVE).toBe(5);
  });

  it("says a retired model is safe to delete, with the date it started failing", () => {
    const result = diagnose(Array.from({ length: 6 }, (_, i) => fail(26 + i, 404)), NOW);
    expect(result.verdict).toBe("failing");
    expect(result.kind).toBe("gone");
    expect(result.recommendation).toMatch(/no longer exists upstream. Safe to delete/);
    expect(result.failingSince!.getTime()).toBe(hoursAgo(31).getTime());        // the OLDEST failure in the unbroken run
  });

  it("tells you to fix the key — not delete the model — when the provider rejects it", () => {
    const result = diagnose(Array.from({ length: 6 }, (_, i) => fail(26 + i, 401)), NOW);
    expect(result.kind).toBe("auth");
    expect(result.recommendation).toMatch(/Repair the key under Providers; deleting the model won't fix that/);
  });

  it("handles a model that has never passed and has no history", () => {
    expect(diagnose([], NOW)).toMatchObject({ verdict: "healthy", kind: "none" });
    const neverPassed = diagnose(Array.from({ length: 6 }, (_, i) => fail(i + 1, 500)), NOW);
    expect(neverPassed.verdict).toBe("failing");
    expect(neverPassed.lastPassAt).toBeNull();
  });

  it("counts the last 24 hours only for the pass rate", () => {
    const result = diagnose([fail(1), pass(2), pass(50), pass(60)], NOW);
    expect(result.probes24h).toBe(2);
    expect(result.passed24h).toBe(1);
  });
});
