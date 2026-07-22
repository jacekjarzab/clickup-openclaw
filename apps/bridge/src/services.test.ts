import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeServices } from "./services.js";

test("bridge write-back includes repo_url, pr_url, artifact_url, docs_url, and design_url on claim and completion", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const taskId = String(url).split("/").pop() ?? "";

    if (taskId === "task-1" && (init?.method ?? "GET") === "GET") {
      return {
        ok: true,
        json: async () => ({
          id: "task-1",
          name: "Task 1",
          status: { status: "ready for openclaw" },
          list: { id: "list-1" },
          priority: "normal",
          tags: [{ name: "feature" }],
          custom_fields: [
            { id: "repo_url", value: "https://github.com/acme/widgets" },
            { id: "pr_url", value: "https://github.com/acme/widgets/pull/42" },
            { id: "artifact_url", value: "https://preview.example.com/widgets" },
            { id: "docs_url", value: "https://docs.example.com/widgets" },
            { id: "design_url", value: "https://figma.com/file/widgets" },
            { id: "branch_name", value: "feature/widgets" },
            { id: "commit_sha", value: "abc123" },
            { id: "commit_url", value: "https://github.com/acme/widgets/commit/abc123" },
            { id: "pr_number", value: 42 },
            { id: "priority_bucket", value: "high" },
          ],
        }),
      } as Response;
    }

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
      firstUpdateBody.custom_fields?.find((field) => field.id === "branch_name"),
      {
        id: "branch_name",
        value: "feature/widgets",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "commit_sha"),
      {
        id: "commit_sha",
        value: "abc123",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "commit_url"),
      {
        id: "commit_url",
        value: "https://github.com/acme/widgets/commit/abc123",
      },
    );
    assert.deepEqual(
      firstUpdateBody.custom_fields?.find((field) => field.id === "pr_number"),
      {
        id: "pr_number",
        value: 42,
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
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "branch_name"),
      {
        id: "branch_name",
        value: "feature/widgets",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "commit_sha"),
      {
        id: "commit_sha",
        value: "abc123",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "commit_url"),
      {
        id: "commit_url",
        value: "https://github.com/acme/widgets/commit/abc123",
      },
    );
    assert.deepEqual(
      secondUpdateBody.custom_fields?.find((field) => field.id === "pr_number"),
      {
        id: "pr_number",
        value: 42,
      },
    );

    const commentBodies = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "POST" && String(request.url).endsWith("/comment");
    });
    const completionCommentBody = JSON.parse(String(commentBodies[1]?.init?.body)) as {
      comment_text?: string;
    };
    assert.match(completionCommentBody.comment_text ?? "", /Git details:/i);
    assert.match(completionCommentBody.comment_text ?? "", /Commit: abc123/i);
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

test("bridge auto-escalates long-blocked work into review", async () => {
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
      BLOCKED_ESCALATION_MS: "1000",
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-escalate",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const blocked = await services.markBlockedJob("task-escalate", {
      reason: "Waiting on client feedback",
    });
    assert.equal(blocked.blockedAt !== undefined, true);
    assert.equal(services.listJobs()[0]?.state, "blocked");

    const result = await services.monitorHeartbeats({
      now: new Date(Date.parse(blocked.blockedAt) + 2000).toISOString(),
    });

    assert.equal(result.escalated.length, 1);
    assert.equal(result.escalated[0]?.taskId, "task-escalate");
    assert.equal(services.listJobs()[0]?.state, "normalized");
    assert.equal(services.listJobs()[0]?.blockedAt, undefined);

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

    const escalationCommentBody = JSON.parse(String(commentRequests[1]?.init?.body)) as {
      comment_text?: string;
    };
    const escalationUpdateBody = JSON.parse(String(updateRequests[1]?.init?.body)) as {
      status?: string;
      custom_fields?: Array<{ id: string; value: unknown }>;
    };

    assert.match(escalationCommentBody.comment_text ?? "", /Auto-escalated into review by OpenClaw/i);
    assert.equal(escalationUpdateBody.status, "review");
    assert.deepEqual(
      escalationUpdateBody.custom_fields?.find((field) => field.id === "automation_state"),
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

test("bridge applies a work type template and surfaces dashboard aggregates", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        id: "task-template",
        name: "Template task",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "normal",
        description: "desc",
        tags: [{ name: "feature" }],
        custom_fields: [{ id: "work_type", value: "feature" }],
      }),
      { status: 200 },
    ) as Response;
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      WORK_TYPE_TEMPLATES_JSON: JSON.stringify({
        feature: {
          title: "Feature brief",
          goal: "Ship a user-facing change",
          context: "Keep it small and explicit",
          acceptanceCriteria: ["Implementation is complete", "Validation is recorded"],
          constraints: ["Do not break existing flows"],
          steps: ["Clarify the scope", "Implement the change", "Verify the result"],
          matchTags: ["feature"],
        },
      }),
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-template",
      listId: "list-1",
      status: "ready for openclaw",
      payload: {
        workType: "feature",
      },
    });

    const claim = await services.claimNextJob();
    assert.ok(claim);

    const commentRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "POST" && String(request.url).endsWith("/comment");
    });

    assert.equal(commentRequests.length, 1);
    const claimComment = JSON.parse(String(commentRequests[0]?.init?.body)) as {
      comment_text?: string;
    };
    assert.match(claimComment.comment_text ?? "", /Task template for feature/i);
    assert.match(claimComment.comment_text ?? "", /Feature brief/i);
    assert.match(claimComment.comment_text ?? "", /Decomposition plan for feature/i);
    assert.match(claimComment.comment_text ?? "", /Step 1: Clarify the scope/i);

    await services.completeJob("task-template", {
      outcome: "succeeded",
      summary: "Done",
    });

    const dashboard = services.getDashboardSnapshot();
    assert.equal(dashboard.queueHealth.queueDepth, 0);
    assert.equal(dashboard.completionRates.totalJobs, 1);
    assert.equal(dashboard.completionRates.succeededJobs, 1);
    assert.equal(dashboard.completionRates.byWorkType[0]?.workType, "feature");
    assert.equal(dashboard.completionRates.byWorkType[0]?.successRate, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge applies a workflow template by project key", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        id: "task-workflow",
        name: "Workflow task",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "normal",
        description: "desc",
        tags: [{ name: "client-saint" }],
        custom_fields: [{ id: "project_key", value: "saint" }],
      }),
      { status: 200 },
    ) as Response;
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      WORKFLOW_TEMPLATES_JSON: JSON.stringify({
        saint: {
          title: "Client workflow",
          goal: "Keep the SAINT delivery path predictable",
          context: "Follow the usual client handoff steps",
          acceptanceCriteria: ["Work is routed through the SAINT template"],
          constraints: ["Do not skip the client handoff"],
          steps: ["Confirm the intake", "Execute the work", "Share the handoff"],
          matchTags: ["client-saint"],
        },
      }),
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-workflow",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const claim = await services.claimNextJob();
    assert.ok(claim);

    const commentRequests = requests.filter((request) => {
      const method = request.init?.method ?? "GET";
      return method === "POST" && String(request.url).endsWith("/comment");
    });

    assert.equal(commentRequests.length, 1);
    const claimComment = JSON.parse(String(commentRequests[0]?.init?.body)) as {
      comment_text?: string;
    };
    assert.match(claimComment.comment_text ?? "", /Workflow template for saint/i);
    assert.match(claimComment.comment_text ?? "", /Client workflow/i);
    assert.match(claimComment.comment_text ?? "", /Do not skip the client handoff/i);
    assert.match(claimComment.comment_text ?? "", /Decomposition plan for saint/i);
    assert.match(claimComment.comment_text ?? "", /Step 2: Execute the work/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge routes by label and status, honors priority queues, and blocks approval-gated auto pickup", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });

    const taskId = String(url).split("/").pop() ?? "";
    const taskBodies: Record<string, unknown> = {
      "task-a": {
        id: "task-a",
        name: "Task A",
        status: { status: "new" },
        list: { id: "list-1" },
        priority: "low",
        tags: [{ name: "automation" }],
        custom_fields: [
          { id: "project_key", value: "web" },
          { id: "priority_bucket", value: "low" },
        ],
      },
      "task-b": {
        id: "task-b",
        name: "Task B",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "urgent",
        tags: [],
        custom_fields: [
          { id: "project_key", value: "web" },
          { id: "priority_bucket", value: "urgent" },
        ],
      },
      "task-c": {
        id: "task-c",
        name: "Task C",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "high",
        tags: [{ name: "needs-human" }],
        custom_fields: [
          { id: "project_key", value: "web" },
          { id: "priority_bucket", value: "high" },
        ],
      },
    };

    if (taskId in taskBodies) {
      return {
        ok: true,
        json: async () => taskBodies[taskId],
      } as Response;
    }

    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      PROJECT_ROUTING_JSON: JSON.stringify({
        web: {
          matchLabels: ["web"],
          autoPickLabels: ["automation"],
          autoPickStatuses: ["ready for openclaw"],
          approvalLabels: ["needs-human"],
          approvalRequired: false,
          workType: "feature",
        },
      }),
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-a",
      listId: "list-1",
      status: "new",
    });
    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-b",
      listId: "list-1",
      status: "ready for openclaw",
    });
    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-c",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const jobs = services.listJobs();
    assert.equal(jobs.find((job) => job.task.id === "task-a")?.task.projectKey, "web");
    assert.equal(jobs.find((job) => job.task.id === "task-a")?.task.autoPicked, true);
    assert.equal(jobs.find((job) => job.task.id === "task-a")?.task.priorityBucket, "low");
    assert.equal(jobs.find((job) => job.task.id === "task-b")?.task.priorityBucket, "urgent");
    assert.equal(jobs.find((job) => job.task.id === "task-c")?.task.approvalRequired, true);
    assert.equal(services.getMetricsSnapshot().queueDepth, 2);

    const firstClaim = await services.claimNextJob();
    assert.equal(firstClaim?.taskId, "task-b");

    const secondClaim = await services.claimNextJob();
    assert.equal(secondClaim?.taskId, "task-a");

    const manualClaim = await services.manualClaimJob("task-c");
    assert.equal(manualClaim.taskId, "task-c");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge applies smarter triage rules and writes the reason back to ClickUp", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });

    const taskId = String(url).split("/").pop() ?? "";
    if (taskId === "task-triage" && (init?.method ?? "GET") === "GET") {
      return {
        ok: true,
        json: async () => ({
          id: "task-triage",
          name: "Task Triage",
          status: { status: "ready for openclaw" },
          list: { id: "list-1" },
          priority: "normal",
          tags: [{ name: "client-review" }],
          custom_fields: [{ id: "project_key", value: "web" }],
        }),
      } as Response;
    }

    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const services = createBridgeServices({
      CLICKUP_API_TOKEN: "token",
      CLICKUP_BASE_URL: "https://clickup.test/api/v2",
      TRIAGE_RULES_JSON: JSON.stringify({
        web: {
          matchLabels: ["client-review"],
          reason: "Needs client review before automation",
          holdForHuman: true,
        },
      }),
      PORT: "8787",
      HOST: "0.0.0.0",
    });

    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-triage",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const job = services.listJobs().find((item) => item.task.id === "task-triage");
    assert.equal(job?.task.approvalRequired, true);
    assert.equal(job?.task.triageReason, "Needs client review before automation");
    assert.equal(services.getMetricsSnapshot().queueDepth, 0);

    const claim = await services.manualClaimJob("task-triage");
    assert.ok(claim);

    const putRequest = requests.find((request) => {
      const method = request.init?.method ?? "GET";
      return method === "PUT" && String(request.url).endsWith("/task/task-triage");
    });
    assert.ok(putRequest);

    const putBody = JSON.parse(String(putRequest?.init?.body)) as {
      custom_fields?: Array<{ id: string; value: unknown }>;
      status?: string;
    };
    assert.equal(putBody.status, "in progress");
    assert.deepEqual(putBody.custom_fields?.find((field) => field.id === "triage_reason"), {
      id: "triage_reason",
      value: "Needs client review before automation",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge dashboard metrics include priority and failure breakdowns", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const taskId = String(url).split("/").pop() ?? "";
    const taskBodies: Record<string, unknown> = {
      "task-metrics-a": {
        id: "task-metrics-a",
        name: "Metrics A",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "urgent",
        tags: [],
        custom_fields: [
          { id: "project_key", value: "web" },
          { id: "priority_bucket", value: "urgent" },
        ],
      },
      "task-metrics-b": {
        id: "task-metrics-b",
        name: "Metrics B",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "high",
        tags: [],
        custom_fields: [
          { id: "project_key", value: "web" },
          { id: "priority_bucket", value: "high" },
        ],
      },
      "task-metrics-c": {
        id: "task-metrics-c",
        name: "Metrics C",
        status: { status: "ready for openclaw" },
        list: { id: "list-1" },
        priority: "low",
        tags: [],
        custom_fields: [
          { id: "project_key", value: "web" },
          { id: "priority_bucket", value: "low" },
        ],
      },
    };

    if ((init?.method ?? "GET") === "GET" && taskId in taskBodies) {
      return {
        ok: true,
        json: async () => taskBodies[taskId],
      } as Response;
    }

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
      taskId: "task-metrics-a",
      listId: "list-1",
      status: "ready for openclaw",
    });
    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-metrics-b",
      listId: "list-1",
      status: "ready for openclaw",
    });
    await services.ingestWebhook({
      event: "taskUpdated",
      taskId: "task-metrics-c",
      listId: "list-1",
      status: "ready for openclaw",
    });

    const first = await services.claimNextJob();
    assert.equal(first?.taskId, "task-metrics-a");
    await services.completeJob("task-metrics-a", {
      outcome: "succeeded",
      summary: "Done",
    });

    const second = await services.claimNextJob();
    assert.equal(second?.taskId, "task-metrics-b");
    await services.completeJob("task-metrics-b", {
      outcome: "failed",
      summary: "Failed",
    });

    const third = await services.claimNextJob();
    assert.equal(third?.taskId, "task-metrics-c");
    await services.completeJob("task-metrics-c", {
      outcome: "blocked",
      summary: "Blocked",
    });

    const dashboard = services.getDashboardSnapshot();
    assert.equal(dashboard.completionRates.totalJobs, 3);
    assert.equal(dashboard.completionRates.succeededJobs, 1);
    assert.equal(dashboard.completionRates.failedJobs, 1);
    assert.equal(dashboard.completionRates.blockedJobs, 1);
    assert.equal(dashboard.completionRates.failureRate, 0.67);
    assert.equal(dashboard.queueHealth.priorityBucketCounts.urgent, 1);
    assert.equal(dashboard.queueHealth.priorityBucketCounts.high, 1);
    assert.equal(dashboard.queueHealth.priorityBucketCounts.low, 1);
    assert.equal(dashboard.queueHealth.autoPickedJobs, 3);
    assert.equal(dashboard.queueHealth.approvalRequiredJobs, 0);
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
    assert.equal(job?.task.projectKey, "client-b");
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
