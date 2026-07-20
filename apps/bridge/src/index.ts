import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { createBridgeServices } from "./services.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const services = createBridgeServices(config);
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({
    ok: true,
    hasClickUpToken: services.clickup !== undefined,
  }));

  app.post("/clickup/webhook", async (request, reply) => {
    const result = await services.ingestWebhook(request.body);
    return reply.code(202).send(result);
  });

  const port = Number(config.PORT);
  await app.listen({ host: config.HOST, port });
  services.logger.info("bridge started", { host: config.HOST, port });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
