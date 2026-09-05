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
  content?: string;
  error?: string;
}

export interface LiteLLMAdapter {
  listDeployments(): Promise<LiteLLMDeployment[]>;
  getVersion(): Promise<string | null>;
  smokeTest(model: string): Promise<SmokeResult>;
  addDeployment(input: { modelName:string; model:string; apiKey:string; apiBase?:string; metadata:Record<string,unknown> }): Promise<{ id?:string }>;
  setDeploymentBlocked(id: string, blocked: boolean): Promise<void>;
  removeDeployment(id:string): Promise<void>;
}
