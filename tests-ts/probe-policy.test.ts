import { describe, expect, it } from "vitest";
import { PROVIDER_MIN_PROBES, ROUTER_MIN_PROBES, SYSTEMIC, SYSTEMIC_GRACE_MS, detectSystemicFailures, type RunProbe } from "../src/server/health/probe-policy";
import { AUTO_REMOVE_AFTER_FAILURES, computeFailureStreak } from "../src/server/health/failure-streak";

const NOW = new Date("2026-09-19T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000);

const probe = (id: string, over: Partial<RunProbe> = {}): RunProbe =>
  ({ deploymentId: id, providerSlug: `provider-${id}`, ok: true, httpStatus: 200, errorCode: "HEALTHY", lastPassedAt: hoursAgo(1), ...over });
const failing = (id: string, over: Partial<RunProbe> = {}) => probe(id, { ok: false, httpStatus: 500, errorCode: "UNAVAILABLE", ...over });
const ids = (result: ReturnType<typeof detectSystemicFailures>) => [...result.deploymentIds].sort();

describe("detectSystemicFailures — router level", () => {
  it("treats a run where NO probe got any HTTP response as the router being unreachable", () => {
    const result = detectSystemicFailures([failing("a", { httpStatus: 0 }), failing("b", { httpStatus: 0 })], NOW);
    expect(result.incidents).toEqual([{ scope: "router", reason: "unreachable", failed: 2, probed: 2 }]);
    expect(ids(result)).toEqual(["a", "b"]);
  });

  it("treats a large share of the fleet failing together as a widespread incident", () => {
    const run = [...Array.from({ length: 7 }, (_, i) => failing(`f${i}`)), ...Array.from({ length: 3 }, (_, i) => probe(`ok${i}`))];
    const result = detectSystemicFailures(run, NOW);
    expect(result.incidents).toContainEqual({ scope: "router", reason: "widespread", failed: 7, probed: 10 });
    expect(ids(result)).toEqual(Array.from({ length: 7 }, (_, i) => `f${i}`).sort());
  });

  it("does not call it an incident just below the failure ratio", () => {
    const run = [...Array.from({ length: 5 }, (_, i) => failing(`f${i}`)), ...Array.from({ length: 5 }, (_, i) => probe(`ok${i}`))]; // 50% < 60%
    expect(detectSystemicFailures(run, NOW).deploymentIds.size).toBe(0);
  });

  it("needs a minimum number of probes: a tiny run isn't proof of an incident", () => {
    const run = Array.from({ length: ROUTER_MIN_PROBES - 1 }, (_, i) => failing(`f${i}`)); // every one failing, but too few, each its own provider
    expect(detectSystemicFailures(run, NOW).incidents.filter(incident => incident.scope === "router")).toEqual([]);
  });

  it("a single genuinely broken deployment among healthy ones is NOT systemic", () => {
    const run = [failing("broken"), ...Array.from({ length: 9 }, (_, i) => probe(`ok${i}`))];
    expect(detectSystemicFailures(run, NOW).deploymentIds.size).toBe(0);
  });

  it("returns nothing for an empty run", () => {
    expect(detectSystemicFailures([], NOW)).toEqual({ deploymentIds: new Set(), incidents: [] });
  });
});

describe("detectSystemicFailures — provider level", () => {
  const sameProvider = (id: string, over: Partial<RunProbe> = {}) => failing(id, { providerSlug: "groq", ...over });

  it("shields a provider whose every deployment in the run failed, and only that provider", () => {
    const run = [sameProvider("g1"), sameProvider("g2"), sameProvider("g3"), probe("c1", { providerSlug: "cerebras" }), probe("c2", { providerSlug: "cerebras" })];
    const result = detectSystemicFailures(run, NOW);
    expect(result.incidents).toEqual([{ scope: "provider", provider: "groq", failed: 3, probed: 3 }]);
    expect(ids(result)).toEqual(["g1", "g2", "g3"]);
  });

  it("does not shield a provider where even one deployment passed — that one proves the provider works", () => {
    const run = [sameProvider("g1"), sameProvider("g2"), probe("g3", { providerSlug: "groq" })];
    expect(detectSystemicFailures(run, NOW).deploymentIds.size).toBe(0);
  });

  it("needs a minimum number of probes for that provider", () => {
    const run = Array.from({ length: PROVIDER_MIN_PROBES - 1 }, (_, i) => sameProvider(`g${i}`));
    expect(detectSystemicFailures(run, NOW).deploymentIds.size).toBe(0);
  });

  it("counts rate limits among a provider's failures as part of the same outage, but only shields the counting ones", () => {
    const run = [sameProvider("g1"), sameProvider("g2", { httpStatus: 429, errorCode: "RATE_LIMITED" }), sameProvider("g3")];
    const result = detectSystemicFailures(run, NOW);
    expect(result.incidents).toHaveLength(1);
    expect(ids(result)).toEqual(["g1", "g3"]); // the 429 was never going to count anyway
  });
});

describe("detectSystemicFailures — the shield expires (so a provider that retires everything is not protected forever)", () => {
  const run = (lastPassedAt: Date | null) => [failing("a", { providerSlug: "x", lastPassedAt }), failing("b", { providerSlug: "x", lastPassedAt }), failing("c", { providerSlug: "x", lastPassedAt })];

  it("shields a deployment that passed within the grace window", () => {
    expect(detectSystemicFailures(run(hoursAgo(2)), NOW).deploymentIds.size).toBe(3);
  });

  it("still shields right at the edge of the window", () => {
    expect(detectSystemicFailures(run(new Date(NOW - SYSTEMIC_GRACE_MS)), NOW).deploymentIds.size).toBe(3);
  });

  it("stops shielding once it has gone longer than the window without a single pass", () => {
    expect(detectSystemicFailures(run(new Date(NOW - SYSTEMIC_GRACE_MS - 1)), NOW).deploymentIds.size).toBe(0);
  });

  it("never shields a deployment that has never passed — there's no evidence it ever worked", () => {
    expect(detectSystemicFailures(run(null), NOW).deploymentIds.size).toBe(0);
  });
});

describe("computeFailureStreak with neutral error codes", () => {
  const row = (status: string, errorCode: string | null) => ({ status, errorCode });
  const genuine = row("FAILED", "UNAVAILABLE");

  it("does not let sustained auth errors build a removal streak (a revoked key must not delete healthy models)", () => {
    expect(computeFailureStreak(Array.from({ length: 12 }, () => row("FAILED", "AUTH_ERROR")))).toBe(0);
  });

  it("does not let failures recorded during an incident build a streak", () => {
    expect(computeFailureStreak(Array.from({ length: 12 }, () => row("FAILED", SYSTEMIC)))).toBe(0);
  });

  it("skips neutral rows without breaking a genuine streak spanning them", () => {
    expect(computeFailureStreak([genuine, row("FAILED", "AUTH_ERROR"), genuine, row("FAILED", SYSTEMIC), genuine, row("FAILED", "RATE_LIMITED"), genuine, genuine])).toBe(AUTO_REMOVE_AFTER_FAILURES);
  });

  it("a real failure streak still builds and removes, so genuine breakage is not shielded", () => {
    expect(computeFailureStreak(Array.from({ length: 5 }, () => genuine))).toBe(AUTO_REMOVE_AFTER_FAILURES);
  });

  it("a pass still resets the streak", () => {
    expect(computeFailureStreak([genuine, genuine, row("PASSED", "HEALTHY"), genuine, genuine, genuine])).toBe(2);
  });

  it("treats a null error code as a genuine failure, as before", () => {
    expect(computeFailureStreak([row("FAILED", null), row("FAILED", null)])).toBe(2);
  });
});
