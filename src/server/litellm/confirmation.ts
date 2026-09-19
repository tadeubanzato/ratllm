/** The exact phrase an operator must type to confirm a change to one deployment: the action, then the start of that deployment's
 *  own LiteLLM ID. Naming the ID (not the alias, which every member of a pool shares) is what makes it impossible to confirm
 *  a change against the wrong copy. */
export const ID_PREFIX_LENGTH = 8;

export function confirmationPhrase(action: "deactivate" | "reactivate" | "delete" | "adopt", litellmDeploymentId: string): string {
  return `${action.toUpperCase()} ${litellmDeploymentId.slice(0, ID_PREFIX_LENGTH)}`;
}
