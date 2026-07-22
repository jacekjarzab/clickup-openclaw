import { z } from "zod";

const envSchema = z.object({
  CLICKUP_API_TOKEN: z.string().min(1).optional(),
  CLICKUP_BASE_URL: z.string().url().optional(),
  CLICKUP_REPO_URL: z.string().min(1).optional(),
  CLICKUP_PR_URL: z.string().min(1).optional(),
  CLICKUP_ARTIFACT_URL: z.string().min(1).optional(),
  CLICKUP_DOCS_URL: z.string().min(1).optional(),
  CLICKUP_DESIGN_URL: z.string().min(1).optional(),
  WORK_TYPE_TEMPLATES_JSON: z.string().optional(),
  WORKFLOW_TEMPLATES_JSON: z.string().optional(),
  DEFAULT_WORK_TYPE: z.string().min(1).optional(),
  REPO_URL: z.string().min(1).optional(),
  PR_URL: z.string().min(1).optional(),
  ARTIFACT_URL: z.string().min(1).optional(),
  DOCS_URL: z.string().min(1).optional(),
  DESIGN_URL: z.string().min(1).optional(),
  HEARTBEAT_MONITOR_INTERVAL_MS: z.string().optional(),
  QUEUE_STALL_ALERT_MS: z.string().optional(),
  DEFAULT_PROJECT_KEY: z.string().min(1).optional(),
  PROJECT_ROUTING_JSON: z.string().optional(),
  PORT: z.string().default("8787"),
  HOST: z.string().default("0.0.0.0"),
});

export type BridgeConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return envSchema.parse(env);
}
