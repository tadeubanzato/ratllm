import { describe, expect, it } from "vitest";
import { deploymentProblems, deploymentSummary, describeDeployment, workerRefusal } from "../src/server/deployment-info";

const URL_LOCAL = "postgresql://curator:s3cr3t-password@curator-db:5432/curator";
const URL_SERVER = "postgresql://curator:s3cr3t-password@192.168.5.48:5432/curator";

describe("describeDeployment", () => {
  it("reads host, port and database name — and never the password or user", () => {
    const info = describeDeployment({ DATABASE_URL: URL_SERVER });
    expect(info).toEqual({ mode: "server", databaseHost: "192.168.5.48", databasePort: 5432, databaseName: "curator", databaseIsLocalContainer: false });
    expect(JSON.stringify(info)).not.toContain("s3cr3t");
    expect(JSON.stringify(info)).not.toContain("curator:");
    expect(deploymentSummary(info)).not.toContain("s3cr3t");
  });

  it("recognises the bundled database container", () => {
    expect(describeDeployment({ DATABASE_URL: URL_LOCAL }).databaseIsLocalContainer).toBe(true);
  });

  it("defaults to server mode, honours the explicit mode, and lets demo win", () => {
    expect(describeDeployment({ DATABASE_URL: URL_LOCAL }).mode).toBe("server");
    expect(describeDeployment({ DATABASE_URL: URL_SERVER, RATLLM_DEPLOYMENT_MODE: "workstation-remote" }).mode).toBe("workstation-remote");
    expect(describeDeployment({ DATABASE_URL: URL_LOCAL, RATLLM_DEPLOYMENT_MODE: "workstation-remote", DEMO_MODE: "true" }).mode).toBe("demo");
  });

  it("ignores an unknown mode instead of trusting it", () => {
    expect(describeDeployment({ DATABASE_URL: URL_LOCAL, RATLLM_DEPLOYMENT_MODE: "yolo" }).mode).toBe("server");
  });

  it("copes with a missing or malformed DATABASE_URL", () => {
    expect(describeDeployment({}).databaseHost).toBeNull();
    expect(describeDeployment({ DATABASE_URL: "not a url" }).databaseHost).toBeNull();
  });

  it("uses port 5432 when none is given, and shows a non-default port", () => {
    expect(describeDeployment({ DATABASE_URL: "postgresql://u:p@db.example/x" }).databasePort).toBe(5432);
    expect(deploymentSummary(describeDeployment({ DATABASE_URL: "postgresql://u:p@db.example:6543/x" }))).toContain("db.example:6543/x");
  });
});

describe("deploymentProblems", () => {
  it("is quiet for a normal server", () => {
    expect(deploymentProblems(describeDeployment({ DATABASE_URL: URL_LOCAL }))).toEqual([]);
  });

  it("flags a remote-mode workstation pointed at its own local database — the empty-but-healthy-looking app", () => {
    const problems = deploymentProblems(describeDeployment({ DATABASE_URL: URL_LOCAL, RATLLM_DEPLOYMENT_MODE: "workstation-remote" }));
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe("degraded");
    expect(problems[0].message).toMatch(/empty database instead of the server's data/);
  });

  it("is fine for a workstation in remote mode pointed at the server", () => {
    expect(deploymentProblems(describeDeployment({ DATABASE_URL: URL_SERVER, RATLLM_DEPLOYMENT_MODE: "workstation-remote" }))).toEqual([]);
  });

  it("notes, without alarming, a server whose database is on another host (two workers would double-run jobs)", () => {
    const problems = deploymentProblems(describeDeployment({ DATABASE_URL: URL_SERVER }));
    expect(problems).toEqual([{ severity: "info", message: expect.stringMatching(/only one worker/) }]);
  });

  it("reports a missing DATABASE_URL as a real problem", () => {
    expect(deploymentProblems(describeDeployment({}))[0].severity).toBe("degraded");
  });

  it("never nags in demo mode", () => {
    expect(deploymentProblems(describeDeployment({ DEMO_MODE: "true" }))).toEqual([]);
  });
});

describe("workerRefusal", () => {
  it("refuses a worker on a remote-mode workstation, where the server already owns scheduling", () => {
    expect(workerRefusal(describeDeployment({ DATABASE_URL: URL_SERVER, RATLLM_DEPLOYMENT_MODE: "workstation-remote" }))).toMatch(/second worker would run every job twice/);
  });
  it("allows a worker on a server", () => {
    expect(workerRefusal(describeDeployment({ DATABASE_URL: URL_LOCAL }))).toBeNull();
  });
});
