import Fastify from "fastify";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { createBridgeServices } from "./services.js";

const claimNextSchema = z.object({
  leaseSeconds: z.number().int().positive().optional(),
});

const heartbeatSchema = z.object({
  leaseSeconds: z.number().int().positive().optional(),
});

const manualClaimSchema = z.object({
  leaseSeconds: z.number().int().positive().optional(),
});

const releaseSchema = z.object({
  requeue: z.boolean().optional(),
});

const monitorHeartbeatsSchema = z
  .object({
    now: z.string().min(1).optional(),
  })
  .optional()
  .default({});

const workerEventSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  at: z.string().min(1),
  kind: z.enum(["log", "progress"]),
  message: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  step: z.string().min(1).optional(),
  state: z.enum(["started", "running", "completed", "blocked", "canceled", "failed"]).optional(),
  details: z.record(z.unknown()).optional(),
});

const completeSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "blocked"]),
  summary: z.string().min(1),
});

async function main(): Promise<void> {
  const config = loadConfig();
  const services = createBridgeServices(config);
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

  app.post("/workboard/claim-next", async (request, reply) => {
    const input = claimNextSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const result = await services.claimNextJob(input.data);
    if (result === null) {
      return reply.code(204).send();
    }

    return reply.code(201).send(result);
  });

  app.post("/workboard/:taskId/claim", async (request, reply) => {
    const input = manualClaimSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const { taskId } = request.params as { taskId: string };
    const result = await services.manualClaimJob(taskId, input.data);
    return reply.code(201).send(result);
  });

  app.post("/workboard/:taskId/release", async (request, reply) => {
    const input = releaseSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const { taskId } = request.params as { taskId: string };
    const result = await services.releaseJob(taskId, input.data);
    if (result === null) {
      return reply.code(404).send({ error: "job not found" });
    }

    return reply.send(result);
  });

  app.post("/workboard/:taskId/requeue", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const result = await services.requeueJob(taskId);
    if (result === null) {
      return reply.code(404).send({ error: "job not found" });
    }

    return reply.send(result);
  });

  app.post("/control/pause", async () => services.pauseWork());

  app.post("/control/resume", async () => services.resumeWork());

  app.get("/control", async () => services.getControlState());

  app.post("/workboard/:taskId/heartbeat", async (request, reply) => {
    const input = heartbeatSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const { taskId } = request.params as { taskId: string };
    const result = await services.heartbeatJob(taskId, input.data);
    if (result === null) {
      return reply.code(404).send({ error: "claim not found" });
    }

    return reply.send(result);
  });

  app.post("/workboard/heartbeat-monitor", async (request, reply) => {
    const input = monitorHeartbeatsSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const result = await services.monitorHeartbeats(input.data);
    return reply.send(result);
  });

  app.post("/workboard/:taskId/events", async (request, reply) => {
    const input = workerEventSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const { taskId } = request.params as { taskId: string };
    const result = await services.recordWorkerEvent(taskId, input.data);
    if (result === null) {
      return reply.code(404).send({ error: "job not found" });
    }

    return reply.send(result);
  });

  app.post("/workboard/:taskId/complete", async (request, reply) => {
    const input = completeSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.flatten() });
    }

    const { taskId } = request.params as { taskId: string };
    const result = await services.completeJob(taskId, input.data);
    return reply.send(result);
  });

  app.get("/workboard/jobs", async () => ({
    jobs: services.listJobs(),
    claims: services.workboard.listClaims(),
  }));

  app.get("/workboard/metrics", async () => services.getMetricsSnapshot());

  const port = Number(config.PORT);
  await app.listen({ host: config.HOST, port });
  services.logger.info("bridge started", { host: config.HOST, port });

  if (Number.isFinite(services.heartbeatMonitorIntervalMs) && services.heartbeatMonitorIntervalMs > 0) {
    const interval = setInterval(() => {
      void services.monitorHeartbeats().catch((error: unknown) => {
        services.logger.warn("heartbeat monitor failed", { error: String(error) });
      });
    }, services.heartbeatMonitorIntervalMs);

    interval.unref();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
