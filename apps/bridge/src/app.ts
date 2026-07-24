import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { createBridgeServices } from "./services.js";

const syncListSchema = z.object({
  listId: z.string().min(1),
});

const openClawDispatchSchema = z.object({
  maxStarts: z.number().int().positive().optional(),
});

const operatorReasonSchema = z.object({
  reason: z.string().min(1),
});

type BridgeServices = ReturnType<typeof createBridgeServices>;

function handleOperatorError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof Error)) {
    return reply.code(500).send({ error: "Internal Server Error" });
  }

  if (error.message.startsWith("Unknown task ")) {
    return reply.code(404).send({ error: error.message });
  }

  if (
    error.message.includes("not eligible") ||
    error.message.includes("already active") ||
    error.message.includes("not active") ||
    error.message.includes("not ready for human review")
  ) {
    return reply.code(409).send({ error: error.message });
  }

  return reply.code(500).send({ error: error.message });
}

export function createBridgeApp(services: BridgeServices) {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({
    ok: true,
    hasClickUpToken: services.clickup !== undefined,
    metrics: services.getMetricsSnapshot(),
    control: services.getControlState(),
  }));

  app.post("/clickup/webhook", async (request, reply) => {
    const result = await services.ingestWebhook(request.body);
    return reply.code(202).send(result);
  });

  app.post("/clickup/list-sync", async (request, reply) => {
    const input = syncListSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const result = await services.syncList(input.data.listId);
    return reply.code(202).send(result);
  });

  app.post("/openclaw/:taskId/handoff", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const result = await services.handoffJobToOpenClaw(taskId);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/openclaw/:taskId/redispatch", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };

    try {
      const result = await services.redispatchEligibleJob(taskId);
      return reply.code(202).send(result);
    } catch (error) {
      return handleOperatorError(reply, error);
    }
  });

  app.post("/openclaw/dispatch", async (request, reply) => {
    const input = openClawDispatchSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const result = await services.dispatchOpenClawWorkboard(input.data);
    return reply.code(202).send(result);
  });

  app.get("/openclaw/:taskId/card", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const result = await services.refreshOpenClawCard(taskId);
    return reply.send(result);
  });

  app.post("/openclaw/:taskId/sync", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const result = await services.syncOpenClawCardToClickUp(taskId);
    return reply.send(result);
  });

  app.post("/openclaw/:taskId/requeue", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };

    try {
      const result = await services.requeueJob(taskId);
      return reply.code(202).send(result);
    } catch (error) {
      return handleOperatorError(reply, error);
    }
  });

  app.post("/openclaw/:taskId/block", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const input = operatorReasonSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    try {
      const result = await services.markJobBlocked(taskId, input.data.reason);
      return reply.code(202).send(result);
    } catch (error) {
      return handleOperatorError(reply, error);
    }
  });

  app.post("/openclaw/:taskId/review", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const input = operatorReasonSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    try {
      const result = await services.forceHumanReviewJob(taskId, input.data.reason);
      return reply.code(202).send(result);
    } catch (error) {
      return handleOperatorError(reply, error);
    }
  });

  app.post("/openclaw/watch", async () => services.watchOpenClawCards());

  app.post("/control/pause", async () => services.pauseWork());

  app.post("/control/resume", async () => services.resumeWork());

  app.get("/control", async () => services.getControlState());

  app.get("/workboard/jobs", async () => ({
    jobs: services.listJobs(),
  }));

  app.get("/workboard/metrics", async () => services.getMetricsSnapshot());
  app.get("/dashboards", async () => services.getDashboardSnapshot());
  app.get("/dashboards/queue-health", async () => services.getDashboardSnapshot().queueHealth);
  app.get("/dashboards/completion-rates", async () => services.getDashboardSnapshot().completionRates);

  return app;
}

export async function buildAndStartBridge(): Promise<void> {
  const config = loadConfig();
  const services = createBridgeServices(config);
  const app = createBridgeApp(services);

  await services.reconcilePersistedState();

  const port = Number(config.PORT);
  await app.listen({ host: config.HOST, port });
  services.logger.info("bridge started", { host: config.HOST, port });

  if (Number.isFinite(services.openClawWatchIntervalMs) && services.openClawWatchIntervalMs > 0) {
    const interval = setInterval(() => {
      void services.watchOpenClawCards().catch((error: unknown) => {
        services.logger.warn("openclaw card watcher failed", { error: String(error) });
      });
    }, services.openClawWatchIntervalMs);

    interval.unref();
  }
}
