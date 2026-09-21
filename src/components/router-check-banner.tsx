import type { RouterCheck } from "@/server/litellm/router-check";

/** Says so when a page's list may not match the live LiteLLM router: either the router could not be reached, or it differs from what RatLLM last synced. */
export function RouterCheckBanner({ router }: { router: RouterCheck }) {
  if (!router.reachable) return <section className="panel" style={{ marginBottom: 14, borderColor: "var(--amber)" }}>
    <div className="panel-header"><h3>Could not reach LiteLLM</h3><span>showing RatLLM&apos;s last synced copy</span></div>
    <div className="panel-body"><p className="settings-help">This list is RatLLM&apos;s record of the router from its last successful sync, so anything added or changed in LiteLLM since then is not shown.</p></div>
  </section>;
  const { unknownToRatllm, goneFromRouter, stateDiffers, inSync } = router.parity;
  if (inSync) return null;
  const issues = [...unknownToRatllm, ...goneFromRouter, ...stateDiffers];
  return <section className="panel" style={{ marginBottom: 14, borderColor: "var(--amber)" }}>
    <div className="panel-header"><h3>This list is out of date with LiteLLM</h3><span>{issues.length} difference{issues.length === 1 ? "" : "s"}</span></div>
    <div className="panel-body">
      <p className="settings-help">The live router differs from RatLLM&apos;s copy. Press Sync inventory on the LiteLLM page to bring them together; until then these are not shown correctly:</p>
      <ul>{issues.map(issue => <li key={issue.deploymentId + issue.detail} className="settings-help"><strong>{issue.lane}</strong> <span className="mono">{issue.model}</span> ({issue.deploymentId.slice(0, 8)}) — {issue.detail}</li>)}</ul>
    </div>
  </section>;
}
