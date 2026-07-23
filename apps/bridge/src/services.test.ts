import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import { createBridgeServices } from "./services.js";
import { InMemoryStateStore } from "@clickup-openclaw/state";
import type {
  BridgeToWorkboardCard,
  ClickUpTask,
  OpenClawWorkboardCardStatus,
} from "@clickup-openclaw/shared";

class FakeOpenClawWorkboardAdapter {
  public readonly created: BridgeToWorkboardCard[] = [];

  public readonly dispatched: Array<{ boardId?: string; maxStarts?: number }> = [];

  async createCard(input: BridgeToWorkboardCard) {
    this.created.push(input);
    return {
      id: `card-${this.created.length}`,
      status: "ready" as OpenClawWorkboardCardStatus,
      raw: {
        id: `card-${this.created.length}`,
        status: "ready",
      },
    };
  }

  async dispatch(input: { boardId?: string; maxStarts?: number } = {}) {
    this.dispatched.push(input);
    return {
      started: this.created.length,
    };
  }

  async showCard(id: string) {
    return {
      id,
      status: "ready" as OpenClawWorkboardCardStatus,
      raw: {
        id,
        status: "ready",
      },
    };
  }

  async listCards() {
    return [];
  }
}

function buildConfig() {
  return loadConfig({
    PORT: "8787",
    HOST: "127.0.0.1",
  });
}

function buildSeedTask(id: string): ClickUpTask {
  return {
    id,
    name: `Task ${id}`,
    status: "ready for openclaw",
    tags: [],
  };
}

test("ingestWebhook automatically creates and dispatches eligible cards once", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  const first = await services.ingestWebhook({
    event: "taskUpdated",
    taskId: "task-1",
    status: "ready for openclaw",
    updatedAt: "2026-07-23T10:00:00.000Z",
  });

  assert.deepEqual(first, { accepted: true, duplicate: false });
  assert.equal(adapter.created.length, 1);
  assert.equal(adapter.dispatched.length, 1);
  assert.equal(services.state.getJob("task-1")?.workboardCardId, "card-1");
  assert.equal(services.state.getJob("task-1")?.bridgeState, "dispatched");

  const second = await services.ingestWebhook({
    event: "taskUpdated",
    taskId: "task-1",
    status: "ready for openclaw",
    updatedAt: "2026-07-23T10:05:00.000Z",
  });

  assert.deepEqual(second, { accepted: true, duplicate: false });
  assert.equal(adapter.created.length, 1);
  assert.equal(adapter.dispatched.length, 1);
  assert.equal(services.state.getJob("task-1")?.workboardCardId, "card-1");
  assert.equal(services.state.getJob("task-1")?.bridgeState, "dispatched");
});

test("dispatchOpenClawWorkboard only advances queued cards", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  state.upsertJob({
    task: buildSeedTask("queued-task"),
    state: "eligible",
    bridgeState: "card_created",
    claim: undefined,
    handoffPayload: undefined,
    workboardCardId: "card-queued",
    openClawCardStatus: "ready",
    handedOffAt: "2026-07-23T10:00:00.000Z",
    dispatchedAt: undefined,
    idempotencyKey: "queued-task::taskUpdated::ready for openclaw::2026-07-23T10:00:00.000Z",
    workType: undefined,
    workflowTemplate: undefined,
    decompositionPlan: undefined,
    triageReason: undefined,
    template: undefined,
    retryCount: 0,
    lastError: undefined,
    lastEventAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    events: [],
    blockedAt: undefined,
    claimedAt: undefined,
    terminalAt: undefined,
    outcome: undefined,
    deadLetteredAt: undefined,
    deadLetterReason: undefined,
  });

  state.upsertJob({
    task: buildSeedTask("synced-task"),
    state: "succeeded",
    bridgeState: "synced_back",
    claim: undefined,
    handoffPayload: undefined,
    workboardCardId: "card-synced",
    openClawCardStatus: "done",
    handedOffAt: "2026-07-23T09:00:00.000Z",
    dispatchedAt: "2026-07-23T09:05:00.000Z",
    idempotencyKey: "synced-task::taskUpdated::ready for openclaw::2026-07-23T09:00:00.000Z",
    workType: undefined,
    workflowTemplate: undefined,
    decompositionPlan: undefined,
    triageReason: undefined,
    template: undefined,
    retryCount: 0,
    lastError: undefined,
    lastEventAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T09:05:00.000Z",
    events: [],
    blockedAt: undefined,
    claimedAt: undefined,
    terminalAt: "2026-07-23T09:30:00.000Z",
    outcome: "succeeded",
    deadLetteredAt: undefined,
    deadLetterReason: undefined,
  });

  const result = await services.dispatchOpenClawWorkboard();

  assert.equal(adapter.dispatched.length, 1);
  assert.equal(result.dispatchedAt.length > 0, true);
  assert.equal(services.state.getJob("queued-task")?.bridgeState, "dispatched");
  assert.equal(services.state.getJob("synced-task")?.bridgeState, "synced_back");
});
