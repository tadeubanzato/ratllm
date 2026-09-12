import { describe, expect, it } from "vitest";
import { healthFromSmokeResult, laneStatus } from "../src/server/status";

describe("lane status", () => {
  it("only reports healthy after the lane itself meets its assignment target", () => {
    expect(laneStatus({ enabled: true, healthy: 2, total: 2, minimumHealthy: 2 })).toBe("HEALTHY");
    expect(laneStatus({ enabled: true, healthy: 1, total: 3, minimumHealthy: 2 })).toBe("DEGRADED");
    expect(laneStatus({ enabled: true, healthy: 0, total: 0, minimumHealthy: 2 })).toBe("UNASSIGNED");
    expect(laneStatus({ enabled: false, healthy: 2, total: 2, minimumHealthy: 2 })).toBe("DISABLED");
  });
});

describe("smoke-test health", () => {
  it("preserves actionable provider failure states", () => {
    expect(healthFromSmokeResult(false, 429)).toBe("RATE_LIMITED");
    expect(healthFromSmokeResult(false, 401)).toBe("AUTH_ERROR");
    expect(healthFromSmokeResult(false, 503)).toBe("UNAVAILABLE");
    expect(healthFromSmokeResult(false, 410)).toBe("UNAVAILABLE");
    expect(healthFromSmokeResult(false, 404)).toBe("UNAVAILABLE");
    expect(healthFromSmokeResult(true, 200)).toBe("HEALTHY");
  });
});
