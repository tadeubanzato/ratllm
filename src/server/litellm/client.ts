import "server-only";
import { connectionConfig } from "@/server/settings/connections";
import { deploymentSchema, type FallbackType, type LiteLLMAdapter, type LiteLLMDeployment, type SmokeResult } from "./types";

export class LiteLLMError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "LiteLLMError"; }
}

export class HttpLiteLLMAdapter implements LiteLLMAdapter {
  constructor(private baseUrl?: string, private masterKey?: string) {}

  private async configure() {
    if (this.baseUrl === undefined) { const config = await connectionConfig("litellm"); this.baseUrl = config.baseUrl; this.masterKey = config.key; }
  }

  private headers() {
    return { "content-type": "application/json", ...(this.masterKey ? { authorization: `Bearer ${this.masterKey}` } : {}) };
  }

  private async request(path: string, init?: RequestInit) {
    await this.configure();
    const response = await fetch(`${this.baseUrl!.replace(/\/$/, "")}${path}`, { ...init, headers: { ...this.headers(), ...init?.headers }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
    if (!response.ok) throw new LiteLLMError(`LiteLLM ${path} returned ${response.status}`, response.status);
    return response;
  }

  async listDeployments(): Promise<LiteLLMDeployment[]> {
    const response = await this.request("/v1/model/info");
    const raw: unknown = await response.json();
    const rows = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? ((raw as Record<string, unknown>).data ?? (raw as Record<string, unknown>).models ?? []) : [];
    return z.array(deploymentSchema).parse(rows);
  }

  async getVersion() {
    try {
      const response = await this.request("/health/readiness");
      return response.headers.get("x-litellm-version") ?? (await response.json().catch(() => null) as { version?: string } | null)?.version ?? null;
    } catch { return null; }
  }

  async smokeTest(model: string): Promise<SmokeResult> {
    const start = performance.now();
    try {
      await this.configure();
      const response = await fetch(`${this.baseUrl!.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST", headers: this.headers(), signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 12, temperature: 0, stream: false }),
      });
      const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      const content = body.choices?.[0]?.message?.content?.trim();
      return { ok: response.ok && Boolean(body.choices?.length), status: response.status, latencyMs: Math.round(performance.now() - start), content: content?.slice(0, 200), error: response.ok ? undefined : body.error?.message?.slice(0, 300) ?? `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, status: 0, latencyMs: Math.round(performance.now() - start), error: error instanceof Error ? error.message : "Unknown LiteLLM error" };
    }
  }

  async addDeployment(input:{modelName:string;model:string;apiKey:string;apiBase?:string;metadata:Record<string,unknown>}) {
    const response=await this.request("/model/new",{method:"POST",body:JSON.stringify({model_name:input.modelName,litellm_params:{model:input.model,api_key:input.apiKey,...(input.apiBase?{api_base:input.apiBase}:{})},model_info:input.metadata})});
    const body=await response.json().catch(()=>({})) as {model_info?:{id?:string};id?:string}; return {id:body.model_info?.id??body.id};
  }

  /** Keeps a deployment's record and routing history while taking it out of service. */
  async setDeploymentBlocked(id: string, blocked: boolean) {
    await this.request(`/model/${encodeURIComponent(id)}/update`, { method: "PATCH", body: JSON.stringify({ blocked }) });
  }

  async removeDeployment(id:string){await this.request("/model/delete",{method:"POST",body:JSON.stringify({id})});}

  /** Runtime fallback management (needs STORE_MODEL_IN_DB=True on the proxy). `model` is a model-group name, e.g. "smart-general". */
  async getFallback(model: string, type: FallbackType): Promise<string[]> {
    try {
      const response = await this.request(`/fallback/${encodeURIComponent(model)}?fallback_type=${type}`);
      const body = await response.json().catch(() => ({})) as { fallback_models?: unknown };
      return Array.isArray(body.fallback_models) ? body.fallback_models.filter((value): value is string => typeof value === "string") : [];
    } catch (error) {
      if (error instanceof LiteLLMError && error.status === 404) return [];
      throw error;
    }
  }

  async setFallback(model: string, fallbackModels: string[], type: FallbackType): Promise<void> {
    if (!fallbackModels.length) return this.deleteFallback(model, type);
    await this.request("/fallback", { method: "POST", body: JSON.stringify({ model, fallback_models: fallbackModels, fallback_type: type }) });
  }

  async deleteFallback(model: string, type: FallbackType): Promise<void> {
    try {
      await this.request(`/fallback/${encodeURIComponent(model)}?fallback_type=${type}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof LiteLLMError && error.status === 404) return;
      throw error;
    }
  }
}

import { z } from "zod";
