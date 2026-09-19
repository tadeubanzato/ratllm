import "server-only";
import { deploymentIdentity } from "./classify";
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
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 128, temperature: 0, stream: true }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
        return { ok: false, status: response.status, latencyMs: Math.round(performance.now() - start), error: body.error?.message?.slice(0, 300) ?? `HTTP ${response.status}` };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let firstTokenMs: number | undefined;
      let content = "";
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstTokenMs === undefined) firstTokenMs = Math.round(performance.now() - start);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            content += chunk.choices?.[0]?.delta?.content ?? "";
          } catch { /* partial or non-JSON chunk boundary; ignore */ }
        }
      }
      const trimmed = content.trim();
      return { ok: response.ok && trimmed.length > 0, status: response.status, latencyMs: Math.round(performance.now() - start), firstTokenMs, content: trimmed.slice(0, 200), error: trimmed.length > 0 ? undefined : "Empty completion" };
    } catch (error) {
      return { ok: false, status: 0, latencyMs: Math.round(performance.now() - start), error: error instanceof Error ? error.message : "Unknown LiteLLM error" };
    }
  }

  async addDeployment(input:{modelName:string;model:string;apiKey:string;apiBase?:string;extraHeaders?:Record<string,string>;sslVerify?:boolean;metadata:Record<string,unknown>}) {
    const response=await this.request("/model/new",{method:"POST",body:JSON.stringify({model_name:input.modelName,litellm_params:{model:input.model,api_key:input.apiKey,...(input.apiBase?{api_base:input.apiBase}:{}),...(input.extraHeaders&&Object.keys(input.extraHeaders).length?{extra_headers:input.extraHeaders}:{}),...(input.sslVerify===false?{ssl_verify:false}:{})},model_info:input.metadata})});
    const body=await response.json().catch(()=>({})) as {model_info?:{id?:string};id?:string}; return {id:body.model_info?.id??body.id};
  }

  /** Keeps a deployment's record and routing history while taking it out of service. */
  async setDeploymentBlocked(id: string, blocked: boolean) {
    await this.request(`/model/${encodeURIComponent(id)}/update`, { method: "PATCH", body: JSON.stringify({ blocked }) });
  }

  /** Rotates the stored api_key on an existing deployment without recreating it — needed for providers whose
   *  credential is a short-lived OAuth token (see providers/gigachat.ts's refresh job) rather than a static key. */
  async updateDeploymentApiKey(id: string, apiKey: string) {
    await this.request(`/model/${encodeURIComponent(id)}/update`, { method: "PATCH", body: JSON.stringify({ litellm_params: { api_key: apiKey } }) });
  }

  /** The router's own model_info for one deployment, or null if it isn't listed. */
  async getModelInfo(id: string): Promise<Record<string, unknown> | null> {
    const item = (await this.listDeployments()).find(deployment => deploymentIdentity(deployment).deploymentId === id);
    return item ? { ...item.model_info } : null;
  }

  /** Partial update of one deployment's model_info. Whether the router merges or replaces is checked by the caller (see adoption.ts). */
  async patchModelInfo(id: string, modelInfo: Record<string, unknown>) {
    await this.request(`/model/${encodeURIComponent(id)}/update`, { method: "PATCH", body: JSON.stringify({ model_info: modelInfo }) });
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
