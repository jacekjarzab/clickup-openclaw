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
    labels: ["clickup", "project:saint"],
    idempotencyKey: "clickup-task:task-1",
  },
  metadata: {
    sourceSystem: "clickup",
    clickupTaskId: "task-1",
    clickupStatus: "ready for openclaw",
    cardType: "automation",
    projectKey: "saint",
    workType: "backend",
    routingKey: "saint",
    automationAllowed: true,
    approvalRequired: false,
    priorityBucket: "high",
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

test("OpenClawWorkboardAdapter createCard accepts nested card responses", async () => {
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      return {
        stdout: JSON.stringify({
          card: {
            id: "card-1",
            status: "ready",
            summary: "Created via nested card payload",
          },
        }),
        stderr: "",
      };
    },
  });

  const created = await adapter.createCard(payload);

  assert.equal(created.id, "card-1");
  assert.equal(created.status, "ready");
  assert.equal(created.raw.summary, "Created via nested card payload");
});

test("OpenClawWorkboardAdapter createCard rejects unknown payload fields", async () => {
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      return {
        stdout: JSON.stringify({ id: "card-1", status: "ready" }),
        stderr: "",
      };
    },
  });

  await assert.rejects(
    async () =>
      adapter.createCard({
        ...payload,
        card: {
          ...payload.card,
          unexpected: "field",
        } as never,
      } as never),
    /unrecognized key/i,
  );
});

test("OpenClawWorkboardAdapter retries transient showCard failures", async () => {
  let attempts = 0;
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("temporary gateway unavailable");
      }

      return {
        stdout: JSON.stringify({
          id: "card-terminal",
          status: "blocked",
          summary: "Workboard reported a blocker.",
        }),
        stderr: "",
      };
    },
  });

  const card = await adapter.showCard("card-terminal");

  assert.equal(attempts, 2);
  assert.equal(card.id, "card-terminal");
  assert.equal(card.status, "blocked");
});

test("OpenClawWorkboardAdapter showCard accepts nested card responses", async () => {
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      return {
        stdout: JSON.stringify({
          card: {
            id: "card-terminal",
            status: "done",
            summary: "Nested card payload",
          },
        }),
        stderr: "",
      };
    },
  });

  const card = await adapter.showCard("card-terminal");

  assert.equal(card.id, "card-terminal");
  assert.equal(card.status, "done");
  assert.equal(card.raw.card?.summary, "Nested card payload");
});

test("OpenClawWorkboardAdapter retries transient createCard failures", async () => {
  let attempts = 0;
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("temporary gateway unavailable");
      }

      return {
        stdout: JSON.stringify({ id: "card-1", status: "ready" }),
        stderr: "",
      };
    },
  });

  const created = await adapter.createCard(payload);

  assert.equal(attempts, 2);
  assert.equal(created.id, "card-1");
  assert.equal(created.status, "ready");
});

test("OpenClawWorkboardAdapter records transport telemetry", async () => {
  const adapter = new OpenClawWorkboardAdapter({
    runner: async (_command, args) => {
      const operation = args[1];

      if (operation === "create") {
        return {
          stdout: JSON.stringify({ id: "card-1", status: "ready" }),
          stderr: "",
        };
      }

      if (operation === "show") {
        return {
          stdout: JSON.stringify({ id: "card-1", status: "running" }),
          stderr: "",
        };
      }

      if (operation === "list") {
        return {
          stdout: JSON.stringify([{ id: "card-1", status: "ready" }]),
          stderr: "",
        };
      }

      return {
        stdout: JSON.stringify({ started: 1 }),
        stderr: "",
      };
    },
  });

  await adapter.createCard(payload);
  await adapter.showCard("card-1");
  await adapter.listCards();
  await adapter.dispatch();

  const snapshot = adapter.getTransportSnapshot();

  assert.equal(snapshot.mode, "cli");
  assert.equal(snapshot.operations.createCard.calls, 1);
  assert.equal(snapshot.operations.showCard.calls, 1);
  assert.equal(snapshot.operations.listCards.calls, 1);
  assert.equal(snapshot.operations.dispatch.calls, 1);
  assert.equal(snapshot.recentFailures.length, 0);
});

test("OpenClawWorkboardAdapter listCards accepts { cards: [] } payloads", async () => {
  const adapter = new OpenClawWorkboardAdapter({
    runner: async () => {
      return {
        stdout: JSON.stringify({
          cards: [{ id: "card-1", status: "ready" }],
        }),
        stderr: "",
      };
    },
  });

  const cards = await adapter.listCards();

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.id, "card-1");
  assert.equal(cards[0]?.status, "ready");
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
