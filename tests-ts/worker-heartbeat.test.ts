import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));

const { classifyHeartbeat, HEARTBEAT_STALE_MS } = await import("../src/server/worker-heartbeat");

const NOW = new Date("2026-09-18T12:00:00Z").getTime();

describe("classifyHeartbeat", () => {
  it("is absent when the worker never beat", () => {
    expect(classifyHeartbeat(null, NOW)).toEqual({ status: "absent", ageMs: null });
  });

  it("is alive within the stale window", () => {
    expect(classifyHeartbeat(new Date(NOW - 15_000), NOW).status).toBe("alive");
    expect(classifyHeartbeat(new Date(NOW - HEARTBEAT_STALE_MS), NOW).status).toBe("alive");
  });

  it("is stale past the window", () => {
    expect(classifyHeartbeat(new Date(NOW - HEARTBEAT_STALE_MS - 1), NOW).status).toBe("stale");
  });

  it("never reports a negative age for a clock-skewed future beat", () => {
    expect(classifyHeartbeat(new Date(NOW + 5_000), NOW).ageMs).toBe(0);
  });
});
