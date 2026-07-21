import assert from "node:assert/strict";
import test from "node:test";

import { createClickUpClient } from "./index.js";

test("getTask maps repo_url, pr_url, artifact_url, docs_url, and design_url custom fields and omits them when absent", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });

    return {
      ok: true,
      json: async () => ({
        id: "task-1",
        name: "Build thing",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "high",
        description: "desc",
        tags: [{ name: "ops" }],
        custom_fields: [
          { id: "repo_url", value: "https://github.com/acme/widgets" },
          { id: "pr_url", value: "https://github.com/acme/widgets/pull/42" },
          { id: "artifact_url", value: "https://preview.example.com/widgets" },
          { id: "docs_url", value: "https://docs.example.com/widgets" },
          { id: "design_url", value: "https://figma.com/file/widgets" },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const client = createClickUpClient({ token: "token" });
    const task = await client.getTask("task-1");

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://api.clickup.com/api/v2/task/task-1");
    assert.equal(task.repoUrl, "https://github.com/acme/widgets");
    assert.equal(task.prUrl, "https://github.com/acme/widgets/pull/42");
    assert.equal(task.artifactUrl, "https://preview.example.com/widgets");
    assert.equal(task.docsUrl, "https://docs.example.com/widgets");
    assert.equal(task.designUrl, "https://figma.com/file/widgets");
    assert.deepEqual(task.tags, ["ops"]);

    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          id: "task-2",
          name: "Build thing",
          status: { status: "ready for openclaw" },
          tags: [],
        }),
      } as Response;
    }) as typeof fetch;

    const withoutRepo = await client.getTask("task-2");
    assert.equal(withoutRepo.repoUrl, undefined);
    assert.equal(withoutRepo.prUrl, undefined);
    assert.equal(withoutRepo.artifactUrl, undefined);
    assert.equal(withoutRepo.docsUrl, undefined);
    assert.equal(withoutRepo.designUrl, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retry policy retries transient ClickUp failures", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
  let attempts = 0;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    attempts += 1;

    if (attempts === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response;
    }

    return {
      ok: true,
      json: async () => ({
        id: "task-3",
        name: "Build thing",
        status: { status: "ready for openclaw" },
        tags: [],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const client = createClickUpClient({
      token: "token",
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    });

    const task = await client.getTask("task-3");

    assert.equal(requests.length, 2);
    assert.equal(task.id, "task-3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
