import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import {
  buildOpenClawStatusComment,
  createBridgeServices,
  extractOpenClawTerminalContext,
} from "./services.js";
import { InMemoryStateStore } from "@clickup-openclaw/state";
import type {
  BridgeToWorkboardCard,
  ClickUpTask,
  OpenClawWorkboardCardStatus,
} from "@clickup-openclaw/shared";

class FakeOpenClawWorkboardAdapter {
  public readonly created: BridgeToWorkboardCard[] = [];

  public readonly dispatched: Array<{ boardId?: string; maxStarts?: number }> = [];

  public readonly showCalls: string[] = [];

  public readonly showResponses = new Map<string, { status: OpenClawWorkboardCardStatus; raw: Record<string, unknown> }>();

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

function buildClickUpConfig() {
  return loadConfig({
    PORT: "8787",
    HOST: "127.0.0.1",
    CLICKUP_API_TOKEN: "token",
    CLICKUP_BASE_URL: "https://example.invalid/api/v2",
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
    "https://example.com/report",
    "https://example.com/artifact",
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
    artifacts: ["https://example.com/build"],
    comments: ["Ready for human review."],
  });

  assert.ok(reviewComment);
  assert.match(reviewComment, /Delivered the requested change\./);
  assert.match(reviewComment, /Proof: .*Checked locally and in CI\./);
  assert.match(reviewComment, /Artifacts:/);
  assert.match(reviewComment, /https:\/\/example.com\/build/);
  assert.match(reviewComment, /Comments:/);
  assert.match(reviewComment, /Ready for human review\./);

  const blockedComment = buildOpenClawStatusComment("blocked", {
    blockerContext: "Waiting on access to the staging environment.",
    proof: "No execution output was available.",
  });

  assert.ok(blockedComment);
  assert.match(blockedComment, /Waiting on access to the staging environment\./);
  assert.match(blockedComment, /Proof: No execution output was available\./);
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
