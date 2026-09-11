import { cn } from "@/lib/utils";

export function StatusPill({ value, dot = true }: { value: string; dot?: boolean }) {
  const tone = /healthy|active|passed|succeeded|(?<!un)verified|high|^configured$/i.test(value) ? "good" : /degraded|warning|medium|pending|rate|unverified|stale|not[_ ]tested|not[_ ]configured/i.test(value) ? "warn" : /failed|offline|critical|auth|unavailable|missing|invalid|rejected/i.test(value) ? "bad" : "neutral";
  return <span className={cn("status-pill", `status-${tone}`)}>{dot && <i />} {value.replaceAll("_", " ")}</span>;
}
