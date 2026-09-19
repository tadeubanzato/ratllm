/**
 * Decides whether an inventory sync may mark deployments missing from the router as REMOVED.
 *
 * A sync that comes back empty is far more likely to be a hiccup (router restarting, wrong master key, a proxy returning
 * `[]`, or items lacking a usable ID) than the operator deleting every model, and acting on it would flip every
 * deployment to REMOVED/UNAVAILABLE at once. So an empty result is only trusted when the previous real sync was empty
 * as well — a genuinely emptied router still converges after two syncs; a single bad response can't wipe live state.
 */
export function shouldApplyRemovals(input: { identifiedRemoteCount: number; liveLocalCount: number; previousIdentifiedRemoteCount: number | null }): { apply: boolean; reason?: "empty_inventory_unconfirmed" } {
  if (input.identifiedRemoteCount > 0) return { apply: true };
  if (input.liveLocalCount === 0) return { apply: true };                 // nothing to protect
  if (input.previousIdentifiedRemoteCount === 0) return { apply: true };  // second consecutive empty result: believe it
  return { apply: false, reason: "empty_inventory_unconfirmed" };
}
