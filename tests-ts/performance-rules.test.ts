import { describe, expect, it } from "vitest";
import { buildPerformanceRows, comparePerformanceRows, COVERAGE_WINDOW_MS, summarizePerformance, type LatestProbe } from "../src/server/performance-rules";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const probe = (over: Partial<LatestProbe> = {}, agoMs = 60_000): LatestProbe => ({ status: "PASSED", httpStatus: 200, latencyMs: 400, error: null, createdAt: new Date(NOW - agoMs), ...over });
const stat = (successRate: number, p50LatencyMs: number | null = 500, avgFirstTokenMs: number | null = 200) => ({ successRate, p50LatencyMs, avgFirstTokenMs });

describe("buildPerformanceRows", () => {
  it("has one row per deployment, including ones never probed", () => {
    const rows = buildPerformanceRows([{ id: "a" }, { id: "b" }, { id: "c" }], new Map([["a", probe()]]), new Map([["a", stat(100)]]));
    expect(rows.map(row => row.d.id).sort()).toEqual(["a", "b", "c"]);
    expect(rows.find(row => row.d.id === "b")).toMatchObject({ t: null, displayStatus: "NOT_RUN", stat: null });
  });

  it("uses a deployment's own latest probe, however old it is", () => {
    const old = probe({}, 9 * 24 * 3_600_000);
    const [row] = buildPerformanceRows([{ id: "a" }], new Map([["a", old]]), new Map());
    expect(row.t).toBe(old);
    expect(row.displayStatus).toBe("HEALTHY");                        // not "NOT RUN": it was probed, just a while ago
  });

  it("reads what each probe means", () => {
    const rows = buildPerformanceRows([{ id: "ok" }, { id: "limited" }, { id: "down" }, { id: "auth" }],
      new Map([["ok", probe()], ["limited", probe({ status: "FAILED", httpStatus: 429 })], ["down", probe({ status: "FAILED", httpStatus: 500 })], ["auth", probe({ status: "FAILED", httpStatus: 401 })]]),
      new Map());
    const status = Object.fromEntries(rows.map(row => [row.d.id, row.displayStatus]));
    expect(status).toEqual({ ok: "HEALTHY", limited: "RATE_LIMITED", down: "UNAVAILABLE", auth: "AUTH_ERROR" });
  });

  it("ranks by success rate, then latency, then first token, with no stats last", () => {
    const rows = buildPerformanceRows([{ id: "none" }, { id: "slow" }, { id: "best" }, { id: "flaky" }, { id: "fast-ftt" }, { id: "slow-ftt" }],
      new Map(),
      new Map([["slow", stat(100, 900)], ["best", stat(100, 200)], ["flaky", stat(60, 100)], ["fast-ftt", stat(100, 500, 100)], ["slow-ftt", stat(100, 500, 900)]]));
    expect(rows.map(row => row.d.id)).toEqual(["best", "fast-ftt", "slow-ftt", "slow", "flaky", "none"]);
  });
});

describe("comparePerformanceRows", () => {
  it("puts a missing latency after a known one", () => {
    expect(comparePerformanceRows({ stat: stat(100, null) }, { stat: stat(100, 300) })).toBeGreaterThan(0);
    expect(comparePerformanceRows({ stat: stat(100, 300) }, { stat: stat(100, null) })).toBeLessThan(0);
  });
});

describe("summarizePerformance", () => {
  it("counts coverage from each deployment's own latest probe, over the last 24 hours", () => {
    const rows = buildPerformanceRows([{ id: "fresh" }, { id: "stale" }, { id: "never" }, { id: "failing" }],
      new Map([["fresh", probe()], ["stale", probe({}, COVERAGE_WINDOW_MS + 60_000)], ["failing", probe({ status: "FAILED", httpStatus: 500 })]]), new Map());
    expect(summarizePerformance(rows, NOW)).toEqual({ deployments: 4, checkedLast24h: 2, passed: 2, failed: 1, awaitingFirstProbe: 1 });
  });
});
