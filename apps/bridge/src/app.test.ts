import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeApp } from "./app.js";

test("operator endpoints map state-guard errors to client errors", async () => {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => logger,
  };

  const app = createBridgeApp({
    clickup: undefined,
    openClawWatchIntervalMs: 0,
    getMetricsSnapshot: () => ({}),
    getControlState: () => ({}),
    ingestWebhook: async () => ({}),
    syncList: async () => ({}),
    handoffJobToOpenClaw: async () => ({}),
    redispatchEligibleJob: async () => {
      throw new Error("Task task-1 is not eligible for dispatch");
    },
    dispatchOpenClawWorkboard: async () => ({}),
    refreshOpenClawCard: async () => ({}),
    syncOpenClawCardToClickUp: async () => ({}),
    requeueJob: async () => {
      throw new Error("Task task-1 is already active");
    },
    markJobBlocked: async () => {
      throw new Error("Task task-1 is not active");
    },
    forceHumanReviewJob: async () => {
      throw new Error("Task task-1 is not ready for human review");
    },
    watchOpenClawCards: async () => ({}),
    pauseWork: async () => ({}),
    resumeWork: async () => ({}),
    listJobs: () => [],
    getDashboardSnapshot: () => ({ queueHealth: {}, completionRates: {} }),
    reconcilePersistedState: async () => undefined,
    logger,
  } as never);

  try {
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/openclaw/task-1/redispatch" }),
      app.inject({ method: "POST", url: "/openclaw/task-1/requeue" }),
      app.inject({ method: "POST", url: "/openclaw/task-1/block", payload: { reason: "blocked" } }),
      app.inject({ method: "POST", url: "/openclaw/task-1/review", payload: { reason: "review" } }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [409, 409, 409, 409],
    );
    for (const response of responses) {
      assert.match((JSON.parse(response.body) as { error: string }).error, /Task task-1/);
    }
  } finally {
    await app.close();
  }
});
