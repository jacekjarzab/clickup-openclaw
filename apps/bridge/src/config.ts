import { z } from "zod";

const envSchema = z.object({
  CLICKUP_API_TOKEN: z.string().min(1).optional(),
  CLICKUP_BASE_URL: z.string().url().optional(),
  CLICKUP_REPO_URL: z.string().min(1).optional(),
  CLICKUP_PR_URL: z.string().min(1).optional(),
  CLICKUP_ARTIFACT_URL: z.string().min(1).optional(),
  REPO_URL: z.string().min(1).optional(),
  PR_URL: z.string().min(1).optional(),
  ARTIFACT_URL: z.string().min(1).optional(),
  PORT: z.string().default("8787"),
  HOST: z.string().default("0.0.0.0"),
});

export type BridgeConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return envSchema.parse(env);
}
