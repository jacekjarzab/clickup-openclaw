import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeServices } from "./services.js";

test("bridge write-back includes repo_url, pr_url, artifact_url, docs_url, and design_url on claim and completion", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
      const services = createBridgeServices({
        CLICKUP_API_TOKEN: "token",
        CLICKUP_BASE_URL: "https://clickup.test/api/v2",
        REPO_URL: "git+https://github.com/acme/widgets.git",
        PR_URL: "https://github.com/acme/widgets/pull/42",
        ARTIFACT_URL: "https://preview.example.com/widgets",
        DOCS_URL: "https://docs.example.com/widgets",
        DESIGN_URL: "https://figma.com/file/widgets",
        PORT: "8787",
        HOST: "0.0.0.0",
      });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-1",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const claim = await services.claimNextJob();
    assert.ok(claim);
    await services.completeJob("task-1", {
      outcome: "succeeded",
      summary: "Finished the task",
    });

    const updateRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "PUT";
    });

    assert.equal(updateRequests.length, 2);

    const firstUpdateBody = JSON.parse(String(updateRequests[0]?.init?.body)) as {
      custom_fields?: Array<{ id: string; value: unknown }>;
      status?: string;
    };
    const secondUpdateBody = JSON.parse(String(updateRequests[1]?.init?.body)) as {
      custom_fields?: Array<{ id: string; value: unknown }>;
      status?: string;
    };

    assert.equal(firstUpdateBody.status, "in progress");
    assert.equal(secondUpdateBody.status, "done");
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "repo_url"),
      {
        id: "repo_url",
        value: "https://github.com/acme/widgets",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "pr_url"),
      {
        id: "pr_url",
        value: "https://github.com/acme/widgets/pull/42",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "artifact_url"),
      {
        id: "artifact_url",
        value: "https://preview.example.com/widgets",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "docs_url"),
      {
        id: "docs_url",
        value: "https://docs.example.com/widgets",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "design_url"),
      {
        id: "design_url",
        value: "https://figma.com/file/widgets",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "repo_url"),
      {
        id: "repo_url",
        value: "https://github.com/acme/widgets",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "pr_url"),
      {
        id: "pr_url",
        value: "https://github.com/acme/widgets/pull/42",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "artifact_url"),
      {
        id: "artifact_url",
        value: "https://preview.example.com/widgets",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "docs_url"),
      {
        id: "docs_url",
        value: "https://docs.example.com/widgets",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "design_url"),
      {
        id: "design_url",
        value: "https://figma.com/file/widgets",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge heartbeat monitoring reclaims expired claims and writes back a warning", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      REPO_URL: "git+https://github.com/acme/widgets.git",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-2",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const claim = await services.claimNextJob({ leaseSeconds: 1 });
    assert.ok(claim);

    const result = await services.monitorHeartbeats({
      now: new Date(Date.parse(claim.leaseExpiresAt) + 1000).toISOString(),
    });

    assert.equal(result.reclaimed.length, 1);
    assert.equal(result.notified.length, 1);
    assert.equal(services.workboard.listClaims().length, 0);
    assert.equal(services.listJobs()[0]?.state, "reclaimed");

    const commentRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "POST" && String(request.url).endsWith("/comment");
    });
    const updateRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "PUT";
    });

    assert.equal(commentRequests.length, 2);
    assert.equal(updateRequests.length, 2);

    const monitorCommentBody = JSON.parse(String(commentRequests[1]?.init?.body)) as {
      comment_text?: string;
    };
    const monitorUpdateBody = JSON.parse(String(updateRequests[1]?.init?.body)) as {
      status?: string;
      custom_fields?: Array<{ id: string; value: unknown }>;
    };

    assert.match(monitorCommentBody.comment_text ?? "", /missed heartbeat/i);
    assert.equal(monitorUpdateBody.status, "ready for openclaw");
    assert.deepEqual(
      monitorUpdateBody.custom_fields?.find((field) => field.id === "automation_state"),
      {
        id: "automation_state",
        value: "candidate",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge metrics snapshot tracks queue depth, claims, and throughput", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-3",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const beforeClaim = services.getMetricsSnapshot({ now: "2026-07-21T00:00:00.000Z" });
    assert.equal(beforeClaim.queueDepth, 1);
    assert.equal(beforeClaim.activeClaims, 0);

    const claim = await services.claimNextJob({ leaseSeconds: 30 });
    assert.ok(claim);

    const duringClaim = services.getMetricsSnapshot({ now: claim.leaseExpiresAt });
    assert.equal(duringClaim.activeClaims, 1);
    assert.equal(duringClaim.jobCounts.leased, 1);

    await services.completeJob("task-3", {
      outcome: "succeeded",
      summary: "Finished the task",
    });

    const afterComplete = services.getMetricsSnapshot({ now: claim.leaseExpiresAt });
    assert.equal(afterComplete.throughput.terminalJobs, 1);
    assert.equal(afterComplete.jobCounts.succeeded, 1);
    assert.ok(afterComplete.latency.averageClaimToTerminalMs >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge pause blocks automatic claim and manual claim/release still work", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-4",
      listId: "list-1",
      status: "ready for openclaw",
    });

    services.pauseWork();
    assert.equal(services.getControlState().paused, true);
    assert.equal(await services.claimNextJob(), null);

    const manualClaim = await services.manualClaimJob("task-4", { leaseSeconds: 10 });
    assert.ok(manualClaim);
    assert.equal(services.workboard.listClaims().length, 1);

    const release = await services.releaseJob("task-4", { requeue: true });
    assert.deepEqual(release, {
      taskId: "task-4",
      released: true,
      requeued: true,
    });
    assert.equal(services.workboard.listClaims().length, 0);

    services.resumeWork();
    assert.equal(services.getControlState().paused, false);
    const nextClaim = await services.claimNextJob();
    assert.ok(nextClaim);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge requeue re-adds a released task to the queue", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-5",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const claim = await services.manualClaimJob("task-5");
    assert.ok(claim);
    assert.equal(services.workboard.listClaims().length, 1);

    const requeue = await services.requeueJob("task-5");
    assert.deepEqual(requeue, {
      taskId: "task-5",
      released: true,
      requeued: true,
    });
    assert.equal(services.workboard.listClaims().length, 0);
    assert.equal(services.getMetricsSnapshot().queueDepth, 1);

    const nextClaim = await services.claimNextJob();
    assert.ok(nextClaim);
    assert.equal(nextClaim?.taskId, "task-5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge markBlocked records the reason and updates ClickUp", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-6",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const claim = await services.claimNextJob();
    assert.ok(claim);

    const result = await services.markBlockedJob("task-6", {
      reason: "Waiting on client input",
    });

    assert.deepEqual(result, {
      taskId: "task-6",
      blockedAt: result.blockedAt,
      reason: "Waiting on client input",
    });
    assert.equal(services.listJobs()[0]?.state, "blocked");

    const commentRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "POST" && String(request.url).endsWith("/comment");
    });
    const updateRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "PUT";
    });

    assert.equal(commentRequests.length, 2);
    assert.equal(updateRequests.length, 2);

    const blockedCommentBody = JSON.parse(String(commentRequests[1]?.init?.body)) as {
      comment_text?: string;
    };
    const blockedUpdateBody = JSON.parse(String(updateRequests[1]?.init?.body)) as {
      status?: string;
      custom_fields?: Array<{ id: string; value: unknown }>;
    };

    assert.match(blockedCommentBody.comment_text ?? "", /Marked blocked by OpenClaw/i);
    assert.equal(blockedUpdateBody.status, "blocked");
    assert.deepEqual(
      blockedUpdateBody.custom_fields?.find((field) => field.id === "automation_state"),
      {
        id: "automation_state",
        value: "blocked",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge forceReview updates ClickUp review state and writes the reason", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-7",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const claim = await services.claimNextJob();
    assert.ok(claim);

    const result = await services.forceReviewJob("task-7", {
      reason: "Human sign-off required",
    });

    assert.deepEqual(result, {
      taskId: "task-7",
      reviewAt: result.reviewAt,
      reason: "Human sign-off required",
    });
    assert.equal(services.listJobs()[0]?.state, "normalized");

    const commentRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "POST" && String(request.url).endsWith("/comment");
    });
    const updateRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "PUT";
    });

    assert.equal(commentRequests.length, 2);
    assert.equal(updateRequests.length, 2);

    const reviewCommentBody = JSON.parse(String(commentRequests[1]?.init?.body)) as {
      comment_text?: string;
    };
    const reviewUpdateBody = JSON.parse(String(updateRequests[1]?.init?.body)) as {
      status?: string;
      custom_fields?: Array<{ id: string; value: unknown }>;
    };

    assert.match(reviewCommentBody.comment_text ?? "", /Forced into review by OpenClaw/i);
    assert.equal(reviewUpdateBody.status, "review");
    assert.deepEqual(
      reviewUpdateBody.custom_fields?.find((field) => field.id === "automation_state"),
      {
        id: "automation_state",
        value: "candidate",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge ingests a project key from config or payload for future routing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      DEFAULT_PROJECT_KEY: "client-a",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-8",
      listId: "list-1",
      status: "ready for openclaw",
      payload: { projectKey: "client-b" },
    });

    const job = services.listJobs()[0];
    assert.equal(job?.task.projectKey, "client-a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge applies project routing rules for a project-specific task", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      REPO_URL: "https://github.com/acme/default-repo",
      PR_URL: "https://github.com/acme/default-repo/pull/1",
      ARTIFACT_URL: "https://preview.example.com/default",
      DOCS_URL: "https://docs.example.com/default",
      DESIGN_URL: "https://figma.com/file/default",
      PROJECT_ROUTING_JSON: JSON.stringify({
        "client-a": {
          repoUrl: "https://github.com/acme/client-a",
          prUrl: "https://github.com/acme/client-a/pull/9",
          docsUrl: "https://docs.example.com/client-a",
        },
      }),
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-9",
      listId: "list-1",
      status: "ready for openclaw",
      payload: { projectKey: "client-a" },
    });

    const claim = await services.claimNextJob();
    assert.ok(claim);

    await services.completeJob("task-9", {
      outcome: "succeeded",
      summary: "Finished the routed task",
    });

    const updateRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "PUT";
    });

    assert.equal(updateRequests.length, 2);

    const firstUpdateBody = JSON.parse(String(updateRequests[0]?.init?.body)) as {
      custom_fields?: Array<{ id: string; value: unknown }>;
    };
    const secondUpdateBody = JSON.parse(String(updateRequests[1]?.init?.body)) as {
      custom_fields?: Array<{ id: string; value: unknown }>;
    };

    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "repo_url"),
      {
        id: "repo_url",
        value: "https://github.com/acme/client-a",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "pr_url"),
      {
        id: "pr_url",
        value: "https://github.com/acme/client-a/pull/9",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "artifact_url"),
      {
        id: "artifact_url",
        value: "https://preview.example.com/default",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "docs_url"),
      {
        id: "docs_url",
        value: "https://docs.example.com/client-a",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "design_url"),
      {
        id: "design_url",
        value: "https://figma.com/file/default",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "repo_url"),
      {
        id: "repo_url",
        value: "https://github.com/acme/client-a",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "pr_url"),
      {
        id: "pr_url",
        value: "https://github.com/acme/client-a/pull/9",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
