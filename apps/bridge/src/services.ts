import { createClickUpClient } from "@clickup-openclaw/clickup-client";
import { createLogger } from "@clickup-openclaw/observability";
import { clickupWebhookEventSchema } from "@clickup-openclaw/shared";
import { InMemoryStateStore } from "@clickup-openclaw/state";
import { InMemoryWorkboard } from "@clickup-openclaw/workboard";

import type { BridgeConfig } from "./config.js";

export function createBridgeServices(config: BridgeConfig) {
  const logger = createLogger("bridge");
  const state = new InMemoryStateStore();
  const workboard = new InMemoryWorkboard();
  const clickup =
    config.CLICKUP_API_TOKEN === undefined
      ? undefined
      : createClickUpClient({
          token: config.CLICKUP_API_TOKEN,
          ...(config.CLICKUP_BASE_URL === undefined ? {} : { baseUrl: config.CLICKUP_BASE_URL }),
        });

  async function ingestWebhook(input: unknown) {
    const event = clickupWebhookEventSchema.parse(input);
    logger.info("webhook received", { event: event.event, taskId: event.taskId });

    const current = state.getJob(event.taskId);
    if (current === undefined) {
      workboard.enqueue({
        taskId: event.taskId,
        priority: 0,
        requestedAt: new Date().toISOString(),
      });
    }

    state.upsertJob({
      task: {
        id: event.taskId,
        name: event.taskId,
        status: event.status ?? "unknown",
        listId: event.listId,
        tags: [],
      },
      state: "received",
      updatedAt: new Date().toISOString(),
    });

    return { accepted: true };
  }

  return {
    logger,
    state,
    workboard,
    clickup,
    ingestWebhook,
  };
}
