import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeToWorkboardCard } from "@clickup-openclaw/shared";

import {
  buildOpenClawNotes,
  OpenClawWorkboardAdapter,
  renderBridgeMetadataBlock,
} from "./openclaw-workboard.js";

const payload: BridgeToWorkboardCard = {
  card: {
    title: "Implement webhook sync",
    notes: "Goal: sync ClickUp task into Workboard",
    status: "ready",
    priority: "high",
    labels: ["clickup", "automation", "project:saint"],
    idempotencyKey: "clickup-task:task-1",
  },
  metadata: {
    sourceSystem: "clickup",
    clickupTaskId: "task-1",
    clickupStatus: "ready for openclaw",
    projectKey: "saint",
    workType: "backend",
    routingKey: "saint",
    automationAllowed: true,
    approvalRequired: false,
    priorityBucket: "high",
    tags: ["automation", "backend"],
    repoUrl: "https://github.com/acme/widgets",
  },
};

test("renderBridgeMetadataBlock includes JSON metadata block", () => {
  const block = renderBridgeMetadataBlock(payload);
  assert.match(block, /## Bridge metadata/);
  assert.match(block, /"clickupTaskId": "task-1"/);
});

test("buildOpenClawNotes appends metadata to notes", () => {
  const notes = buildOpenClawNotes(payload);
  assert.match(notes, /Goal: sync ClickUp task into Workboard/);
  assert.match(notes, /## Bridge metadata/);
});

test("OpenClawWorkboardAdapter createCard shells out with expected args", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = new OpenClawWorkboardAdapter({
    runner: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: JSON.stringify({ id: "card-1", status: "ready" }),
        stderr: "",
      };
    },
  });

  const created = await adapter.createCard(payload);

  assert.equal(created.id, "card-1");
  assert.equal(created.status, "ready");
  assert.equal(calls[0]?.command, "openclaw");
  assert.ok(calls[0]?.args.includes("workboard"));
  assert.ok(calls[0]?.args.includes("create"));
  assert.ok(calls[0]?.args.includes("--notes"));
  assert.ok(calls[0]?.args.includes("--json"));
});

test("OpenClawWorkboardAdapter showCard extracts terminal context from payloads", async () => {
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      return {
        stdout: JSON.stringify({
          id: "card-terminal",
          status: "blocked",
          summary: "Workboard reported a blocker.",
          proof: {
            note: "No execution proof was produced.",
          },
          artifacts: [{ title: "Debug log", url: "https://example.com/log" }],
          comments: ["Waiting on a dependency."],
          blocker_reason: "Dependency not available.",
        }),
        stderr: "",
      };
    },
  });

  const card = await adapter.showCard("card-terminal");

  assert.equal(card.id, "card-terminal");
  assert.equal(card.status, "blocked");
  assert.equal(card.terminalContext?.summary, "Workboard reported a blocker.");
  assert.deepEqual(card.terminalContext?.comments, ["Waiting on a dependency."]);
  assert.equal(card.terminalContext?.blockerContext, "Dependency not available.");
  assert.deepEqual(card.terminalContext?.artifacts, [{ title: "Debug log", url: "https://example.com/log" }]);
});
