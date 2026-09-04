import Module from "node:module";
// Next resolves server-only specially. A standalone worker is server-side by definition,
// so make that marker a no-op before tsx loads shared services.
const loader = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const original = loader._load;
loader._load = function(request, parent, isMain) {
  if (request === "server-only") return {};
  return original.call(this, request, parent, isMain);
};
void import("./worker").catch((error: unknown) => { console.error("worker bootstrap failed", error); process.exit(1); });
