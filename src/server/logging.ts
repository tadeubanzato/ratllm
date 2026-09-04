const REDACT = /authorization|api[-_]?key|token|secret|password/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, REDACT.test(key) ? "[REDACTED]" : scrub(item)]));
  return value;
}

export function log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  const safeContext = scrub(context) as Record<string, unknown>;
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...safeContext });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}
