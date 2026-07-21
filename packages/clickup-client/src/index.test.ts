import assert from "node:assert/strict";
import test from "node:test";

import { createClickUpClient } from "./index.js";

test("getTask maps repo_url, pr_url, and artifact_url custom fields and omits them when absent", async () => {
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});
