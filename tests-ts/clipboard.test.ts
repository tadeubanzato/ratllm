import { describe, expect, it } from "vitest";
import { copyToClipboard, type ClipboardEnv } from "../src/lib/clipboard";

const ID = "fba2d043-7b3d-4c1e-9a55-0d3f6a1b2c4e";

/** A fake page: records what the fallback textarea held when execCommand("copy") ran. */
function fakeDocument(execResult: boolean | "throw") {
  const events: string[] = []; let held = "";
  const area = { value: "", style: { cssText: "" }, setAttribute: () => undefined, select: () => { events.push("select"); }, setSelectionRange: () => undefined };
  const document: NonNullable<ClipboardEnv["document"]> = {
    createElement: () => area,
    body: { appendChild: () => { events.push("append"); }, removeChild: () => { events.push("remove"); } },
    execCommand: () => { held = area.value; if (execResult === "throw") throw new Error("blocked"); return execResult; },
  };
  return { document, events, copied: () => held };
}

describe("copyToClipboard", () => {
  it("uses the clipboard API on a secure page", async () => {
    let written = "";
    const ok = await copyToClipboard(ID, { isSecureContext: true, navigator: { clipboard: { writeText: async (text: string) => { written = text; } } } });
    expect(ok).toBe(true);
    expect(written).toBe(ID);
  });

  it("falls back to a hidden textarea on a plain-http page, where navigator.clipboard does not exist, and copies the FULL value", async () => {
    const page = fakeDocument(true);
    const ok = await copyToClipboard(ID, { isSecureContext: false, navigator: {}, document: page.document });
    expect(ok).toBe(true);
    expect(page.copied()).toBe(ID);
    expect(page.events).toEqual(["append", "select", "remove"]);           // and it cleans up after itself
  });

  it("falls back when the clipboard API exists but refuses", async () => {
    const page = fakeDocument(true);
    const ok = await copyToClipboard(ID, { isSecureContext: true, navigator: { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } }, document: page.document });
    expect(ok).toBe(true);
    expect(page.copied()).toBe(ID);
  });

  it("reports failure, never silence, when nothing can copy", async () => {
    expect(await copyToClipboard(ID, { isSecureContext: false, navigator: {}, document: fakeDocument(false).document })).toBe(false);
    expect(await copyToClipboard(ID, { isSecureContext: false, navigator: {}, document: fakeDocument("throw").document })).toBe(false);
    expect(await copyToClipboard(ID, {})).toBe(false);
  });

  it("still removes the textarea when copying throws", async () => {
    const page = fakeDocument("throw");
    await copyToClipboard(ID, { isSecureContext: false, document: page.document });
    expect(page.events.at(-1)).toBe("remove");
  });
});
