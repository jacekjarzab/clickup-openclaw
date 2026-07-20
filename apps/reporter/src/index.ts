import { createClickUpClient } from "@clickup-openclaw/clickup-client";
import { createLogger } from "@clickup-openclaw/observability";

export function createReporter() {
  const logger = createLogger("reporter");
  const clickupToken = process.env.CLICKUP_API_TOKEN;
  const client =
    clickupToken === undefined
      ? undefined
      : createClickUpClient({
          token: clickupToken,
          ...(process.env.CLICKUP_BASE_URL === undefined ? {} : { baseUrl: process.env.CLICKUP_BASE_URL }),
        });

  return {
    async reportStart(taskId: string): Promise<void> {
      logger.info("report start", { taskId });
      if (client !== undefined) {
        await client.postTaskComment(taskId, "Claimed by OpenClaw, starting work.");
        await client.updateTaskStatus(taskId, "in progress");
      }
    },
  };
}

if (process.env.NODE_ENV !== "test") {
  createLogger("reporter").info("reporter ready");
}
