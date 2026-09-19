import { describe, expect, it } from "vitest";
import { promotionRunStatus } from "../src/server/lanes/promotion-status";

describe("promotionRunStatus", () => {
  it("is SUCCEEDED when every target worked and the fallback chains were pushed", () => {
    expect(promotionRunStatus({ targetsFailed: 0, targetsTotal: 3, fallbackOk: true })).toEqual({ status: "SUCCEEDED", error: null });
  });
  it("is PARTIAL — not a success — when the targets worked but the fallback sync failed", () => {
    const result = promotionRunStatus({ targetsFailed: 0, targetsTotal: 2, fallbackOk: false });
    expect(result.status).toBe("PARTIAL");
    expect(result.error).toMatch(/fallback/i);
  });
  it("is PARTIAL when some targets failed, whatever the fallback did", () => {
    expect(promotionRunStatus({ targetsFailed: 1, targetsTotal: 3, fallbackOk: true }).status).toBe("PARTIAL");
    expect(promotionRunStatus({ targetsFailed: 1, targetsTotal: 3, fallbackOk: false }).status).toBe("PARTIAL");
  });
  it("is FAILED only when every target failed", () => {
    expect(promotionRunStatus({ targetsFailed: 3, targetsTotal: 3, fallbackOk: true }).status).toBe("FAILED");
  });
  it("counts a run with no targets as succeeded when the fallback is fine (nothing failed)", () => {
    expect(promotionRunStatus({ targetsFailed: 0, targetsTotal: 0, fallbackOk: true }).status).toBe("SUCCEEDED");
  });
});
