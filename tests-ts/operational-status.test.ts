import { describe, expect, it } from "vitest";
import { evaluateStatus, FRESHNESS_LIMITS_MS, type StatusInput } from "../src/server/operational-status-rules";

const NOW = new Date("2026-09-19T12:00:00Z").getTime();
const fresh = Object.fromEntries(Object.keys(FRESHNESS_LIMITS_MS).map(type => [type, NOW - 10 * 60_000])) as Record<string, number>;
const healthy = (): StatusInput => ({
  now: NOW,
  worker: { status: "alive", heartbeatAgeMs: 5000, overdueJobs: 0 },
  litellm: { status: "HEALTHY", lastSuccessAt: NOW - 60_000, error: null },
  lastSuccessAt: { ...fresh },
  failedRuns24h: {},
  credentials: { invalid: 0, unverified: 0 },
  fleet: { live: 68, notServing: 0, unmanagedNotServing: 0 },
});
const areas = (input: StatusInput) => evaluateStatus(input).reasons.filter(r => r.severity === "degraded").map(r => r.area);

describe("evaluateStatus", () => {
  it("is healthy with no reasons when everything is working", () => {
    expect(evaluateStatus(healthy())).toEqual({ status: "healthy", reasons: [] });
  });

  it("is degraded — never a generic green — when the worker is absent, stale, or behind", () => {
    expect(areas({ ...healthy(), worker: { status: "absent", heartbeatAgeMs: null, overdueJobs: 0 } })).toEqual(["worker"]);
    expect(areas({ ...healthy(), worker: null })).toEqual(["worker"]);
    expect(areas({ ...healthy(), worker: { status: "stale", heartbeatAgeMs: 600_000, overdueJobs: 0 } })).toEqual(["worker"]);
    expect(areas({ ...healthy(), worker: { status: "alive", heartbeatAgeMs: 1000, overdueJobs: 3 } })).toEqual(["worker"]);
  });

  it("is degraded when LiteLLM is unconfigured, unreachable, or has not answered for a while", () => {
    for (const status of ["NOT_CONFIGURED", "UNAVAILABLE"]) expect(areas({ ...healthy(), litellm: { status, lastSuccessAt: NOW - 60_000, error: null } })).toEqual(["litellm"]);
    expect(areas({ ...healthy(), litellm: null })).toEqual(["litellm"]);
    expect(areas({ ...healthy(), litellm: { status: "HEALTHY", lastSuccessAt: null, error: null } })).toEqual(["litellm"]);
    expect(areas({ ...healthy(), litellm: { status: "HEALTHY", lastSuccessAt: NOW - 3 * 3_600_000, error: null } })).toEqual(["litellm"]);
  });

  it("does NOT flag LiteLLM as a problem just because the connection's own STALE flag tripped between hourly checks", () => {
    for (const status of ["STALE", "NOT_TESTED", "HEALTHY"]) expect(evaluateStatus({ ...healthy(), litellm: { status, lastSuccessAt: NOW - 45 * 60_000, error: null } }).status).toBe("healthy");
  });

  it("flags data that has gone stale or has never been produced", () => {
    const stale = { ...healthy(), lastSuccessAt: { ...fresh, MODEL_DISCOVERY: NOW - 8 * 3_600_000 } };
    const result = evaluateStatus(stale);
    expect(result.status).toBe("degraded");
    expect(result.reasons[0].message).toMatch(/Model discovery last succeeded 8 h ago/);
    expect(areas({ ...healthy(), lastSuccessAt: { ...fresh, HEALTH_MONITOR: null } })).toEqual(["freshness"]);
  });

  it("does not flag data that is inside its schedule plus grace", () => {
    expect(evaluateStatus({ ...healthy(), lastSuccessAt: { ...fresh, MODEL_DISCOVERY: NOW - 6 * 3_600_000 } }).status).toBe("healthy");
  });

  it("reports recent job failures and invalid credentials", () => {
    expect(areas({ ...healthy(), failedRuns24h: { HEALTH_MONITOR: 2 } })).toEqual(["runs"]);
    expect(areas({ ...healthy(), credentials: { invalid: 2, unverified: 0 } })).toEqual(["credentials"]);
  });

  it("treats unverified credentials and non-serving models as information, not degradation", () => {
    const result = evaluateStatus({ ...healthy(), credentials: { invalid: 0, unverified: 3 }, fleet: { live: 68, notServing: 5, unmanagedNotServing: 4 } });
    expect(result.status).toBe("healthy");
    expect(result.reasons.map(r => r.severity)).toEqual(["info", "info"]);
    expect(result.reasons[1].message).toMatch(/5 of 68 live deployments are not serving \(4 not managed by RatLLM\)/);
  });

  it("is degraded when there are no live deployments at all (inventory never synced)", () => {
    expect(areas({ ...healthy(), fleet: { live: 0, notServing: 0, unmanagedNotServing: 0 } })).toEqual(["fleet"]);
  });

  it("collects every problem, not just the first", () => {
    const broken: StatusInput = { ...healthy(), worker: null, litellm: { status: "UNAVAILABLE", lastSuccessAt: null, error: "timeout" }, failedRuns24h: { MODEL_DISCOVERY: 1 } };
    expect(areas(broken).sort()).toEqual(["litellm", "runs", "worker"]);
  });

  it("turns environment problems into reasons, so a workstation pointed at the wrong database shows as degraded", () => {
    const wrong = { ...healthy(), deployment: { problems: [{ severity: "degraded" as const, message: "This is a workstation in remote mode, but DATABASE_URL points at the local database container." }] } };
    const result = evaluateStatus(wrong);
    expect(result.status).toBe("degraded");
    expect(result.reasons.find(reason => reason.area === "deployment")?.message).toMatch(/workstation in remote mode/);
    expect(evaluateStatus({ ...healthy(), deployment: { problems: [{ severity: "info" as const, message: "note" }] } }).status).toBe("healthy");
  });
});
