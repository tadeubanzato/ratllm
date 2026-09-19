import { describe, expect, it } from "vitest";
import { discoveryRunStatus } from "../src/server/discovery/run-status";

describe("discoveryRunStatus", () => {
  it("is SUCCEEDED when every source worked", () => {
    expect(discoveryRunStatus({ succeeded: 5, failed: 0, blocked: 0 })).toBe("SUCCEEDED");
  });
  it("is PARTIAL when some sources failed but others worked", () => {
    expect(discoveryRunStatus({ succeeded: 4, failed: 1, blocked: 0 })).toBe("PARTIAL");
  });
  it("is FAILED only when nothing worked", () => {
    expect(discoveryRunStatus({ succeeded: 0, failed: 3, blocked: 0 })).toBe("FAILED");
  });
  it("does not let a source waiting on a credential degrade an otherwise good run", () => {
    expect(discoveryRunStatus({ succeeded: 4, failed: 0, blocked: 3 })).toBe("SUCCEEDED");
  });
  it("calls a run where every source was blocked DEFERRED, not a success and not a failure", () => {
    expect(discoveryRunStatus({ succeeded: 0, failed: 0, blocked: 3 })).toBe("DEFERRED");
  });
  it("still reports PARTIAL for failures alongside blocked sources", () => {
    expect(discoveryRunStatus({ succeeded: 0, failed: 1, blocked: 2 })).toBe("PARTIAL");
  });
});
