/**
 * Which health-check failures are evidence that a DEPLOYMENT is dead, and which say something else.
 *
 * Auto-removal acts on a streak of consecutive failed checks, so what counts toward that streak decides what gets deleted.
 * A failed check is only evidence about the deployment when nothing broader explains it:
 *
 *  - RATE_LIMITED: the provider answered. It's alive, just busy.
 *  - AUTH_ERROR: the provider rejected the *credential* (revoked, expired, wrong project). Every deployment made with that
 *    key fails identically while the models themselves are fine; deleting them would only punish the models for a key
 *    problem the operator has to fix. Surfaced as AUTH_ERROR health, never removed for it.
 *  - SYSTEMIC: the failure coincided with a router-wide or provider-wide incident (below), so it says nothing about this one
 *    deployment.
 *
 * Pure and dependency-free, so it is unit-testable in isolation.
 */

/** Written to a smoke test's `error_code` when its failure was part of a wider incident. */
export const SYSTEMIC = "SYSTEMIC";

/** Error codes that neither count toward a removal streak nor break one already building from genuine failures. */
export const NEUTRAL_ERROR_CODES: ReadonlySet<string> = new Set(["RATE_LIMITED", "AUTH_ERROR", SYSTEMIC]);

/** A run needs at least this many probes, and this share failing, before it is judged a router-wide incident. */
export const ROUTER_MIN_PROBES = 6;
export const ROUTER_FAILURE_RATIO = 0.6;
/** A provider needs at least this many probes in a run, ALL failing, before it is judged a provider-wide incident. */
export const PROVIDER_MIN_PROBES = 3;
/**
 * Systemic protection only shields a deployment that passed a check recently. Without a limit, a provider that retires all
 * of its models at once would look like a permanent "incident" and its dead deployments would never be removed. After this
 * long without a single pass, failures count again and the normal streak removes them.
 */
export const SYSTEMIC_GRACE_MS = 24 * 60 * 60_000;

export interface RunProbe {
  deploymentId: string;
  providerSlug: string;
  ok: boolean;
  /** 0 means no HTTP response at all (the router itself could not be reached). */
  httpStatus: number;
  /** The health category the monitor recorded: HEALTHY, AUTH_ERROR, RATE_LIMITED, UNAVAILABLE, DEGRADED. */
  errorCode: string;
  lastPassedAt: Date | null;
}

export type Incident =
  | { scope: "router"; reason: "unreachable" | "widespread"; failed: number; probed: number }
  | { scope: "provider"; provider: string; failed: number; probed: number };

/** A failure that WOULD count toward removal: not ok, and not one of the neutral categories. */
const countsTowardRemoval = (probe: RunProbe) => !probe.ok && !NEUTRAL_ERROR_CODES.has(probe.errorCode);

/**
 * Decides which failures in one health-check run were part of a wider incident and so must not count toward removal.
 * Returns the deployment ids to neutralize, and the incidents that justified it (for logging and the audit trail).
 */
export function detectSystemicFailures(probes: readonly RunProbe[], now = Date.now()): { deploymentIds: Set<string>; incidents: Incident[] } {
  const incidents: Incident[] = [];
  const flagged = new Set<string>();
  const shielded = (probe: RunProbe) => probe.lastPassedAt !== null && now - probe.lastPassedAt.getTime() <= SYSTEMIC_GRACE_MS;
  const flag = (matching: RunProbe[]) => { for (const probe of matching) if (countsTowardRemoval(probe) && shielded(probe)) flagged.add(probe.deploymentId); };

  if (probes.length) {
    // No response from ANY probe: LiteLLM itself was unreachable, so nothing about any deployment was learned.
    if (probes.every(probe => probe.httpStatus === 0)) {
      incidents.push({ scope: "router", reason: "unreachable", failed: probes.length, probed: probes.length });
      flag([...probes]);
    } else {
      const failed = probes.filter(countsTowardRemoval).length;
      if (probes.length >= ROUTER_MIN_PROBES && failed / probes.length >= ROUTER_FAILURE_RATIO) {
        incidents.push({ scope: "router", reason: "widespread", failed, probed: probes.length });
        flag([...probes]);
      }
    }
  }

  const byProvider = new Map<string, RunProbe[]>();
  for (const probe of probes) byProvider.set(probe.providerSlug, [...(byProvider.get(probe.providerSlug) ?? []), probe]);
  for (const [provider, group] of byProvider) {
    if (group.length >= PROVIDER_MIN_PROBES && group.every(probe => !probe.ok)) {
      incidents.push({ scope: "provider", provider, failed: group.length, probed: group.length });
      flag(group);
    }
  }
  return { deploymentIds: flagged, incidents };
}
