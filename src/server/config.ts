import "server-only";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  LITELLM_BASE_URL: z.string().url().default("http://litellm:4000"),
  LITELLM_MASTER_KEY: z.string().min(1).optional(),
  N8N_BASE_URL: z.string().url().optional(),
  N8N_API_KEY: z.string().min(1).optional(),
  // Address reachable from n8n, distinct from the browser/public ingress URL.
  CURATOR_N8N_URL: z.string().url().optional(),
  CURATOR_PUBLIC_URL: z.string().url().optional(),
  INTERNAL_API_SECRET: z.string().min(24).optional(),
  ADMIN_TOKEN: z.string().min(16).optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
  DEMO_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  LITELLM_BASE_URL: process.env["LITELLM_BASE_URL"],
  LITELLM_MASTER_KEY: process.env["LITELLM_MASTER_KEY"],
  N8N_BASE_URL: process.env["N8N_BASE_URL"],
  N8N_API_KEY: process.env["N8N_API_KEY"],
  CURATOR_N8N_URL: process.env["CURATOR_N8N_URL"],
  CURATOR_PUBLIC_URL: process.env["CURATOR_PUBLIC_URL"],
  INTERNAL_API_SECRET: process.env["INTERNAL_API_SECRET"],
  ADMIN_TOKEN: process.env["ADMIN_TOKEN"],
  CREDENTIAL_ENCRYPTION_KEY: process.env["CREDENTIAL_ENCRYPTION_KEY"],
  DEMO_MODE: process.env["DEMO_MODE"],
});
