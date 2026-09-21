import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { navGroups, navItems } from "../src/components/icons";

const labels = (group: number) => navGroups[group].items.map(item => item[0]);

describe("the sidebar menu", () => {
  it("keeps RatLLM's own pages on top, LiteLLM's under their own heading, then Settings and About", () => {
    expect(navGroups.map(group => group.label ?? null)).toEqual([null, "LiteLLM", null]);
    expect(labels(0)).toEqual(["Overview", "Providers", "Discovered Models", "Automation Runs"]);
    expect(labels(1)).toEqual(["LiteLLM", "Lanes", "Performance"]);
    expect(labels(2)).toEqual(["Settings", "About"]);
  });

  it("calls the runs page Automation Runs, still at /runs", () => {
    const runs = navItems.find(item => item[1] === "/runs")!;
    expect(runs[0]).toBe("Automation Runs");
  });

  it("links every page exactly once, and every link is a real page", () => {
    const hrefs = navItems.map(item => item[1]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(existsSync(join(__dirname, "../src/app", href === "/" ? "" : href, "page.tsx")), href).toBe(true);
  });

  it("still exposes a flat list for anything that wants one", () => {
    expect(navItems).toHaveLength(navGroups.flatMap(group => group.items).length);
  });
});
