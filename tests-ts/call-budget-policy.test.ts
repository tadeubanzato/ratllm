import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_CALL_BUDGET, dailyCallBudget, remainingCalls, remainingCandidateChecks } from "../src/server/providers/call-budget-policy";

describe("provider call budget", () => {
  it("gives OpenRouter a small allowance because its free models share 50 requests a day", () => {
    expect(dailyCallBudget("openrouter")).toBeLessThan(50);
  });
  it("never limits self-hosted providers", () => {
    expect(remainingCalls("local", 1_000_000)).toBeGreaterThan(1_000_000);
    expect(remainingCalls("lemonade", 5_000)).toBeGreaterThan(5_000);
  });
  it("uses the default for a provider with no special allowance", () => {
    expect(dailyCallBudget("groq")).toBe(DEFAULT_DAILY_CALL_BUDGET);
  });
  it("keeps part of the day back for health probes, so candidate checks stop first", () => {
    expect(remainingCandidateChecks("openrouter", 0)).toBe(14);
    expect(remainingCandidateChecks("openrouter", 14)).toBe(0);
    expect(remainingCalls("openrouter", 14)).toBe(10);
    expect(remainingCandidateChecks("local", 5_000)).toBeGreaterThan(0);
  });
  it("counts down and stops at zero, never going negative", () => {
    expect(remainingCalls("openrouter", 0)).toBe(24);
    expect(remainingCalls("openrouter", 10)).toBe(14);
    expect(remainingCalls("openrouter", 24)).toBe(0);
    expect(remainingCalls("openrouter", 803)).toBe(0);
    expect(remainingCalls("groq", -5)).toBe(DEFAULT_DAILY_CALL_BUDGET);
  });
});
