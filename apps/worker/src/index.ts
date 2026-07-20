import { createLogger } from "@clickup-openclaw/observability";

type ClaimResponse = {
  taskId: string;
  runId: string;
  leaseExpiresAt: string;
  leaseSeconds: number;
  requestedAt: string;
  task?: {
    id: string;
    name: string;
    status: string;
    listId?: string;
    priority?: string;
    description?: string;
    tags: string[];
  };
};

function readNumber(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) {
    return fallback;
  }

  const parsed = Number(envValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const logger = createLogger("worker");
  const bridgeUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:8787";
  const leaseSeconds = readNumber(process.env.WORKER_LEASE_SECONDS, 15 * 60);
  const pollIntervalMs = readNumber(process.env.WORKER_POLL_INTERVAL_MS, 2500);
  const runOnce = process.env.WORKER_RUN_ONCE === "1";

  async function claimNext(): Promise<ClaimResponse | null> {
    const response = await fetch(`${bridgeUrl}/workboard/claim-next`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ leaseSeconds }),
    });

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to claim work: ${response.status}`);
    }

    return (await response.json()) as ClaimResponse;
  }

  async function heartbeat(taskId: string): Promise<void> {
    const response = await fetch(`${bridgeUrl}/workboard/${taskId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ leaseSeconds }),
    });

    if (!response.ok) {
      throw new Error(`Failed to heartbeat work for ${taskId}: ${response.status}`);
    }
  }

  async function complete(
    taskId: string,
    outcome: "succeeded" | "failed" | "blocked",
    summary: string,
  ): Promise<void> {
    const response = await fetch(`${bridgeUrl}/workboard/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome, summary }),
    });

    if (!response.ok) {
      throw new Error(`Failed to complete work for ${taskId}: ${response.status}`);
    }
  }

  logger.info("worker started", { bridgeUrl, pollIntervalMs, leaseSeconds, runOnce });

  while (true) {
    const claim = await claimNext();
    if (claim === null) {
      if (runOnce) {
        return;
      }

      await sleep(pollIntervalMs);
      continue;
    }

    logger.info("claimed task", { taskId: claim.taskId, runId: claim.runId });
    await heartbeat(claim.taskId);
    await complete(
      claim.taskId,
      "succeeded",
      `OpenClaw worker completed task ${claim.taskId}${claim.task?.name ? ` (${claim.task.name})` : ""} in run ${claim.runId}.`,
    );

    if (runOnce) {
      return;
    }
  }
}

void main().catch((error: unknown) => {
  createLogger("worker").error("worker failed", { error: String(error) });
  process.exit(1);
});
