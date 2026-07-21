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
import { resolveRepoUrl } from "./repo-url.js";

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

type ArtifactLinks = {
  repoUrl?: string;
  prUrl?: string;
  artifactUrl?: string;
  docsUrl?: string;
  designUrl?: string;
};

function buildArtifactComment(summary: string, links: ArtifactLinks): string {
  const lines = [summary];
  const linkLines = [
    links.repoUrl === undefined ? undefined : `- Repo: ${links.repoUrl}`,
    links.prUrl === undefined ? undefined : `- PR: ${links.prUrl}`,
    links.artifactUrl === undefined ? undefined : `- Preview or deployment: ${links.artifactUrl}`,
    links.docsUrl === undefined ? undefined : `- Docs: ${links.docsUrl}`,
    links.designUrl === undefined ? undefined : `- Design: ${links.designUrl}`,
  ].filter((line): line is string => line !== undefined);

  if (linkLines.length > 0) {
    lines.push("", "Useful links:", ...linkLines);
  }

  return lines.join("\n");
}

function buildHeartbeatComment(taskId: string, leaseExpiresAt: string): string {
  return [
    `OpenClaw detected a missed heartbeat for task ${taskId}.`,
    `The lease expired at ${leaseExpiresAt}, so the task was requeued for another attempt.`,
  ].join("\n");
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createBridgeServices(config: BridgeConfig) {
  const logger = createLogger("bridge");
  const state = new InMemoryStateStore();
  const workboard = new InMemoryWorkboard();
  const repoUrl = resolveRepoUrl(config);
  const prUrl = config.PR_URL ?? config.CLICKUP_PR_URL;
  const artifactUrl = config.ARTIFACT_URL ?? config.CLICKUP_ARTIFACT_URL;
  const docsUrl = config.DOCS_URL ?? config.CLICKUP_DOCS_URL;
  const designUrl = config.DESIGN_URL ?? config.CLICKUP_DESIGN_URL;
  const heartbeatMonitorIntervalMs = Number(config.HEARTBEAT_MONITOR_INTERVAL_MS ?? "60000");
  const queueStallAlertMs = toNumber(config.QUEUE_STALL_ALERT_MS, 10 * 60 * 1000);
  const artifactLinks: ArtifactLinks = {};
  if (repoUrl !== undefined) {
    artifactLinks.repoUrl = repoUrl;
  }
  if (prUrl !== undefined) {
    artifactLinks.prUrl = prUrl;
  }
  if (artifactUrl !== undefined) {
    artifactLinks.artifactUrl = artifactUrl;
  }
  if (docsUrl !== undefined) {
    artifactLinks.docsUrl = docsUrl;
  }
  if (designUrl !== undefined) {
    artifactLinks.designUrl = designUrl;
  }
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
        repoUrl,
        prUrl,
        artifactUrl,
        docsUrl,
        designUrl,
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
      claimedAt: now,
      retryCount: (state.getJob(next.taskId)?.retryCount ?? 0) + 1,
      updatedAt: now,
    });

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(next.taskId, "Claimed by OpenClaw, starting work.");
        await clickup.updateTaskMetadata(next.taskId, {
          status: "in progress",
          customFields: {
            run_id: runId,
            workboard_id: claim.workboardId,
            automation_state: "claimed",
            last_sync_at: now,
            ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
            ...(prUrl === undefined ? {} : { pr_url: prUrl }),
            ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
            ...(docsUrl === undefined ? {} : { docs_url: docsUrl }),
            ...(designUrl === undefined ? {} : { design_url: designUrl }),
          },
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(next.taskId, {
        state: "deadLettered",
        claim: undefined,
        outcome: "deadLettered",
        terminalAt: nowIso(),
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      workboard.release(next.taskId);
      logger.error("job dead-lettered during claim write-back", { taskId: next.taskId, reason });
      throw error;
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

  async function monitorHeartbeats(input?: { now?: string | undefined }) {
    const now = input?.now ?? nowIso();
    const reclaimed = workboard.reclaimExpired(now);
    const notified: Array<{ taskId: string; reason: string }> = [];

    for (const item of reclaimed) {
      const current = state.getJob(item.taskId);
      const leaseExpiresAt = current?.claim?.leaseExpiresAt;
      const reason = leaseExpiresAt
        ? `Lease expired at ${leaseExpiresAt} and task was requeued.`
        : "Lease expired and task was requeued.";

      state.mergeJob(item.taskId, {
        state: "reclaimed",
        claim: undefined,
        lastError: reason,
        updatedAt: now,
      });

      if (clickup !== undefined) {
        try {
          await clickup.postTaskComment(item.taskId, buildHeartbeatComment(item.taskId, leaseExpiresAt ?? now));
          await clickup.updateTaskMetadata(item.taskId, {
            status: "ready for openclaw",
            customFields: {
              automation_state: "candidate",
              last_sync_at: now,
              last_error: reason,
              ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
              ...(prUrl === undefined ? {} : { pr_url: prUrl }),
              ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
              ...(docsUrl === undefined ? {} : { docs_url: docsUrl }),
              ...(designUrl === undefined ? {} : { design_url: designUrl }),
            },
          });
        } catch (error) {
          logger.warn("failed to report reclaimed heartbeat", {
            taskId: item.taskId,
            error: String(error),
          });
        }
      }

      logger.warn("job reclaimed after missed heartbeat", {
        taskId: item.taskId,
        leaseExpiresAt: leaseExpiresAt ?? null,
      });
      notified.push({ taskId: item.taskId, reason });
    }

    const queuedItems = workboard.listQueuedItems();
    const queueAgeMs = queuedItems.reduce((oldest, item) => {
      const ageMs = Date.parse(now) - Date.parse(item.requestedAt);
      return Math.max(oldest, Number.isFinite(ageMs) ? ageMs : 0);
    }, 0);
    const staleClaims = workboard.listClaims().filter((claim) => claim.leaseExpiresAt <= now);

    if (staleClaims.length > 0 || queueAgeMs >= queueStallAlertMs) {
      logger.error("queue stall detected", {
        queueDepth: queuedItems.length,
        staleClaims: staleClaims.length,
        queueAgeMs,
        queueStallAlertMs,
      });
    }

    return { now, reclaimed, notified };
  }

  function getMetricsSnapshot(input?: { now?: string | undefined }) {
    const now = input?.now ?? nowIso();
    const jobs = state.listJobs();
    const claims = workboard.listClaims();
    const queuedItems = workboard.listQueuedItems();

    const jobCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.state] = (counts[job.state] ?? 0) + 1;
      return counts;
    }, {});

    const terminalJobs = jobs.filter((job) => job.terminalAt !== undefined && job.claimedAt !== undefined);
    const averageClaimToTerminalMs =
      terminalJobs.length === 0
        ? 0
        : Math.round(
            terminalJobs.reduce((sum, job) => {
              return sum + (Date.parse(job.terminalAt ?? now) - Date.parse(job.claimedAt ?? now));
            }, 0) / terminalJobs.length,
          );

    const oldestQueuedAgeMs =
      queuedItems.length === 0
        ? 0
        : Math.max(
            ...queuedItems.map((item) => {
              const ageMs = Date.parse(now) - Date.parse(item.requestedAt);
              return Number.isFinite(ageMs) ? ageMs : 0;
            }),
          );

    return {
      now,
      queueDepth: queuedItems.length,
      activeClaims: claims.length,
      staleClaims: claims.filter((claim) => claim.leaseExpiresAt <= now).length,
      jobCounts,
      throughput: {
        terminalJobs: terminalJobs.length,
        deadLetteredJobs: jobs.filter((job) => job.outcome === "deadLettered").length,
      },
      latency: {
        averageClaimToTerminalMs,
        oldestQueuedAgeMs,
      },
      thresholds: {
        queueStallAlertMs,
      },
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

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(taskId, buildArtifactComment(input.summary, artifactLinks));
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
            ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
            ...(prUrl === undefined ? {} : { pr_url: prUrl }),
            ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
            ...(docsUrl === undefined ? {} : { docs_url: docsUrl }),
            ...(designUrl === undefined ? {} : { design_url: designUrl }),
          },
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(taskId, {
        state: "deadLettered",
        claim: undefined,
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      logger.error("job dead-lettered during completion write-back", { taskId, reason });
      throw error;
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
    monitorHeartbeats,
    heartbeatMonitorIntervalMs,
    queueStallAlertMs,
    getMetricsSnapshot,
    listJobs: () => state.listJobs(),
  };
}
