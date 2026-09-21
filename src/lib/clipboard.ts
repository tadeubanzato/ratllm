/** What the copy needs from the browser, injectable so the logic can be tested without one. */
export interface ClipboardEnv {
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
  isSecureContext?: boolean;
  document?: {
    createElement(tag: "textarea"): { value: string; style: { cssText: string }; setAttribute(name: string, value: string): void; select(): void; setSelectionRange(start: number, end: number): void };
    body: { appendChild(node: unknown): unknown; removeChild(node: unknown): unknown };
    execCommand(command: "copy"): boolean;
  };
}

/** Copies `text` and says whether it worked.
 *
 *  `navigator.clipboard` only exists on secure pages (https, or localhost). RatLLM is normally opened over plain http on a LAN name
 *  (http://okame.local:9090), which is NOT a secure context there, so the modern API is simply missing and the old code silently
 *  did nothing. The fallback selects a hidden textarea and uses `execCommand("copy")`, which works on any page from a click. */
export async function copyToClipboard(text: string, env: ClipboardEnv = typeof window === "undefined" ? {} : { navigator: window.navigator, isSecureContext: window.isSecureContext, document: window.document as unknown as ClipboardEnv["document"] }): Promise<boolean> {
  try {
    if (env.navigator?.clipboard && env.isSecureContext !== false) { await env.navigator.clipboard.writeText(text); return true; }
  } catch { /* denied or unavailable: fall through to the textarea route */ }
  const doc = env.document;
  if (!doc) return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  doc.body.appendChild(area);
  try { area.select(); area.setSelectionRange(0, text.length); return doc.execCommand("copy"); }
  catch { return false; }
  finally { doc.body.removeChild(area); }
}
