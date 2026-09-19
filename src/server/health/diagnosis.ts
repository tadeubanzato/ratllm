/**
 * Why is a deployment not serving, and does anyone need to do anything about it?
 *
 * A model's CURRENT health is one probe. A free-tier model that answers 85% of the time and times out or gets rate-limited the
 * rest looks "unavailable" whenever the latest probe lands on a bad one — but it needs no decision. What needs a decision is a
 * model that has stopped working. This separates the two from the recent probe history, and says what kind of failure it is,
 * because the right response differs: a retired model should be deleted, a rejected key repaired, an overloaded provider waited out.
 *
 * Pure and dependency-free, so it is unit-testable.
 */

export interface ProbeSample { at: Date; passed: boolean; httpStatus: number | null; error: string | null }

export type FailureKind = "none" | "rate_limited" | "overloaded" | "timeout" | "auth" | "gone" | "error";
export type Verdict = "healthy" | "intermittent" | "failing";

export interface Diagnosis {
  verdict: Verdict;
  kind: FailureKind;
  /** Plain-language description of the most recent failure. */
  label: string;
  probes24h: number;
  passed24h: number;
  lastPassAt: Date | null;
  consecutiveFailures: number;
  /** When the current unbroken run of failures began (the oldest failure since the last pass). */
  failingSince: Date | null;
  recommendation: string;
}

/** A run of failures with no pass in this long is "failing", not "intermittent". */
export const FAILING_AFTER_MS = 24 * 60 * 60_000;
/** ...and needs at least this many consecutive failures, so a quiet few hours can't trip it. */
export const FAILING_MIN_CONSECUTIVE = 5;
const DAY_MS = 24 * 60 * 60_000;

export function classifyFailure(sample: Pick<ProbeSample, "httpStatus" | "error">): { kind: FailureKind; label: string } {
  const { httpStatus, error } = sample;
  if (httpStatus === 429) return { kind: "rate_limited", label: "rate-limited by the provider (429)" };
  if (httpStatus === 401 || httpStatus === 403) return { kind: "auth", label: `the provider rejected the key (${httpStatus})` };
  if (httpStatus === 404 || httpStatus === 410) return { kind: "gone", label: `the model no longer exists upstream (${httpStatus})` };
  if (httpStatus !== null && httpStatus >= 500) return { kind: "overloaded", label: `the provider is overloaded or erroring (${httpStatus})` };
  if (httpStatus === null && /timeout|timed out|abort/i.test(error ?? "")) return { kind: "timeout", label: "timed out with no response" };
  return { kind: "error", label: httpStatus ? `returned an error (${httpStatus})` : "failed without a response" };
}

const percent = (passed: number, total: number) => `${Math.round((passed / total) * 100)}%`;
const ago = (ms: number) => ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / DAY_MS)} days`;

/** `samples` must be newest first. */
export function diagnose(samples: readonly ProbeSample[], now = Date.now()): Diagnosis {
  const recent = samples.filter(sample => now - sample.at.getTime() <= DAY_MS);
  const passed24h = recent.filter(sample => sample.passed).length;
  const lastPass = samples.find(sample => sample.passed) ?? null;

  let consecutiveFailures = 0;
  for (const sample of samples) { if (sample.passed) break; consecutiveFailures += 1; }
  const failures = samples.slice(0, consecutiveFailures);
  const failingSince = failures.length ? failures[failures.length - 1].at : null;

  const base = { probes24h: recent.length, passed24h, lastPassAt: lastPass?.at ?? null, consecutiveFailures, failingSince };
  if (!samples.length) return { ...base, verdict: "healthy", kind: "none", label: "no checks recorded yet", recommendation: "Nothing to act on yet." };
  if (samples[0].passed) return { ...base, verdict: "healthy", kind: "none", label: "passing", recommendation: "Nothing to do." };

  const { kind, label } = classifyFailure(samples[0]);
  const noPassFor = lastPass ? now - lastPass.at.getTime() : Infinity;
  const failing = consecutiveFailures >= FAILING_MIN_CONSECUTIVE && noPassFor >= FAILING_AFTER_MS;
  if (!failing) {
    const rate = recent.length ? `${percent(passed24h, recent.length)} of the last ${recent.length} checks passed` : "it has passed before";
    return { ...base, verdict: "intermittent", kind, label, recommendation: `Intermittent: ${rate}${lastPass ? `, last pass ${ago(now - lastPass.at.getTime())} ago` : ""}. The latest failure was ${label}. No action needed.` };
  }

  const since = failingSince ? ` since ${failingSince.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const recommendation =
    kind === "gone" ? `It has been failing${since} because the model no longer exists upstream. Safe to delete.`
    : kind === "auth" ? `It has been failing${since} because the provider rejects the key. Repair the key under Providers; deleting the model won't fix that.`
    : kind === "rate_limited" ? `It has been rate-limited${since} with no successful check. The quota may be exhausted or too small; check the provider's limits before deleting.`
    : `It has failed ${consecutiveFailures} checks in a row${since} (${label}). If it doesn't recover, deactivate or delete it.`;
  return { ...base, verdict: "failing", kind, label, recommendation };
}
