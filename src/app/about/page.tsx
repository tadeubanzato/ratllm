import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { LANE_IDS, type LaneId } from "@/lib/constants";
import { LANE_FALLBACKS } from "@/server/lanes/rules";

export const dynamic = "force-dynamic";

const LANE_PURPOSES: Record<LaneId, string> = {
  "smart-general": "General-purpose chat models",
  "smart-coding": "Coding-focused models",
  "smart-agent": "Tool-calling / agentic models",
  "smart-deep": "Deep reasoning models",
  "smart-long": "Long-context models (200k+ tokens)",
  "smart-vision": "Vision-capable models",
  "smart-summary": "Small, fast summarization models",
  "smart-speech": "Speech / audio models",
};

export default function AboutPage() {
  return <PageShell title="About" eyebrow="What this is, page by page" showSearch={false}>
    <div className="about-page">

      <section className="panel">
        <div className="panel-header"><h3>What RatLLM is</h3></div>
        <div className="panel-body">
          <p>RatLLM is a self-hosted, open-source control plane for the model deployments you route through your own LiteLLM proxy. It exists as a personal engineering and study project: a place to add model providers and credentials that belong to you, keep track of what is actually deployed where, and measure how those deployments perform over time — latency, reliability, and rate-limit behavior — instead of guessing.</p>
          <p>You register credentials for the providers you use, point RatLLM at your own LiteLLM instance, and use the UI to add specific provider models into one or more <code>smart-*</code> LiteLLM model groups (&quot;lanes&quot;). From there, scheduled background jobs continuously test those deployments, learn their real-world rate limits, and keep the router&apos;s fallback chains up to date. RatLLM only ever manages deployments it created itself; anything else in your LiteLLM inventory is left untouched.</p>
          <p className="muted">RatLLM is not a commercial product and is not offered as a service. It carries no support commitment, subscription, or resale of any kind — see License &amp; disclaimer below.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h3>Pages</h3></div>
        <div className="panel-body">
          <dl className="about-list">
            <dt>Overview</dt>
            <dd>The dashboard: provider, lane, and deployment counts, health at a glance, recent scheduled activity, and anything currently flagged for attention.</dd>
            <dt>Providers</dt>
            <dd>Every provider you have configured, its credential and operational status, and a per-provider Availability history — each provider shows its own uptime, not one number shared across the page.</dd>
            <dt>Discovered Models</dt>
            <dd>Models found on a provider&apos;s catalog before they are added to LiteLLM. Add one into a lane once you are ready to route traffic to it and test it.</dd>
            <dt>Lanes</dt>
            <dd>The <code>smart-*</code> LiteLLM model groups (general, coding, agent, deep reasoning, long-context, vision, summary, speech) and which deployments currently back each one, with cross-lane fallback chains kept in sync automatically.</dd>
            <dt>Benchmarks</dt>
            <dd>Operational results from the automatic health probe for every deployment: pass/fail, latency, success rate over recent runs, latency percentiles, and time-to-first-token.</dd>
            <dt>Runs</dt>
            <dd>The execution log for every scheduled and manually triggered job — discovery, credential verification, health checks, rate-limit learning, lane reconciliation, and maintenance.</dd>
            <dt>LiteLLM</dt>
            <dd>The connection to your LiteLLM proxy. Sync inventory, run a smoke test against any deployment, and see which deployments RatLLM manages versus which it leaves alone.</dd>
            <dt>Settings</dt>
            <dd>Environment information, provider credentials, the LiteLLM connection, automation schedules, model sources, and API access.</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h3>How the LiteLLM setup works</h3></div>
        <div className="panel-body">
          <p>Every model you add goes into one or more <code>smart-*</code> lanes in LiteLLM — a lane is just a named group of interchangeable deployments (LiteLLM load-balances across everything in it). On top of that, RatLLM declares a cross-lane <strong>fallback strategy</strong>: if a lane has no healthy deployments left, LiteLLM automatically retries the request against the lanes listed for it below, in order, so one empty lane doesn&apos;t fail a request outright.</p>
          <div className="settings-table-wrap" style={{marginTop: 10}}>
            <table className="data-table settings-table">
              <thead><tr><th>Lane</th><th>Purpose</th><th>Falls back to</th></tr></thead>
              <tbody>{LANE_IDS.map(slug => <tr key={slug}>
                <td className="mono">{slug}</td>
                <td>{LANE_PURPOSES[slug]}</td>
                <td>{(LANE_FALLBACKS.general[slug] ?? []).map(f => f.replace("smart-", "")).join(" → ") || "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p style={{marginTop: 12}}>This lane and fallback layout is fixed by RatLLM (it&apos;s what the lane-eligibility rules and the LANE_RECONCILE job both converge everything toward) — there&apos;s nothing to design yourself. Settings → LiteLLM has an <strong>Auto setup</strong> button that pushes this exact configuration to your LiteLLM instance immediately, instead of waiting for the next scheduled reconcile. It needs the LiteLLM master key configured there first.</p>
          <Link className="button primary" href="/settings?tab=LiteLLM" style={{marginTop: 4, display: "inline-flex"}}>Go to LiteLLM settings →</Link>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h3>Metrics &amp; status values</h3></div>
        <div className="panel-body">
          <dl className="about-list">
            <dt>Health</dt>
            <dd>HEALTHY / DEGRADED / RATE_LIMITED / AUTH_ERROR / UNAVAILABLE / NOT RUN — the outcome of the most recent probe against a deployment.</dd>
            <dt>Confidence</dt>
            <dd>UNKNOWN / LOW / MEDIUM / HIGH — how much smoke-test evidence currently backs a rate-limit estimate.</dd>
            <dt>Published / Observed / Safe (RPM &amp; TPM)</dt>
            <dd>Published is whatever a provider or LiteLLM itself reports. Observed is learned automatically from recent non-429 smoke-test volume. Safe applies a conservative margin (70% of observed) so lane routing does not chase the actual limit.</dd>
            <dt>Success rate</dt>
            <dd>The percentage of a deployment&apos;s most recent smoke tests that returned a real, non-empty response.</dd>
            <dt>p50 / p95 latency</dt>
            <dd>The median and 95th-percentile response time across a deployment&apos;s recent smoke tests. p95 describes worst-case behavior, not just the typical case.</dd>
            <dt>Time to first token</dt>
            <dd>How long a streamed completion took to produce its first chunk — a proxy for perceived responsiveness, separate from total latency.</dd>
            <dt>Availability / Uptime %</dt>
            <dd>The share of recent checks that succeeded, shown as a compact history strip plus a percentage, computed per provider or per candidate model.</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h3>Open source, personal &amp; educational project</h3></div>
        <div className="panel-body">
          <p>RatLLM is released as open-source software for personal use, learning, and evaluation. It is a study project built to understand model-routing infrastructure, and it is not operated as a commercial product or paid service by its author. There is no monetization, subscription, or resale associated with this software.</p>
          <p>RatLLM does not select, rank, or restrict providers or models by any commercial criteria. It is designed to let you add whichever model providers and credentials are yours to use, so you can compare their real-world performance side by side, in your own environment, under your own control.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h3>License &amp; disclaimer</h3></div>
        <div className="panel-body">
          <p>RatLLM is provided under the MIT License (see <code>LICENSE</code> in the repository). It is provided &quot;AS IS&quot;, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. The author accepts no liability for any claim, damages, or other liability arising from its use.</p>
          <p>Using RatLLM means supplying your own credentials for third-party providers. You are solely responsible for complying with each provider&apos;s own terms of service and usage policies, and for any costs you incur — RatLLM stores and routes only the credentials you provide, and does not grant you access to any provider on your behalf.</p>
          <p>RatLLM is not affiliated with, endorsed by, or sponsored by LiteLLM or any model provider it can connect to. Provider and product names appearing in this software are used solely to identify the services it can integrate with, and all trademarks belong to their respective owners.</p>
          <p className="muted">This page is a plain-language summary, not legal advice. If you plan to use RatLLM beyond personal, non-commercial evaluation, consult your own counsel.</p>
        </div>
      </section>

    </div>
  </PageShell>;
}
