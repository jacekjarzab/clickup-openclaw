import { createClickUpClient } from "@clickup-openclaw/clickup-client";
import { createLogger } from "@clickup-openclaw/observability";
import {
  claimRecordSchema,
  clickupWebhookEventSchema,
  workerEventSchema,
  workboardStateSchema,
} from "@clickup-openclaw/shared";
import { InMemoryStateStore } from "@clickup-openclaw/state";
import { InMemoryWorkboard } from "@clickup-openclaw/workboard";
import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "./config.js";

const DEFAULT_LEASE_SECONDS = 15 * 60;

function nowIso(): string {
  return new Date().toISOString();
}

function toLeaseExpiry(startedAt: string, leaseSeconds: number): string {
  return new Date(Date.parse(startedAt) + leaseSeconds * 1000).toISOString();
}

function deriveIdempotencyKey(event: {
  event: string;
  taskId: string;
  status?: string | undefined;
  updatedAt?: string | undefined;
}): string {
  return [event.event, event.taskId, event.status ?? "unknown", event.updatedAt ?? "unknown"].join(
    "::",
  );
}

function isEligibleForOpenClaw(status?: string): boolean {
  return status?.trim().toLowerCase() === "ready for openclaw";
}

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
    const idempotencyKey = deriveIdempotencyKey(event);
    const receivedAt = nowIso();

    if (state.hasIdempotencyKey(idempotencyKey)) {
      logger.info("webhook duplicate ignored", { event: event.event, taskId: event.taskId });
      return { accepted: true, duplicate: true };
    }

    state.recordIdempotency({
      key: idempotencyKey,
      taskId: event.taskId,
      event: event.event,
      firstSeenAt: receivedAt,
      lastSeenAt: receivedAt,
    });

    logger.info("webhook received", { event: event.event, taskId: event.taskId });

    const current = state.getJob(event.taskId);
    if (current === undefined) {
      workboard.enqueue({
        taskId: event.taskId,
        priority: 0,
        requestedAt: receivedAt,
        idempotencyKey,
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
      state: isEligibleForOpenClaw(event.status) ? "eligible" : "normalized",
      claim: undefined,
      idempotencyKey,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: receivedAt,
      updatedAt: receivedAt,
      events: [],
    });

    if (isEligibleForOpenClaw(event.status)) {
      workboard.enqueue({
        taskId: event.taskId,
        priority: 0,
        requestedAt: receivedAt,
        idempotencyKey,
      });
    }

    return { accepted: true, duplicate: false };
  }

  async function claimNextJob(input?: { leaseSeconds?: number | undefined }) {
    const leaseSeconds = input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    const now = nowIso();

    workboard.reclaimExpired(now);
    const next = workboard.next();
    if (next === undefined) {
      return null;
    }

    const runId = randomUUID();
    const claim = claimRecordSchema.parse({
      taskId: next.taskId,
      runId,
      workboardId: `workboard-${next.taskId}`,
      leaseStartedAt: now,
      leaseExpiresAt: toLeaseExpiry(now, leaseSeconds),
      leaseSeconds,
    });

    workboard.claim(claim);
    state.mergeJob(next.taskId, {
      state: "leased",
      claim,
      retryCount: (state.getJob(next.taskId)?.retryCount ?? 0) + 1,
      updatedAt: now,
    });

    if (clickup !== undefined) {
      await clickup.postTaskComment(next.taskId, "Claimed by OpenClaw, starting work.");
      await clickup.updateTaskMetadata(next.taskId, {
        status: "in progress",
        customFields: {
          run_id: runId,
          workboard_id: claim.workboardId,
          automation_state: "claimed",
          last_sync_at: now,
        },
      });
    }

    logger.info("job claimed", { taskId: next.taskId, runId });

    return {
      taskId: next.taskId,
      runId,
      leaseExpiresAt: claim.leaseExpiresAt,
      leaseSeconds,
      requestedAt: next.requestedAt,
      task: state.getJob(next.taskId)?.task,
    };
  }

  async function heartbeatJob(taskId: string, input?: { leaseSeconds?: number | undefined }) {
    const current = workboard.getClaim(taskId);
    if (current === undefined) {
      return null;
    }

    const leaseStartedAt = nowIso();
    const leaseSeconds = input?.leaseSeconds ?? current.leaseSeconds;
    const renewed = workboard.renew(taskId, toLeaseExpiry(leaseStartedAt, leaseSeconds));
    if (renewed === undefined) {
      return null;
    }

    state.mergeJob(taskId, {
      claim: renewed,
      updatedAt: leaseStartedAt,
    });

    return renewed;
  }

  async function recordWorkerEvent(taskId: string, input: unknown) {
    const event = workerEventSchema.parse(input);
    if (event.taskId !== taskId) {
      throw new Error(`Task mismatch for event on ${taskId}`);
    }

    const recorded = state.appendJobEvent(taskId, event);
    if (recorded === undefined) {
      return null;
    }

    logger.info("worker event recorded", {
      taskId,
      runId: event.runId,
      kind: event.kind,
      ...(event.kind === "log"
        ? { level: event.level }
        : { step: event.step, progressState: event.state }),
    });

    return recorded;
  }

  async function completeJob(
    taskId: string,
    input: { outcome: "succeeded" | "failed" | "blocked"; summary: string },
  ) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const claim = workboard.getClaim(taskId);
    const completedAt = nowIso();
    workboard.release(taskId);

    const nextState = workboardStateSchema.parse(
      input.outcome === "succeeded" ? "succeeded" : input.outcome === "blocked" ? "blocked" : "failed",
    );

    state.mergeJob(taskId, {
      state: nextState,
      claim: undefined,
      lastError: input.outcome === "succeeded" ? undefined : input.summary,
      updatedAt: completedAt,
    });

    if (clickup !== undefined) {
      await clickup.postTaskComment(taskId, input.summary);
      await clickup.updateTaskMetadata(taskId, {
        status:
          input.outcome === "succeeded"
            ? "done"
            : input.outcome === "blocked"
              ? "blocked"
              : "failed",
        customFields: {
          automation_state:
            input.outcome === "succeeded"
              ? "done"
              : input.outcome === "blocked"
                ? "blocked"
                : "manual",
          last_sync_at: completedAt,
          last_error: input.outcome === "succeeded" ? "" : input.summary,
          run_id: claim?.runId ?? current.claim?.runId ?? "",
          workboard_id: claim?.workboardId ?? current.claim?.workboardId ?? "",
        },
      });
    }

    logger.info("job completed", { taskId, outcome: input.outcome });
    return {
      taskId,
      outcome: input.outcome,
      completedAt,
    };
  }

  return {
    logger,
    state,
    workboard,
    clickup,
    ingestWebhook,
    claimNextJob,
    heartbeatJob,
    recordWorkerEvent,
    completeJob,
    listJobs: () => state.listJobs(),
  };
}
