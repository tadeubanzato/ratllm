import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("no partial-key masks in application code", () => {
  it("never builds a first/last-characters mask (e.g. sk-••••w0O), which would leak part of a key", () => {
    const offenders = sourceFiles("src").filter(file => readFileSync(file, "utf8").includes("••••"));
    expect(offenders).toEqual([]);
  });
});
