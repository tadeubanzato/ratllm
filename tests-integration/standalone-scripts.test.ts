import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { lanes, systemSettings } from "@/server/db/schema";

/**
 * The container starts with `pnpm db:migrate && pnpm db:seed && pnpm start`. The seed and migrate scripts run under plain tsx —
 * NOT inside Next — where a module that imports "server-only" throws, the && chain stops, and the app never starts.
 *
 * The rest of the test suite aliases "server-only" to a no-op, so it cannot see that class of bug. These tests run the scripts as
 * separate processes exactly as the container does, with no alias.
 */
const run = (script: string) => spawnSync("npx", ["tsx", script], { encoding: "utf8", env: { ...process.env }, timeout: 120_000 });

describe("the scripts the container runs on every start", () => {
  it("db:seed runs standalone, creates the lanes and the database identity, and is safe to run again", async () => {
    const first = run("src/server/db/seed.ts");
    expect(first.stderr).not.toMatch(/cannot be imported from a Client Component/);
    expect(first.status).toBe(0);
    const identity = (await getDb().select().from(systemSettings).where(eq(systemSettings.key, "deployment.identity")))[0];
    expect((identity.value as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getDb().select().from(lanes)).length).toBeGreaterThan(0);

    const second = run("src/server/db/seed.ts");                            // every restart seeds again
    expect(second.status).toBe(0);
    const after = (await getDb().select().from(systemSettings).where(eq(systemSettings.key, "deployment.identity")))[0];
    expect((after.value as { id: string }).id).toBe((identity.value as { id: string }).id);   // the identity does not change on restart
  });

  it("db:migrate runs standalone and is a no-op on an up-to-date database", () => {
    const result = run("src/server/db/migrate.ts");
    expect(result.stderr).not.toMatch(/cannot be imported from a Client Component/);
    expect(result.status).toBe(0);
  });
});
