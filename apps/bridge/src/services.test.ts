import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import {
  buildOpenClawStatusComment,
  createBridgeServices,
  extractOpenClawTerminalContext,
} from "./services.js";
import { InMemoryStateStore, type JobRecord } from "@clickup-openclaw/state";
import type {
  BridgeToWorkboardCard,
  ClickUpTask,
  OpenClawWorkboardCardStatus,
} from "@clickup-openclaw/shared";

class FakeOpenClawWorkboardAdapter {
  public readonly created: BridgeToWorkboardCard[] = [];

  public readonly dispatched: Array<{ boardId?: string; maxStarts?: number }> = [];

  public readonly showCalls: string[] = [];

  public readonly listCalls: Array<{ boardId?: string; status?: OpenClawWorkboardCardStatus }> = [];

  public readonly showResponses = new Map<string, { status: OpenClawWorkboardCardStatus; raw: Record<string, unknown> }>();

  public readonly listResponses: Array<
    Array<{ id: string; status?: OpenClawWorkboardCardStatus; raw: Record<string, unknown> }>
  > = [];

  public createAttempts = 0;

  public dispatchAttempts = 0;

  public listAttempts = 0;

  public readonly createFailures: unknown[] = [];

  public readonly dispatchFailures: unknown[] = [];

  async createCard(input: BridgeToWorkboardCard) {
    this.createAttempts += 1;
    const failure = this.createFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }

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
    this.dispatchAttempts += 1;
    const failure = this.dispatchFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }

    this.dispatched.push(input);
    return {
      started: this.created.length,
    };
  }

  async showCard(id: string) {
    this.showCalls.push(id);
    const response = this.showResponses.get(id);
    if (response !== undefined) {
      return {
        id,
        status: response.status,
        raw: response.raw,
        terminalContext: extractOpenClawTerminalContext(response.raw, response.status),
      };
    }

    return {
      id,
      status: "ready" as OpenClawWorkboardCardStatus,
      raw: {
        id,
        status: "ready",
      },
      terminalContext: extractOpenClawTerminalContext(
        {
          id,
          status: "ready",
        },
        "ready",
      ),
    };
  }

  async listCards(input: { boardId?: string; status?: OpenClawWorkboardCardStatus } = {}) {
    this.listAttempts += 1;
    this.listCalls.push(input);
    const next = this.listResponses.shift();
    if (next !== undefined) {
      return next;
    }

    return [];
  }
}

function buildConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    PORT: "8787",
    HOST: "127.0.0.1",
    BRIDGE_RETRY_MAX_ATTEMPTS: "2",
    BRIDGE_RETRY_BASE_DELAY_MS: "0",
    BRIDGE_RETRY_MAX_DELAY_MS: "0",
    BRIDGE_DEAD_LETTER_THRESHOLD: "2",
    BRIDGE_STALE_CARD_AGE_MS: "0",
    BRIDGE_INTERRUPTED_RUN_AGE_MS: "0",
    ...overrides,
  });
}

function buildClickUpConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    PORT: "8787",
    HOST: "127.0.0.1",
    CLICKUP_API_TOKEN: "token",
    CLICKUP_BASE_URL: "https://example.invalid/api/v2",
    ...overrides,
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

function buildJobRecord(taskId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const task = overrides.task ?? buildSeedTask(taskId);
  return {
    task,
    state: "eligible",
    bridgeState: "eligible",
    claim: undefined,
    handoffPayload: undefined,
    workboardCardId: undefined,
    openClawCardStatus: undefined,
    terminalContext: undefined,
    clickupWriteBack: undefined,
    handedOffAt: undefined,
    dispatchedAt: undefined,
    idempotencyKey: `${taskId}::taskUpdated::ready for openclaw::2026-07-23T10:00:00.000Z`,
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
    ...overrides,
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

test("ingestWebhook ignores duplicate webhook deliveries with the same idempotency key", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  const first = await services.ingestWebhook({
    event: "taskUpdated",
    taskId: "task-dup",
    status: "ready for openclaw",
    updatedAt: "2026-07-23T10:00:00.000Z",
  });

  const second = await services.ingestWebhook({
    event: "taskUpdated",
    taskId: "task-dup",
    status: "ready for openclaw",
    updatedAt: "2026-07-23T10:00:00.000Z",
  });

  assert.deepEqual(first, { accepted: true, duplicate: false });
  assert.deepEqual(second, { accepted: true, duplicate: true });
  assert.equal(adapter.created.length, 1);
  assert.equal(adapter.dispatched.length, 1);
  assert.equal(services.state.getJob("task-dup")?.workboardCardId, "card-1");
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

test("handoff retries transient gateway failures and dead-letters after repeated attempts", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.createFailures.push(new Error("temporary gateway unavailable"), new Error("temporary gateway unavailable"));
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(
    async () =>
      services.ingestWebhook({
        event: "taskUpdated",
        taskId: "task-handoff",
        status: "ready for openclaw",
        updatedAt: "2026-07-23T10:00:00.000Z",
      }),
    /temporary gateway unavailable/,
  );

  const job = services.state.getJob("task-handoff");
  assert.equal(adapter.createAttempts, 2);
  assert.equal(job?.bridgeState, "dead_lettered");
  assert.equal(job?.outcome, "deadLettered");
  assert.equal(job?.retryCount, 2);
  assert.equal(job?.deadLetteredAt !== undefined, true);
  assert.match(job?.deadLetterReason ?? "", /temporary gateway unavailable/);
});

test("handoff clears failed outcome after a successful retry", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.createFailures.push(new Error("temporary gateway unavailable"));
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  state.upsertJob(
    buildJobRecord("task-recover", {
      bridgeState: "eligible",
      outcome: "failed",
      lastError: "temporary gateway unavailable",
    }),
  );

  const result = await services.handoffJobToOpenClaw("task-recover");

  assert.equal(adapter.createAttempts, 2);
  assert.equal(result.duplicate, false);
  assert.equal(services.state.getJob("task-recover")?.outcome, undefined);
  assert.equal(services.state.getJob("task-recover")?.lastError, undefined);
});

test("handoff does not retry bridge errors that merely mention 500 in identifiers", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.createFailures.push(new Error("OpenClaw card card-5001 not found: 404"));
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  state.upsertJob(
    buildJobRecord("task-5001", {
      bridgeState: "eligible",
    }),
  );

  await assert.rejects(async () => services.handoffJobToOpenClaw("task-5001"), /404/);
  assert.equal(adapter.createAttempts, 1);
});

test("dispatch retries transient failures and dead-letters queued cards after the threshold", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.dispatchFailures.push(new Error("temporary gateway unavailable"), new Error("temporary gateway unavailable"));
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(
    async () =>
      services.ingestWebhook({
        event: "taskUpdated",
        taskId: "task-dispatch",
        status: "ready for openclaw",
        updatedAt: "2026-07-23T10:00:00.000Z",
      }),
    /temporary gateway unavailable/,
  );

  const job = services.state.getJob("task-dispatch");
  assert.equal(adapter.dispatchAttempts, 2);
  assert.equal(job?.bridgeState, "dead_lettered");
  assert.equal(job?.outcome, "deadLettered");
  assert.equal(job?.retryCount, 2);
  assert.equal(job?.deadLetteredAt !== undefined, true);
  assert.match(job?.deadLetterReason ?? "", /temporary gateway unavailable/);
});

test("handoff stops retrying contract errors after the first failure", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.createFailures.push(new Error("unrecognized key: unexpected"));
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(
    async () =>
      services.ingestWebhook({
        event: "taskUpdated",
        taskId: "task-contract",
        status: "ready for openclaw",
        updatedAt: "2026-07-23T10:00:00.000Z",
      }),
    /unrecognized key/i,
  );

  const job = services.state.getJob("task-contract");
  assert.equal(adapter.createAttempts, 1);
  assert.equal(job?.bridgeState, "eligible");
  assert.equal(job?.outcome, "failed");
  assert.equal(job?.retryCount, 1);
  assert.equal(job?.deadLetteredAt, undefined);
});

test("manual redispatch starts an eligible job without creating a duplicate card", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  state.upsertJob(
    buildJobRecord("task-redispatch", {
      bridgeState: "eligible",
      workboardCardId: "card-redispatch",
      openClawCardStatus: "ready",
      handedOffAt: "2026-07-23T09:00:00.000Z",
    }),
  );

  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  const result = await services.redispatchEligibleJob("task-redispatch");

  assert.equal(result.dispatched, true);
  assert.equal(adapter.createAttempts, 0);
  assert.equal(adapter.dispatchAttempts, 1);
  assert.equal(services.state.getJob("task-redispatch")?.bridgeState, "dispatched");
});

test("manual redispatch rejects already active or terminal jobs", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  state.upsertJob(
    buildJobRecord("task-redispatch-reject", {
      bridgeState: "dispatched",
      workboardCardId: "card-redispatch-reject",
    }),
  );

  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(async () => services.redispatchEligibleJob("task-redispatch-reject"), /not eligible/i);

  state.mergeJob("task-redispatch-reject", { bridgeState: "synced_back" });
  await assert.rejects(async () => services.redispatchEligibleJob("task-redispatch-reject"), /not eligible/i);
});

test("requeue clears terminal bridge state and returns the task to eligible", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  state.upsertJob(
    buildJobRecord("task-requeue", {
      bridgeState: "dead_lettered",
      state: "failed",
      workboardCardId: "card-requeue",
      openClawCardStatus: "done",
      outcome: "deadLettered",
      retryCount: 3,
      deadLetteredAt: "2026-07-23T10:30:00.000Z",
      deadLetterReason: "temporary gateway unavailable",
      terminalAt: "2026-07-23T10:30:00.000Z",
      lastError: "temporary gateway unavailable",
    }),
  );

  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  const result = await services.requeueJob("task-requeue");

  assert.equal(result.requeued, true);
  assert.equal(services.state.getJob("task-requeue")?.bridgeState, "eligible");
  assert.equal(services.state.getJob("task-requeue")?.workboardCardId, undefined);
  assert.equal(services.state.getJob("task-requeue")?.outcome, undefined);
  assert.equal(services.state.getJob("task-requeue")?.deadLetteredAt, undefined);
  assert.equal(services.state.getJob("task-requeue")?.retryCount, 0);
});

test("requeue rejects already eligible or active jobs", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  state.upsertJob(buildJobRecord("task-requeue-reject", { bridgeState: "eligible" }));

  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(async () => services.requeueJob("task-requeue-reject"), /already active/i);

  state.mergeJob("task-requeue-reject", { bridgeState: "dispatched" });
  await assert.rejects(async () => services.requeueJob("task-requeue-reject"), /already active/i);
});

test("markJobBlocked writes blocked state and stops the watcher from picking it up", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    const adapter = new FakeOpenClawWorkboardAdapter();
    state.upsertJob(
      buildJobRecord("task-blocked", {
        bridgeState: "dispatched",
        state: "running",
        workboardCardId: "card-blocked",
      }),
    );

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    const result = await services.markJobBlocked("task-blocked", "Waiting on staging credentials");
    const watched = await services.watchOpenClawCards();

    assert.equal(result.blocked, true);
    assert.equal(services.state.getJob("task-blocked")?.bridgeState, "blocked");
    assert.equal(services.state.getJob("task-blocked")?.outcome, "blocked");
    assert.equal(services.state.getJob("task-blocked")?.blockedAt !== undefined, true);
    assert.equal(adapter.showCalls.length, 0);
    assert.equal(watched.watched, 0);
    assert.equal(clickUpCalls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(clickUpCalls.filter((call) => call.method === "POST").length, 1);
    assert.match(clickUpCalls.find((call) => call.method === "POST")?.body ?? "", /Waiting on staging credentials/);
    const blockedWriteBack = JSON.parse(clickUpCalls.find((call) => call.method === "PUT")?.body ?? "{}") as {
      custom_fields?: Array<{ id: string; value: string }>;
    };
    assert.equal(
      blockedWriteBack.custom_fields?.find((field) => field.id === "last_sync_at")?.value,
      services.state.getJob("task-blocked")?.updatedAt,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("markJobBlocked rejects settled jobs", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  state.upsertJob(
    buildJobRecord("task-blocked-reject", {
      bridgeState: "synced_back",
      outcome: "succeeded",
      workboardCardId: "card-blocked-reject",
    }),
  );

  const services = createBridgeServices(buildClickUpConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(async () => services.markJobBlocked("task-blocked-reject", "irrelevant"), /not active/i);
});

test("forceHumanReviewJob writes a human-review handoff and removes the task from automation", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    const adapter = new FakeOpenClawWorkboardAdapter();
    state.upsertJob(
      buildJobRecord("task-review", {
        bridgeState: "running",
        state: "running",
        workboardCardId: "card-review",
        openClawCardStatus: "running",
      }),
    );

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    const result = await services.forceHumanReviewJob("task-review", "Needs another set of eyes");
    const watched = await services.watchOpenClawCards();

    assert.equal(result.forced, true);
    assert.equal(services.state.getJob("task-review")?.bridgeState, "synced_back");
    assert.equal(services.state.getJob("task-review")?.outcome, "succeeded");
    assert.equal(services.state.getJob("task-review")?.openClawCardStatus, "review");
    assert.equal(adapter.showCalls.length, 0);
    assert.equal(watched.watched, 0);
    assert.equal(clickUpCalls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(clickUpCalls.filter((call) => call.method === "POST").length, 1);
    assert.match(clickUpCalls.find((call) => call.method === "POST")?.body ?? "", /human review/i);
    const reviewWriteBack = JSON.parse(clickUpCalls.find((call) => call.method === "PUT")?.body ?? "{}") as {
      custom_fields?: Array<{ id: string; value: string }>;
    };
    assert.equal(
      reviewWriteBack.custom_fields?.find((field) => field.id === "last_sync_at")?.value,
      services.state.getJob("task-review")?.updatedAt,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forceHumanReviewJob rejects jobs that never ran", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  state.upsertJob(buildJobRecord("task-review-reject", { bridgeState: "eligible" }));

  const services = createBridgeServices(buildClickUpConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  await assert.rejects(async () => services.forceHumanReviewJob("task-review-reject", "irrelevant"), /not ready for human review/i);
});

test("sync rereads the card on retry instead of reusing stale state", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];
  const adapter = new FakeOpenClawWorkboardAdapter();
  let putAttempts = 0;

  adapter.showResponses.set("card-sync", {
    status: "running",
    raw: {
      id: "card-sync",
      status: "running",
      summary: "Initial running state.",
    },
  });

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if ((init?.method ?? "GET") === "PUT" && String(url).includes("/task/task-sync")) {
      putAttempts += 1;
      if (putAttempts === 1) {
        adapter.showResponses.set("card-sync", {
          status: "done",
          raw: {
            id: "card-sync",
            status: "done",
            summary: "Completed after the retry.",
          },
        });

        return {
          ok: false,
          status: 400,
          json: async () => ({}),
        } as Response;
      }
    }

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    state.upsertJob(
      buildJobRecord("task-sync", {
        bridgeState: "dispatched",
        workboardCardId: "card-sync",
        openClawCardStatus: "running",
        dispatchedAt: "2026-07-23T10:05:00.000Z",
        claimedAt: "2026-07-23T10:00:00.000Z",
      }),
    );

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    await assert.rejects(async () => services.syncOpenClawCardToClickUp("task-sync"), /400/);

    const result = await services.syncOpenClawCardToClickUp("task-sync");

    assert.equal(result.synced, true);
    assert.equal(adapter.showCalls.length, 2);
    assert.equal(services.state.getJob("task-sync")?.openClawCardStatus, "done");
    assert.equal(services.state.getJob("task-sync")?.outcome, "succeeded");
    assert.ok(clickUpCalls.filter((call) => call.method === "PUT").length >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale cards are reconciled before bridge tries to create or dispatch anything new", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.listResponses.push([
    {
      id: "card-stale",
      status: "running",
      raw: {
        id: "card-stale",
        status: "running",
        metadata: {
          sourceSystem: "clickup",
          clickupTaskId: "task-stale",
          idempotencyKey: "clickup-task:task-stale",
        },
      },
    },
  ]);
  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  state.upsertJob(
    buildJobRecord("task-stale", {
      bridgeState: "card_created",
      workboardCardId: undefined,
      handedOffAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:00.000Z",
    }),
  );

  const result = await services.handoffJobToOpenClaw("task-stale");

  assert.equal(adapter.listAttempts, 1);
  assert.equal(adapter.createAttempts, 0);
  assert.equal(result.duplicate, true);
  assert.equal(services.state.getJob("task-stale")?.workboardCardId, "card-stale");
  assert.equal(services.state.getJob("task-stale")?.openClawCardStatus, "running");
});

test("interrupted runs are reconciled on startup before resuming work", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.showResponses.set("card-running", {
    status: "running",
    raw: {
      id: "card-running",
      status: "running",
      summary: "The card was already running before the restart.",
    },
  });

  state.upsertJob(
    buildJobRecord("task-running", {
      bridgeState: "dispatched",
      workboardCardId: "card-running",
      openClawCardStatus: undefined,
      claim: undefined,
      dispatchedAt: undefined,
      handedOffAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:00.000Z",
    }),
  );

  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  const reconciled = await services.reconcilePersistedState();

  assert.equal(reconciled.reconciled, 1);
  assert.equal(adapter.showCalls.length, 1);
  assert.equal(services.state.getJob("task-running")?.openClawCardStatus, "running");
  assert.equal(services.state.getJob("task-running")?.bridgeState, "running");
});

test("startup reconciliation recovers an existing mapped card instead of creating a duplicate", async () => {
  const state = new InMemoryStateStore();
  const adapter = new FakeOpenClawWorkboardAdapter();
  adapter.listResponses.push([
    {
      id: "card-recovered",
      status: "ready",
      raw: {
        id: "card-recovered",
        status: "ready",
        metadata: {
          sourceSystem: "clickup",
          clickupTaskId: "task-recover",
          idempotencyKey: "clickup-task:task-recover",
        },
      },
    },
  ]);

  state.upsertJob(
    buildJobRecord("task-recover", {
      bridgeState: "eligible",
      workboardCardId: undefined,
      handedOffAt: undefined,
      updatedAt: "2026-07-23T08:00:00.000Z",
    }),
  );

  const services = createBridgeServices(buildConfig(), {
    stateStore: state,
    openClawWorkboard: adapter as never,
  });

  const result = await services.handoffJobToOpenClaw("task-recover");

  assert.equal(adapter.listAttempts, 1);
  assert.equal(adapter.createAttempts, 0);
  assert.equal(result.duplicate, true);
  assert.equal(services.state.getJob("task-recover")?.workboardCardId, "card-recovered");
});

test("extractOpenClawTerminalContext preserves terminal summary, proof, artifacts, comments, and blocker context", () => {
  const raw = {
    execution: {
      summary: "Finished the implementation.",
      proof: {
        note: "Verified against the local bridge test suite.",
        artifacts: [{ url: "https://example.com/artifact", title: "Preview build" }],
        comments: ["Left a follow-up note."],
        blocker_reason: "No blockers.",
      },
      comments: ["Execution note"],
    },
    artifacts: ["https://example.com/trace", { href: "https://example.com/report", title: "Run report" }],
    comment: "Single comment",
    blocker_reason: "Needs review from a human.",
  };

  const context = extractOpenClawTerminalContext(raw, "done");

  assert.equal(context.summary, "Finished the implementation.");
  assert.deepEqual(context.proof, raw.execution.proof);
  assert.deepEqual(context.artifacts, [
    "https://example.com/trace",
    { title: "Run report", url: "https://example.com/report" },
    { title: "Preview build", url: "https://example.com/artifact" },
  ]);
  assert.deepEqual(context.comments, ["Execution note", "Left a follow-up note.", "Single comment"]);
  assert.equal(context.blockerContext, "Needs review from a human.");
});

test("buildOpenClawStatusComment includes terminal context for review and blocked statuses", () => {
  const reviewComment = buildOpenClawStatusComment("review", {
    summary: "Delivered the requested change.",
    proof: {
      note: "Checked locally and in CI.",
    },
    artifacts: [{ title: "Preview build", url: "https://example.com/build" }],
    comments: ["Ready for human review."],
  });

  assert.ok(reviewComment);
  assert.match(reviewComment, /Delivered the requested change\./);
  assert.match(reviewComment, /Proof: .*Checked locally and in CI\./);
  assert.match(reviewComment, /Artifacts:/);
  assert.match(reviewComment, /Preview build \(https:\/\/example.com\/build\)/);
  assert.match(reviewComment, /Comments:/);
  assert.match(reviewComment, /Ready for human review\./);
  assert.match(reviewComment, /Next step: review the result in ClickUp and close the task if it looks right\./);

  const blockedComment = buildOpenClawStatusComment("blocked", {
    blockerContext: "Waiting on access to the staging environment.",
    proof: "No execution output was available.",
  });

  assert.ok(blockedComment);
  assert.match(blockedComment, /Waiting on access to the staging environment\./);
  assert.match(blockedComment, /Proof: No execution output was available\./);
  assert.match(blockedComment, /Next step: resolve the blocker, then rerun OpenClaw\./);

  const blockedWithSeparateSummary = buildOpenClawStatusComment("blocked", {
    summary: "The implementation is ready, but the deployment target is unavailable.",
    blockerContext: "Waiting on access to the staging environment.",
  });

  assert.ok(blockedWithSeparateSummary);
  assert.match(blockedWithSeparateSummary, /Waiting on access to the staging environment\./);
  assert.match(blockedWithSeparateSummary, /Summary: The implementation is ready, but the deployment target is unavailable\./);
});

test("buildOpenClawStatusComment falls back to concise sparse terminal summaries", () => {
  const reviewComment = buildOpenClawStatusComment("review", undefined);
  const blockedComment = buildOpenClawStatusComment("blocked", undefined);

  assert.ok(reviewComment);
  assert.match(reviewComment, /OpenClaw finished this task and returned it for human review\./);
  assert.match(reviewComment, /Next step: review the result in ClickUp and close the task if it looks right\./);
  assert.ok(blockedComment);
  assert.match(blockedComment, /OpenClaw blocked this task and needs human input before continuing\./);
  assert.match(blockedComment, /Next step: resolve the blocker, then rerun OpenClaw\./);
});

test("watchOpenClawCards posts the running start comment once", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    const adapter = new FakeOpenClawWorkboardAdapter();
    adapter.showResponses.set("card-running", {
      status: "running",
      raw: {
        id: "card-running",
        status: "running",
        summary: "OpenClaw has started the task.",
      },
    });

    state.upsertJob({
      task: {
        id: "task-running",
        name: "Running task",
        status: "ready for openclaw",
        tags: [],
      },
      state: "succeeded",
      bridgeState: "dispatched",
      claim: undefined,
      handoffPayload: undefined,
      workboardCardId: "card-running",
      openClawCardStatus: undefined,
      clickupWriteBack: undefined,
      handedOffAt: "2026-07-23T10:00:00.000Z",
      dispatchedAt: "2026-07-23T10:05:00.000Z",
      idempotencyKey: "task-running::taskUpdated::ready for openclaw::2026-07-23T10:00:00.000Z",
      workType: undefined,
      workflowTemplate: undefined,
      decompositionPlan: undefined,
      triageReason: undefined,
      template: undefined,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:05:00.000Z",
      events: [],
      blockedAt: undefined,
      claimedAt: undefined,
      terminalAt: undefined,
      outcome: undefined,
      deadLetteredAt: undefined,
      deadLetterReason: undefined,
    });

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    const first = await services.watchOpenClawCards();
    const firstCallCount = clickUpCalls.length;

    assert.equal(first.watched, 1);
    assert.equal(adapter.showCalls.length, 1);
    assert.equal(clickUpCalls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(clickUpCalls.filter((call) => call.method === "POST").length, 1);
    assert.equal(services.state.getJob("task-running")?.clickupWriteBack?.running?.statusKey, "in progress");
    assert.equal(services.state.getJob("task-running")?.clickupWriteBack?.running?.commentKey, "OpenClaw started work on this task.");

    const second = await services.watchOpenClawCards();

    assert.equal(second.watched, 1);
    assert.equal(adapter.showCalls.length, 2);
    assert.equal(clickUpCalls.length, firstCallCount);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("watchOpenClawCards rereads stale terminal cards before syncing them back", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    const adapter = new FakeOpenClawWorkboardAdapter();
    adapter.showResponses.set("card-terminal", {
      status: "done",
      raw: {
        id: "card-terminal",
        status: "done",
        summary: "Completed the stale card retry path.",
        proof: {
          note: "The bridge reread the card before syncing.",
        },
        artifacts: ["https://example.com/final"],
        comments: ["Terminal comment"],
      },
    });

    state.upsertJob({
      task: {
        id: "task-terminal",
        name: "Terminal task",
        status: "ready for openclaw",
        tags: [],
      },
      state: "succeeded",
      bridgeState: "dispatched",
      claim: undefined,
      handoffPayload: undefined,
      workboardCardId: "card-terminal",
      openClawCardStatus: "blocked",
      terminalContext: undefined,
      handedOffAt: "2026-07-23T10:00:00.000Z",
      dispatchedAt: "2026-07-23T10:05:00.000Z",
      idempotencyKey: "task-terminal::taskUpdated::ready for openclaw::2026-07-23T10:00:00.000Z",
      workType: undefined,
      workflowTemplate: undefined,
      decompositionPlan: undefined,
      triageReason: undefined,
      template: undefined,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:05:00.000Z",
      events: [],
      blockedAt: undefined,
      claimedAt: undefined,
      terminalAt: undefined,
      outcome: undefined,
      deadLetteredAt: undefined,
      deadLetterReason: undefined,
    });

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    const result = await services.watchOpenClawCards();

    assert.equal(result.watched, 1);
    assert.equal(adapter.showCalls.length, 1);
    assert.equal(adapter.showCalls[0], "card-terminal");
    assert.equal(services.state.getJob("task-terminal")?.bridgeState, "synced_back");
    assert.equal(services.state.getJob("task-terminal")?.terminalAt !== undefined, true);
    assert.equal(clickUpCalls.some((call) => call.method === "POST" && call.url.includes("/comment")), true);
    assert.equal(clickUpCalls.some((call) => call.method === "PUT" && call.url.includes("/task/task-terminal")), true);
    assert.equal(
      clickUpCalls.some((call) => call.body?.includes("Completed the stale card retry path.")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("watchOpenClawCards suppresses duplicate terminal write-backs after a partial failure", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (typeof url === "string" && url.includes("/comment")) {
      throw new Error("comment write failed");
    }

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    const adapter = new FakeOpenClawWorkboardAdapter();
    adapter.showResponses.set("card-terminal", {
      status: "done",
      raw: {
        id: "card-terminal",
        status: "done",
        summary: "Completed the stale card retry path.",
        proof: {
          note: "The bridge reread the card before syncing.",
        },
        artifacts: [{ title: "Final build", url: "https://example.com/final" }],
        comments: ["Terminal comment"],
      },
    });

    state.upsertJob({
      task: {
        id: "task-terminal",
        name: "Terminal task",
        status: "ready for openclaw",
        tags: [],
      },
      state: "succeeded",
      bridgeState: "dispatched",
      claim: undefined,
      handoffPayload: undefined,
      workboardCardId: "card-terminal",
      openClawCardStatus: "blocked",
      clickupWriteBack: undefined,
      handedOffAt: "2026-07-23T10:00:00.000Z",
      dispatchedAt: "2026-07-23T10:05:00.000Z",
      idempotencyKey: "task-terminal::taskUpdated::ready for openclaw::2026-07-23T10:00:00.000Z",
      workType: undefined,
      workflowTemplate: undefined,
      decompositionPlan: undefined,
      triageReason: undefined,
      template: undefined,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:05:00.000Z",
      events: [],
      blockedAt: undefined,
      claimedAt: undefined,
      terminalAt: undefined,
      outcome: undefined,
      deadLetteredAt: undefined,
      deadLetterReason: undefined,
    });

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    const first = await services.watchOpenClawCards();
    const firstCallCount = clickUpCalls.length;

    assert.equal(first.watched, 1);
    assert.equal(adapter.showCalls.length, 1);
    assert.equal(clickUpCalls.filter((call) => call.method === "PUT").length, 1);
    assert.ok(clickUpCalls.filter((call) => call.method === "POST").length >= 1);
    assert.equal(services.state.getJob("task-terminal")?.clickupWriteBack?.terminal?.statusKey, "done");

    const second = await services.watchOpenClawCards();

    assert.equal(second.watched, 1);
    assert.equal(adapter.showCalls.length, 2);
    assert.equal(clickUpCalls.length, firstCallCount);
    assert.equal(services.state.getJob("task-terminal")?.bridgeState, "synced_back");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("watchOpenClawCards keeps the last synced terminal status from reposting the same terminal comment", async () => {
  const originalFetch = globalThis.fetch;
  const clickUpCalls: Array<{ url: string; method: string; body?: string | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    clickUpCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const state = new InMemoryStateStore();
    const adapter = new FakeOpenClawWorkboardAdapter();
    adapter.showResponses.set("card-terminal", {
      status: "done",
      raw: {
        id: "card-terminal",
        status: "done",
        summary: "Completed the stale card retry path.",
        proof: {
          note: "The bridge reread the card before syncing.",
        },
        artifacts: [{ title: "Final build", url: "https://example.com/final" }],
        comments: ["Terminal comment"],
      },
    });

    state.upsertJob({
      task: {
        id: "task-terminal",
        name: "Terminal task",
        status: "ready for openclaw",
        tags: [],
      },
      state: "succeeded",
      bridgeState: "dispatched",
      claim: undefined,
      handoffPayload: undefined,
      workboardCardId: "card-terminal",
      openClawCardStatus: "blocked",
      clickupWriteBack: {
        terminal: {
          statusKey: "done",
          lastSyncedStatus: "done",
          lastSyncedAt: "2026-07-23T11:00:00.000Z",
        },
      },
      handedOffAt: "2026-07-23T10:00:00.000Z",
      dispatchedAt: "2026-07-23T10:05:00.000Z",
      idempotencyKey: "task-terminal::taskUpdated::ready for openclaw::2026-07-23T10:00:00.000Z",
      workType: undefined,
      workflowTemplate: undefined,
      decompositionPlan: undefined,
      triageReason: undefined,
      template: undefined,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:05:00.000Z",
      events: [],
      blockedAt: undefined,
      claimedAt: undefined,
      terminalAt: undefined,
      outcome: undefined,
      deadLetteredAt: undefined,
      deadLetterReason: undefined,
    });

    const services = createBridgeServices(buildClickUpConfig(), {
      stateStore: state,
      openClawWorkboard: adapter as never,
    });

    const result = await services.watchOpenClawCards();

    assert.equal(result.watched, 1);
    assert.equal(adapter.showCalls.length, 1);
    assert.equal(clickUpCalls.length, 0);
    assert.equal(services.state.getJob("task-terminal")?.bridgeState, "synced_back");
    assert.equal(services.state.getJob("task-terminal")?.clickupWriteBack?.terminal?.lastSyncedStatus, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
