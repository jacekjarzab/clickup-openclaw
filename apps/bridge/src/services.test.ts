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
