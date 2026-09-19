/**
 * Which environment is this process running in, and which database is it looking at?
 *
 * The recurring operational failure was silent: a workstation build showed an empty but healthy-looking app because it was
 * pointed at its own empty database while the real data lived on the server. Nothing said which database the page was
 * showing. This describes the environment safely (never any credential) so the UI can say it, and flags combinations that can
 * only be a mistake.
 *
 * Pure and dependency-free, so it is unit-testable.
 */

export type DeploymentMode = "server" | "workstation-remote" | "demo";

const MODES: readonly DeploymentMode[] = ["server", "workstation-remote", "demo"];

/** The compose service name of the bundled database container. */
export const LOCAL_DATABASE_HOST = "curator-db";

export interface DeploymentInfo {
  mode: DeploymentMode;
  /** Host, port and database name only — the URL's user and password are never read into this. */
  databaseHost: string | null;
  databasePort: number | null;
  databaseName: string | null;
  /** True when DATABASE_URL points at the bundled database container. */
  databaseIsLocalContainer: boolean;
}

export function describeDeployment(env: Readonly<Record<string, string | undefined>>): DeploymentInfo {
  const requested = env.RATLLM_DEPLOYMENT_MODE?.trim() as DeploymentMode | undefined;
  const mode: DeploymentMode = env.DEMO_MODE === "true" ? "demo" : requested && MODES.includes(requested) ? requested : "server";
  let host: string | null = null, port: number | null = null, name: string | null = null;
  try {
    if (env.DATABASE_URL) {
      const url = new URL(env.DATABASE_URL);
      host = url.hostname || null;
      port = url.port ? Number(url.port) : 5432;
      name = url.pathname.replace(/^\//, "") || null;
    }
  } catch { /* an unparseable URL reads as "no database configured" below */ }
  return { mode, databaseHost: host, databasePort: port, databaseName: name, databaseIsLocalContainer: host === LOCAL_DATABASE_HOST };
}

export interface DeploymentProblem { severity: "degraded" | "info"; message: string }

export function deploymentProblems(info: DeploymentInfo): DeploymentProblem[] {
  if (info.mode === "demo") return [];
  const problems: DeploymentProblem[] = [];
  if (!info.databaseHost) problems.push({ severity: "degraded", message: "DATABASE_URL is missing or not a valid URL." });
  if (info.mode === "workstation-remote" && info.databaseIsLocalContainer) {
    problems.push({ severity: "degraded", message: `This is a workstation in remote mode, but DATABASE_URL points at the local database container (${LOCAL_DATABASE_HOST}). It would show an empty database instead of the server's data. Point DATABASE_URL at the server.` });
  }
  if (info.mode === "server" && info.databaseHost && !info.databaseIsLocalContainer && info.databaseHost !== "localhost" && info.databaseHost !== "127.0.0.1") {
    problems.push({ severity: "info", message: `Server mode with the database on another host (${info.databaseHost}). Make sure only one worker runs against it, or scheduled jobs will run twice.` });
  }
  return problems;
}

/** A worker owns scheduling for one database. On a workstation in remote mode the server's worker already does, and a second
 *  one would run every job twice against the same data. */
export function workerRefusal(info: DeploymentInfo): string | null {
  return info.mode === "workstation-remote"
    ? "Refusing to start the worker: this is a workstation in remote mode, and the server already runs the scheduler for this database. Running a second worker would run every job twice."
    : null;
}

/** "Environment: server · database curator-db:5432/curator" — safe to show to anyone. */
export function deploymentSummary(info: DeploymentInfo): string {
  if (info.mode === "demo") return "Demo mode — sample data, no database";
  const where = info.databaseHost ? `${info.databaseHost}${info.databasePort && info.databasePort !== 5432 ? `:${info.databasePort}` : ""}${info.databaseName ? `/${info.databaseName}` : ""}` : "no database configured";
  return `${info.mode} · database ${where}${info.databaseIsLocalContainer ? " (local container)" : ""}`;
}
