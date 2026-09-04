import { describe, expect, it } from "vitest";
import { effectiveLimit, safeLimit } from "../src/server/rate-limits/policy";
describe("rate limit policy",()=>{
  it("floors observed limits with the safety margin",()=>expect(safeLimit(30,.7)).toBe(21));
  it("never overwrites a manual override",()=>expect(effectiveLimit({manual:11,documented:30,observed:40})).toEqual({value:11,source:"MANUAL"}));
  it("rejects unsafe factors",()=>expect(()=>safeLimit(30,1.1)).toThrow());
});
