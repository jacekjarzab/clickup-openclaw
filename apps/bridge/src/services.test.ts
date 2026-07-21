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
