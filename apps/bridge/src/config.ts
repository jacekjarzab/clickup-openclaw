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
  TRIAGE_RULES_JSON: z.string().optional(),
  DEFAULT_WORK_TYPE: z.string().min(1).optional(),
  REPO_URL: z.string().min(1).optional(),
  PR_URL: z.string().min(1).optional(),
  ARTIFACT_URL: z.string().min(1).optional(),
  DOCS_URL: z.string().min(1).optional(),
  DESIGN_URL: z.string().min(1).optional(),
  HEARTBEAT_MONITOR_INTERVAL_MS: z.string().optional(),
  QUEUE_STALL_ALERT_MS: z.string().optional(),
  BLOCKED_ESCALATION_MS: z.string().optional(),
  DEFAULT_PROJECT_KEY: z.string().min(1).optional(),
  PROJECT_ROUTING_JSON: z.string().optional(),
  OPENCLAW_BIN: z.string().min(1).optional(),
  OPENCLAW_WORKBOARD_BOARD_ID: z.string().min(1).optional(),
  OPENCLAW_WORKBOARD_TRANSPORT: z.enum(["cli", "websocket"]).default("cli"),
  OPENCLAW_WORKBOARD_CLI_TIMEOUT_MS: z.string().optional(),
  OPENCLAW_WORKBOARD_WS_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
      message: "must be a ws:// or wss:// URL",
    })
    .optional(),
  OPENCLAW_WORKBOARD_WS_PROTOCOL: z.string().min(1).optional(),
  OPENCLAW_WORKBOARD_WS_TIMEOUT_MS: z.string().optional(),
  OPENCLAW_WATCH_INTERVAL_MS: z.string().optional(),
  BRIDGE_RETRY_MAX_ATTEMPTS: z.string().optional(),
  BRIDGE_RETRY_BASE_DELAY_MS: z.string().optional(),
  BRIDGE_RETRY_MAX_DELAY_MS: z.string().optional(),
  BRIDGE_DEAD_LETTER_THRESHOLD: z.string().optional(),
  BRIDGE_STALE_CARD_AGE_MS: z.string().optional(),
  BRIDGE_INTERRUPTED_RUN_AGE_MS: z.string().optional(),
  STATE_FILE_PATH: z.string().min(1).optional(),
  PORT: z.string().default("8787"),
  HOST: z.string().default("0.0.0.0"),
});

export type BridgeConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return envSchema.parse(env);
}
