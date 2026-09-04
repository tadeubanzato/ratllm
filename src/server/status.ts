export type LaneStatus = "HEALTHY" | "DEGRADED" | "UNASSIGNED" | "DISABLED";

/** A lane is healthy only when its own persisted assignments meet policy. */
export function laneStatus(input: {
  enabled: boolean;
  healthy: number;
  total: number;
  minimumHealthy: number;
}): LaneStatus {
  if (!input.enabled) return "DISABLED";
  if (input.healthy >= input.minimumHealthy) return "HEALTHY";
  if (input.total === 0) return "UNASSIGNED";
  return "DEGRADED";
}

export function healthFromSmokeResult(ok: boolean, httpStatus: number, latencyMs = 0, error?: string) {
  if (ok) return "HEALTHY" as const;
  if (httpStatus === 401 || httpStatus === 403) return "AUTH_ERROR" as const;
  if (httpStatus === 429) return "RATE_LIMITED" as const;
  if (httpStatus >= 500 || httpStatus === 0 || /timeout|connect|malformed/i.test(error ?? "")) return "UNAVAILABLE" as const;
  if (latencyMs > 10_000) return "DEGRADED" as const;
  return "DEGRADED" as const;
}
