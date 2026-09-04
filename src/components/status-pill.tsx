import { cn } from "@/lib/utils";

export function StatusPill({ value, dot = true }: { value: string; dot?: boolean }) {
  const tone = /healthy|active|passed|succeeded|verified|high/i.test(value) ? "good" : /degraded|warning|medium|pending|rate|unverified/i.test(value) ? "warn" : /failed|offline|critical|auth|unavailable/i.test(value) ? "bad" : "neutral";
  return <span className={cn("status-pill", `status-${tone}`)}>{dot && <i />} {value.replaceAll("_", " ")}</span>;
}
