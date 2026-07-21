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
  state?: "started" | "running" | "completed" | "blocked" | "canceled" | "failed";
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")
  );
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    error: String(error),
  };
}

async function main(): Promise<void> {
  const logger = createLogger("worker");
  const bridgeUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:8787";
  const leaseSeconds = readNumber(process.env.WORKER_LEASE_SECONDS, 15 * 60);
  const pollIntervalMs = readNumber(process.env.WORKER_POLL_INTERVAL_MS, 2500);
  const runOnce = process.env.WORKER_RUN_ONCE === "1";
  const shutdownController = new AbortController();
  let activeRun:
    | {
        claim: ClaimResponse;
        finalized: boolean;
      }
    | undefined;

  async function recordEvent(event: WorkerEvent, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${bridgeUrl}/workboard/${event.taskId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
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

  async function claimNext(signal?: AbortSignal): Promise<ClaimResponse | null> {
    const response = await fetch(`${bridgeUrl}/workboard/claim-next`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
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

  async function heartbeat(taskId: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${bridgeUrl}/workboard/${taskId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
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
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${bridgeUrl}/workboard/${taskId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({ outcome, summary }),
    });

    if (!response.ok) {
      throw new Error(`Failed to complete work for ${taskId}: ${response.status}`);
    }
  }

  async function reportTerminalOutcome(
    claim: ClaimResponse,
    input: {
      outcome: "succeeded" | "failed" | "blocked";
      progressState: NonNullable<WorkerEvent["state"]>;
      summary: string;
      logMessage: string;
      level: NonNullable<WorkerEvent["level"]>;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (activeRun?.finalized === true) {
      return;
    }

    if (activeRun !== undefined) {
      activeRun.finalized = true;
    }

    const details = input.details ?? {};

    await emitLog(claim, input.level, input.logMessage, details);
    await emitProgress(claim, "complete", input.progressState, input.summary, details);
    try {
      await complete(claim.taskId, input.outcome, input.summary);
    } catch (error) {
      logger.warn("failed to report terminal work outcome", {
        taskId: claim.taskId,
        runId: claim.runId,
        outcome: input.outcome,
        error: String(error),
      });
      throw error;
    }
  }

  function registerShutdownHandler(signalName: NodeJS.Signals): void {
    shutdownController.abort();

    const claim = activeRun?.claim;
    if (claim === undefined) {
      return;
    }

    void reportTerminalOutcome(claim, {
      outcome: "failed",
      progressState: "canceled",
      summary: `Worker run canceled for task ${claim.taskId} because ${signalName} was received.`,
      logMessage: "worker shutdown requested",
      level: "warn",
      details: {
        signal: signalName,
        taskName: claim.task?.name,
      },
    }).catch((error) => {
      logger.warn("failed to handle worker shutdown", {
        taskId: claim.taskId,
        runId: claim.runId,
        signal: signalName,
        error: String(error),
      });
    });
  }

  process.once("SIGINT", () => {
    registerShutdownHandler("SIGINT");
  });
  process.once("SIGTERM", () => {
    registerShutdownHandler("SIGTERM");
  });

  logger.info("worker started", { bridgeUrl, pollIntervalMs, leaseSeconds, runOnce });

  while (!shutdownController.signal.aborted) {
    let claim: ClaimResponse | null;

    try {
      claim = await claimNext(shutdownController.signal);
    } catch (error) {
      if (isAbortError(error) || shutdownController.signal.aborted) {
        break;
      }

      throw error;
    }

    if (claim === null) {
      logger.debug("no eligible work", { bridgeUrl, pollIntervalMs, leaseSeconds, runOnce });
      if (runOnce) {
        return;
      }

      await sleep(pollIntervalMs);
      continue;
    }

    activeRun = { claim, finalized: false };

    try {
      await emitLog(claim, "info", "claimed task", {
        leaseExpiresAt: claim.leaseExpiresAt,
        leaseSeconds: claim.leaseSeconds,
        requestedAt: claim.requestedAt,
      });
      await emitProgress(claim, "claim", "started", "Worker started processing claimed task", {
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await heartbeat(claim.taskId, shutdownController.signal);
      await emitLog(claim, "info", "heartbeat sent", {
        leaseSeconds: claim.leaseSeconds,
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await emitProgress(claim, "heartbeat", "running", "Lease renewed for active task", {
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await sleep(0);

      await reportTerminalOutcome(claim, {
        outcome: "succeeded",
        progressState: "completed",
        summary: `OpenClaw worker completed task ${claim.taskId}${claim.task?.name ? ` (${claim.task.name})` : ""} in run ${claim.runId}.`,
        logMessage: "completed task",
        level: "info",
        details: {
          outcome: "succeeded",
          taskName: claim.task?.name,
        },
      });
    } catch (error) {
      if (activeRun?.finalized !== true) {
        const details = {
          ...describeError(error),
          taskName: claim.task?.name,
        };

        await reportTerminalOutcome(claim, {
          outcome: "failed",
          progressState: isAbortError(error) || shutdownController.signal.aborted ? "canceled" : "failed",
          summary: isAbortError(error) || shutdownController.signal.aborted
            ? `Worker run canceled for task ${claim.taskId}${claim.task?.name ? ` (${claim.task.name})` : ""} in run ${claim.runId}.`
            : `Worker run failed for task ${claim.taskId}${claim.task?.name ? ` (${claim.task.name})` : ""} in run ${claim.runId}.`,
          logMessage: isAbortError(error) || shutdownController.signal.aborted
            ? "worker run canceled"
            : "worker run failed",
          level: isAbortError(error) || shutdownController.signal.aborted ? "warn" : "error",
          details,
        });
      }

      if (isAbortError(error) || shutdownController.signal.aborted) {
        break;
      }

      throw error;
    } finally {
      activeRun = undefined;
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
