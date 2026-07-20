import { createLogger } from "@clickup-openclaw/observability";
import { InMemoryStateStore } from "@clickup-openclaw/state";
import { InMemoryWorkboard } from "@clickup-openclaw/workboard";

export function main(): void {
  const logger = createLogger("worker");
  const state = new InMemoryStateStore();
  const workboard = new InMemoryWorkboard();

  logger.info("worker started", {
    jobs: state.listJobs().length,
    queued: 0,
  });
}

main();
