import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";

type BadgeVariant = "soft" | "outline" | "ghost";
type BadgeSize = "xs" | "sm" | "md";

const helpByStatus: Record<string, string> = {
  HEALTHY: "The latest health probe succeeded.",
  VERIFIED: "The provider credential was tested successfully.",
  UNVERIFIED: "A credential is configured, but it has not passed verification yet.",
  "CONFIGURED · UNVERIFIED": "A credential is stored, but the provider has not accepted a verification request yet.",
  MISSING: "No usable credential or required configuration is available.",
  NOT_WIRED: "This integration is not connected to an executable adapter yet.",
  RATE_LIMITED: "The provider returned a rate limit response. This is not proof that the model is unavailable.",
  UNAVAILABLE: "The latest probe could not reach or use this deployment.",
  "NOT RUN": "No health probe has been recorded for this item yet.",
  READY: "The item has passed its current readiness checks.",
  LIVE: "The deployment is present in the active LiteLLM inventory.",
  "AUTO-REMOVED — RETRY PENDING": "This deployment was removed after repeated failures and is waiting for a recovery/retry policy.",
  "AUTO-REMOVED — NEEDS REVIEW": "This deployment was removed after repeated failures and needs operator review before it can return.",
};

export function StatusPill({ value, tooltip, variant = "soft", size = "sm" }: { value: string; tooltip?: string | null; variant?: BadgeVariant; size?: BadgeSize }) {
  const tone = /healthy|active|passed|succeeded|(?<!un)verified|high|^configured$/i.test(value) ? "good" : /degraded|warning|partial|deferred|blocked|medium|pending|rate|unverified|stale|not[_ ]tested|not[_ ]configured/i.test(value) ? "warn" : /failed|offline|critical|auth|unavailable|missing|invalid|rejected/i.test(value) ? "bad" : "neutral";
  const label = value.replaceAll("_", " ");
  const badge = <span className={cn("status-pill", `status-pill-${variant}`, `status-pill-${size}`, label.length > 18 && "status-pill-long", `status-${tone}`)}>{label}</span>;
  const description = tooltip === undefined ? helpByStatus[label.toUpperCase()] : tooltip;
  return description ? <Tooltip label={description}>{badge}</Tooltip> : badge;
}
