export function safeLimit(observed: number | null, safetyFactor = 0.7) {
  if (observed == null) return null;
  if (!Number.isInteger(observed) || observed < 0) throw new Error("Observed limit must be a non-negative integer");
  if (safetyFactor <= 0 || safetyFactor > 1) throw new Error("Safety factor must be greater than 0 and at most 1");
  return Math.floor(observed * safetyFactor);
}

export function effectiveLimit(input: { manual: number | null; documented: number | null; observed: number | null }, safetyFactor = 0.7) {
  if (input.manual != null) return { value: input.manual, source: "MANUAL" as const };
  if (input.documented != null) return { value: input.documented, source: "DOCUMENTED" as const };
  if (input.observed != null) return { value: safeLimit(input.observed, safetyFactor), source: "ESTIMATED" as const };
  return { value: null, source: "UNKNOWN" as const };
}
