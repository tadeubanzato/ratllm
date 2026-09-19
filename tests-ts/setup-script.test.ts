import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Runs the real scripts/setup.sh against a fake `docker`, `curl` and `sleep`, so each scenario can be checked without touching a
 * real Docker daemon or waiting a minute for a timeout.
 */

const VOLUME = "ratllm_curator-db-data";

function sandbox(files: { env?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ratllm-setup-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "docker"));
  mkdirSync(join(root, "bin"));
  copyFileSync("scripts/setup.sh", join(root, "scripts", "setup.sh"));
  copyFileSync(".env.example", join(root, ".env.example"));
  writeFileSync(join(root, "docker", "docker-compose.yml"), "services: {}\n");
  if (files.env !== undefined) writeFileSync(join(root, ".env"), files.env);

  const fake = (name: string, body: string) => { const path = join(root, "bin", name); writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`); chmodSync(path, 0o755); };
  fake("docker", `
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  info) exit 0;;
  volume)
    case "$2" in
      inspect) [ "$FAKE_VOLUME_EXISTS" = yes ] && exit 0 || exit 1;;
      create) echo "$3"; exit 0;;
    esac;;
  compose)
    for arg in "$@"; do case "$arg" in logs) printf '%s\\n' "$FAKE_WEB_LOG"; exit 0;; esac; done
    exit 0;;
esac
exit 0`);
  fake("curl", `[ "$FAKE_READY" = yes ] && exit 0 || exit 22`);
  fake("sleep", "exit 0");

  const run = (env: Record<string, string>) => {
    const result = spawnSync("bash", [join(root, "scripts", "setup.sh")], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FAKE_LOG: join(root, "docker.log"), ...env } });
    const log = existsSync(join(root, "docker.log")) ? readFileSync(join(root, "docker.log"), "utf8") : "";
    return { status: result.status, out: `${result.stdout}\n${result.stderr}`, log, env: existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : null };
  };
  return { root, run };
}

describe("scripts/setup.sh", () => {
  it("passes a shell syntax check", () => {
    expect(spawnSync("bash", ["-n", "scripts/setup.sh"]).status).toBe(0);
  });

  it("on a fresh machine creates the external database volume BEFORE starting the stack, then generates unique secrets", () => {
    const result = sandbox().run({ FAKE_VOLUME_EXISTS: "no", FAKE_READY: "yes" });
    expect(result.status).toBe(0);
    const createAt = result.log.indexOf(`docker volume create ${VOLUME}`);
    const upAt = result.log.indexOf("up -d --build");
    expect(createAt).toBeGreaterThanOrEqual(0);           // Compose never creates an `external: true` volume, so `up` would fail without this
    expect(upAt).toBeGreaterThan(createAt);
    expect(result.env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{40}$/m);
    expect(result.env).toMatch(/^CREDENTIAL_ENCRYPTION_KEY=[0-9a-f]{64}$/m);
    // The secrets the script generates must not be left as placeholders (the LiteLLM and provider keys are the operator's to fill in).
    for (const name of ["POSTGRES_PASSWORD", "DATABASE_URL", "CREDENTIAL_ENCRYPTION_KEY", "INTERNAL_API_SECRET"]) expect(result.env!.match(new RegExp(`^${name}=.*$`, "m"))![0]).not.toContain("replace-with");
    expect(result.env!.match(/^DATABASE_URL=.*$/m)![0]).toContain(result.env!.match(/^POSTGRES_PASSWORD=(.*)$/m)![1]); // the URL uses the generated password
  });

  it("REFUSES when a database volume survives but .env is gone — a new password would never match the data", () => {
    const box = sandbox();
    const result = box.run({ FAKE_VOLUME_EXISTS: "yes", FAKE_READY: "yes" });
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/volume .* already exists, but there is no \.env/i);
    expect(result.out).toContain(`docker volume rm ${VOLUME}`);       // tells the operator exactly what the destructive option is
    expect(result.env).toBeNull();                                     // did not write a .env that can never work
    expect(result.log).not.toContain("up -d");                         // never started anything
    expect(result.log).not.toContain("volume create");
  });

  it("re-running with an existing .env and volume leaves .env untouched and creates nothing", () => {
    const original = "POSTGRES_PASSWORD=keep-me\nDATABASE_URL=postgresql://curator:keep-me@curator-db:5432/curator\n";
    const result = sandbox({ env: original }).run({ FAKE_VOLUME_EXISTS: "yes", FAKE_READY: "yes" });
    expect(result.status).toBe(0);
    expect(result.env).toBe(original);
    expect(result.log).not.toContain("volume create");
    expect(result.log).toContain("up -d --build");
  });

  it("recognises a database password mismatch and says so, instead of a generic timeout", () => {
    const result = sandbox({ env: "POSTGRES_PASSWORD=x\n" }).run({ FAKE_VOLUME_EXISTS: "yes", FAKE_READY: "no", FAKE_WEB_LOG: 'error: password authentication failed for user "curator"' });
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/password in \.env does not match/i);
    expect(result.out).toContain(`docker volume rm ${VOLUME}`);
  });

  it("shows the tail of the web log for any other startup failure", () => {
    const result = sandbox({ env: "POSTGRES_PASSWORD=x\n" }).run({ FAKE_VOLUME_EXISTS: "yes", FAKE_READY: "no", FAKE_WEB_LOG: "Error: something else entirely went wrong" });
    expect(result.status).toBe(1);
    expect(result.out).toContain("something else entirely went wrong");
    expect(result.out).not.toMatch(/password in \.env does not match/i);
  });

  it("points the operator at /api/status, since a green page is not the same as a working system", () => {
    const result = sandbox({ env: "POSTGRES_PASSWORD=x\n" }).run({ FAKE_VOLUME_EXISTS: "yes", FAKE_READY: "yes" });
    expect(result.out).toContain("/api/status");
    expect(result.out).toMatch(/degraded/i);
  });
});
