import { randomUUID } from "node:crypto";
import { vi } from "vitest";

/**
 * A simulated outside world for end-to-end tests: free-model providers, a LiteLLM router, and a network that only knows them.
 * RatLLM's real code runs against it over its real HTTP paths, so a test exercises exactly what production does — the
 * provider check URLs, the OpenAI-compatible chat calls, and LiteLLM's /model/new, /model/delete, /model/{id}/update,
 * /v1/model/info, /fallback and streaming /v1/chat/completions. Any request to a host that was not registered throws, so a
 * test can never reach the real internet or the real router by accident.
 */

export type Behavior = { kind: "ok" } | { kind: "fail"; status: number; message: string } | { kind: "empty" } | { kind: "noStream" };
export const OK: Behavior = { kind: "ok" };
export const failWith = (status: number, message = `HTTP ${status}`): Behavior => ({ kind: "fail", status, message });
export const EMPTY: Behavior = { kind: "empty" };
/** Answers ordinary requests, but refuses to stream (like Groq's text-classification models: HTTP 400 "do not support streaming"). */
export const NO_STREAM: Behavior = { kind: "noStream" };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const errorBody = (message: string) => ({ error: { message } });

/** Streams `text` the way an OpenAI-compatible server does, as server-sent events. */
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

export interface ProviderCall { model: string; key: string | null; stream: boolean }

/** One free-model provider: it accepts some API keys and answers each model in the way the test says. */
export class FakeProvider {
  readonly calls: ProviderCall[] = [];
  private behaviors = new Map<string, Behavior>();
  constructor(readonly host: string, private keys: string[]) {}

  /** Models this provider serves, by the id the provider itself uses (no "openai/" or provider prefix). */
  serve(...models: string[]) { for (const model of models) if (!this.behaviors.has(model)) this.behaviors.set(model, OK); return this; }
  set(model: string, behavior: Behavior) { this.behaviors.set(model, behavior); return this; }
  setAll(behavior: Behavior) { for (const model of this.behaviors.keys()) this.behaviors.set(model, behavior); return this; }
  drop(model: string) { this.behaviors.delete(model); return this; }
  rotateKey(...keys: string[]) { this.keys = keys; return this; }
  callsTo(model: string) { return this.calls.filter(call => call.model === model).length; }
  reset() { this.calls.length = 0; }

  handle(method: string, path: string, headers: Headers, body: unknown): Response {
    const key = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (!this.keys.includes(key ?? "")) return json(401, errorBody("Invalid API key"));
    if (method === "GET") return json(200, { data: [] });             // the account-level credential check (/models, /auth/key)
    if (!/\/chat\/completions\/?$/.test(path)) return json(404, errorBody("Not found"));
    const request = (body ?? {}) as { model?: string; stream?: boolean };
    const model = String(request.model ?? "");
    this.calls.push({ model, key, stream: Boolean(request.stream) });
    const behavior = this.behaviors.get(model);
    if (!behavior) return json(404, errorBody("The model does not exist"));
    if (behavior.kind === "fail") return json(behavior.status, errorBody(behavior.message));
    if (behavior.kind === "noStream" && request.stream) return json(400, errorBody("text classification models do not support streaming"));
    if (behavior.kind === "empty") return request.stream ? sse("") : json(200, { choices: [{ message: { content: "" } }] });
    return request.stream ? sse("OK") : json(200, { choices: [{ message: { content: "OK" } }] });
  }
}

interface Deployment { model_name: string; litellm_params: Record<string, unknown>; model_info: Record<string, unknown> }
export interface RouterEvent { op: "new" | "delete" | "update" | "fallback"; id?: string; detail?: unknown }

/** A LiteLLM proxy in memory. Deployments route to whichever FakeProvider owns the deployment's api_base. */
export class FakeRouter {
  readonly host = "litellm.fake.test";
  readonly masterKey = "sk-fake-master";
  readonly events: RouterEvent[] = [];
  private deployments: Deployment[] = [];
  private fallbacks = new Map<string, string[]>();
  private cursor = 0;
  /** When set, every request answers with this status (an outage of the router itself). */
  down: number | null = null;

  constructor(private world: FakeWorld) {}

  get baseUrl() { return `http://${this.host}`; }
  list() { return this.deployments.map(item => ({ ...item, litellm_params: { ...item.litellm_params }, model_info: { ...item.model_info } })); }
  get(id: string) { return this.deployments.find(item => item.model_info.id === id); }
  ids(lane?: string) { return this.deployments.filter(item => !lane || item.model_name === lane).map(item => String(item.model_info.id)); }
  count() { return this.deployments.length; }
  /** A deployment added behind RatLLM's back (someone using the LiteLLM UI or another tool). */
  addExternally(modelName: string, model: string, apiBase: string, apiKey: string, owner: string | null = null): string {
    const id = randomUUID();
    this.deployments.push({ model_name: modelName, litellm_params: { model, api_base: apiBase, api_key: apiKey }, model_info: { id, db_model: true, ...(owner ? { managed_by: owner } : {}) } });
    return id;
  }
  removeExternally(id: string) { this.deployments = this.deployments.filter(item => item.model_info.id !== id); }
  fallbackOf(model: string) { return this.fallbacks.get(model) ?? []; }
  eventsOf(op: RouterEvent["op"]) { return this.events.filter(event => event.op === op); }

  handle(method: string, url: URL, headers: Headers, body: unknown): Response {
    if (this.down) return json(this.down, errorBody("router down"));
    if (headers.get("authorization") !== `Bearer ${this.masterKey}`) return json(401, errorBody("Authentication Error"));
    const path = url.pathname;
    if (path === "/health/readiness") return json(200, { version: "fake-1.0" }, { "x-litellm-version": "fake-1.0" });
    if (path === "/v1/model/info" || path === "/model/info") return json(200, { data: this.list() });
    if (method === "POST" && path === "/model/new") return this.create(body as Record<string, unknown>);
    if (method === "POST" && path === "/model/delete") {
      const id = String((body as { id?: string }).id);
      if (!this.get(id)) return json(404, errorBody("Model not found"));
      this.deployments = this.deployments.filter(item => item.model_info.id !== id);
      this.events.push({ op: "delete", id });
      return json(200, { message: "Model deleted" });
    }
    const update = /^\/model\/([^/]+)\/update$/.exec(path);
    if (method === "PATCH" && update) return this.update(decodeURIComponent(update[1]), body as Record<string, unknown>);
    const fallback = /^\/fallback\/([^/]+)$/.exec(path);
    if (fallback && method === "GET") { const list = this.fallbacks.get(decodeURIComponent(fallback[1])); return list ? json(200, { fallback_models: list }) : json(404, errorBody("No fallback")); }
    if (fallback && method === "DELETE") { this.fallbacks.delete(decodeURIComponent(fallback[1])); this.events.push({ op: "fallback", detail: { deleted: fallback[1] } }); return json(200, {}); }
    if (method === "POST" && path === "/fallback") {
      const input = body as { model: string; fallback_models: string[] };
      this.fallbacks.set(input.model, input.fallback_models); this.events.push({ op: "fallback", detail: input }); return json(200, {});
    }
    if (method === "POST" && /\/chat\/completions$/.test(path)) return this.chat(body as { model?: string; stream?: boolean });
    return json(404, errorBody(`Unhandled fake LiteLLM route ${method} ${path}`));
  }

  private create(body: Record<string, unknown>): Response {
    const params = { ...(body.litellm_params as Record<string, unknown>) };
    const id = randomUUID();
    this.deployments.push({ model_name: String(body.model_name), litellm_params: params, model_info: { ...(body.model_info as Record<string, unknown>), id, db_model: true } });
    this.events.push({ op: "new", id, detail: { lane: body.model_name, model: params.model } });
    return json(200, { model_info: { id }, model_name: body.model_name });
  }

  private update(id: string, body: Record<string, unknown>): Response {
    const item = this.get(id);
    if (!item) return json(404, errorBody("Model not found"));
    if (typeof body.blocked === "boolean") item.model_info.blocked = body.blocked;
    if (body.model_info && typeof body.model_info === "object") item.model_info = { ...item.model_info, ...(body.model_info as Record<string, unknown>) };
    if (body.litellm_params && typeof body.litellm_params === "object") item.litellm_params = { ...item.litellm_params, ...(body.litellm_params as Record<string, unknown>) };
    this.events.push({ op: "update", id, detail: body });
    return json(200, {});
  }

  /** `model` is either one deployment's own id (what the health monitor sends) or a lane, which picks a live member round-robin. */
  private chat(body: { model?: string; stream?: boolean }): Response {
    const wanted = String(body.model ?? "");
    const byId = this.get(wanted);
    const pool = byId ? [byId] : this.deployments.filter(item => item.model_name === wanted && item.model_info.blocked !== true);
    if (!pool.length) return json(400, errorBody(`No healthy deployment available for ${wanted}`));
    const target = byId ?? pool[this.cursor++ % pool.length];
    const apiBase = String(target.litellm_params.api_base ?? "");
    const provider = this.world.providerAt(apiBase);
    if (!provider) return json(502, errorBody(`No route to ${apiBase}`));
    const upstream = String(target.litellm_params.model ?? "").replace(/^openai\//, "");
    const reply = provider.handle("POST", `${new URL(apiBase).pathname.replace(/\/$/, "")}/chat/completions`, new Headers({ authorization: `Bearer ${String(target.litellm_params.api_key ?? "")}` }), { model: upstream, stream: body.stream });
    // Like the real proxy, whatever the provider answered (an error, an empty completion, a streamed reply) reaches the caller as it was.
    return reply;
  }
}

export class FakeWorld {
  readonly router = new FakeRouter(this);
  private providers = new Map<string, FakeProvider>();
  /** Every request that reached the network layer, for tests that assert on traffic. */
  readonly requests: string[] = [];

  provider(host: string, ...keys: string[]) {
    const existing = this.providers.get(host);
    if (existing) return existing;
    const created = new FakeProvider(host, keys);
    this.providers.set(host, created);
    return created;
  }

  providerAt(apiBase: string): FakeProvider | undefined {
    try { return this.providers.get(new URL(apiBase).host); } catch { return undefined; }
  }

  install() {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const raw = init?.body ?? undefined;
      const body = typeof raw === "string" && raw ? JSON.parse(raw) : undefined;
      this.requests.push(`${method} ${url.host}${url.pathname}`);
      if (url.host === this.router.host) return this.router.handle(method, url, headers, body);
      const provider = this.providers.get(url.host);
      if (provider) return provider.handle(method, url.pathname, headers, body);
      throw new Error(`E2E network guard: unexpected request to ${method} ${url.href}`);
    }));
  }
}
