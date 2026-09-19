import { z } from "zod";

export const deploymentSchema = z.object({
  model_name: z.string().default("unknown"),
  model_info: z.record(z.string(), z.unknown()).optional().default({}),
  litellm_params: z.record(z.string(), z.unknown()).optional().default({}),
  model_id: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export type LiteLLMDeployment = z.infer<typeof deploymentSchema>;

export interface SmokeResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  firstTokenMs?: number;
  content?: string;
  error?: string;
}

export type FallbackType = "general" | "context_window" | "content_policy";

export interface LiteLLMAdapter {
  listDeployments(): Promise<LiteLLMDeployment[]>;
  getVersion(): Promise<string | null>;
  smokeTest(model: string): Promise<SmokeResult>;
  addDeployment(input: { modelName:string; model:string; apiKey:string; apiBase?:string; extraHeaders?:Record<string,string>; sslVerify?:boolean; metadata:Record<string,unknown> }): Promise<{ id?:string }>;
  setDeploymentBlocked(id: string, blocked: boolean): Promise<void>;
  removeDeployment(id:string): Promise<void>;
  getFallback(model: string, type: FallbackType): Promise<string[]>;
  setFallback(model: string, fallbackModels: string[], type: FallbackType): Promise<void>;
  deleteFallback(model: string, type: FallbackType): Promise<void>;
}
