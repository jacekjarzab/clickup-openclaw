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

type WorkerEvent = {
  taskId: string;
  runId: string;
  at: string;
  kind: "log" | "progress";
  message: string;
  level?: "debug" | "info" | "warn" | "error";
  step?: string;
  state?: "started" | "running" | "completed" | "blocked" | "failed";
  details?: Record<string, unknown>;
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

function nowIso(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  const logger = createLogger("worker");
  const bridgeUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:8787";
  const leaseSeconds = readNumber(process.env.WORKER_LEASE_SECONDS, 15 * 60);
  const pollIntervalMs = readNumber(process.env.WORKER_POLL_INTERVAL_MS, 2500);
  const runOnce = process.env.WORKER_RUN_ONCE === "1";

  async function recordEvent(event: WorkerEvent): Promise<void> {
    const response = await fetch(`${bridgeUrl}/workboard/${event.taskId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      throw new Error(`Failed to record work event for ${event.taskId}: ${response.status}`);
    }
  }

  async function writeLog(
    level: WorkerEvent["level"],
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    switch (level) {
      case "debug":
        logger.debug(message, meta);
        break;
      case "warn":
        logger.warn(message, meta);
        break;
      case "error":
        logger.error(message, meta);
        break;
      default:
        logger.info(message, meta);
        break;
    }
  }

  async function emitLog(
    claim: ClaimResponse,
    level: NonNullable<WorkerEvent["level"]>,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const event: WorkerEvent = {
      taskId: claim.taskId,
      runId: claim.runId,
      at: nowIso(),
      kind: "log",
      level,
      message,
      ...(details === undefined ? {} : { details }),
    };

    await writeLog(level, message, {
      taskId: claim.taskId,
      runId: claim.runId,
      ...(details === undefined ? {} : details),
    });

    try {
      await recordEvent(event);
    } catch (error) {
      logger.warn("failed to record worker log event", {
        taskId: claim.taskId,
        runId: claim.runId,
        error: String(error),
      });
    }
  }

  async function emitProgress(
    claim: ClaimResponse,
    step: string,
    state: NonNullable<WorkerEvent["state"]>,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const event: WorkerEvent = {
      taskId: claim.taskId,
      runId: claim.runId,
      at: nowIso(),
      kind: "progress",
      step,
      state,
      message,
      ...(details === undefined ? {} : { details }),
    };

    logger.info(message, {
      taskId: claim.taskId,
      runId: claim.runId,
      step,
      state,
      ...(details === undefined ? {} : details),
    });

    try {
      await recordEvent(event);
    } catch (error) {
      logger.warn("failed to record worker progress event", {
        taskId: claim.taskId,
        runId: claim.runId,
        step,
        state,
        error: String(error),
      });
    }
  }

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
      logger.debug("no eligible work", { bridgeUrl, pollIntervalMs, leaseSeconds, runOnce });
      if (runOnce) {
        return;
      }

      await sleep(pollIntervalMs);
      continue;
    }

    try {
      await emitLog(claim, "info", "claimed task", {
        leaseExpiresAt: claim.leaseExpiresAt,
        leaseSeconds: claim.leaseSeconds,
        requestedAt: claim.requestedAt,
      });
      await emitProgress(claim, "claim", "started", "Worker started processing claimed task", {
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await heartbeat(claim.taskId);
      await emitLog(claim, "info", "heartbeat sent", {
        leaseSeconds: claim.leaseSeconds,
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await emitProgress(claim, "heartbeat", "running", "Lease renewed for active task", {
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await complete(
        claim.taskId,
        "succeeded",
        `OpenClaw worker completed task ${claim.taskId}${claim.task?.name ? ` (${claim.task.name})` : ""} in run ${claim.runId}.`,
      );
      await emitLog(claim, "info", "completed task", {
        outcome: "succeeded",
      });
      await emitProgress(claim, "complete", "completed", "Worker finished task successfully", {
        taskName: claim.task?.name,
      });
    } catch (error) {
      await emitLog(claim, "error", "worker run failed", {
        error: String(error),
      });
      await emitProgress(claim, "complete", "failed", "Worker run failed before completion", {
        error: String(error),
        taskName: claim.task?.name,
      });
      throw error;
    }

    if (runOnce) {
      return;
    }
  }
}

void main().catch((error: unknown) => {
  createLogger("worker").error("worker failed", { error: String(error) });
  process.exit(1);
});
