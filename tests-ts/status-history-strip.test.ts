import { describe, expect, it } from "vitest";
import { stateFor } from "@/components/status-history-strip";
describe("StatusHistoryStrip severity normalization",()=>{it("maps isolated UI fixtures to every visible square color",()=>{expect(stateFor("SUCCEEDED")).toBe("success");expect(stateFor("available")).toBe("success");expect(stateFor("DEGRADED")).toBe("warning");expect(stateFor("429")).toBe("rate_limited");expect(stateFor("AUTH_ERROR")).toBe("failure");expect(stateFor("RUNNING")).toBe("running");expect(stateFor("SKIPPED")).toBe("unknown");});});
