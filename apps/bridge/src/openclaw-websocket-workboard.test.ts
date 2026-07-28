import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeToWorkboardCard } from "@clickup-openclaw/shared";

import { loadConfig } from "./config.js";
import { OpenClawWebSocketWorkboardAdapter } from "./openclaw-websocket-workboard.js";

const payload: BridgeToWorkboardCard = {
  card: {
    title: "Sync ClickUp task",
    notes: "Create the workboard card over websocket",
    status: "ready",
    priority: "high",
    labels: [],
    idempotencyKey: "task-1",
  },
  metadata: {
    sourceSystem: "clickup",
    clickupTaskId: "task-1",
    clickupStatus: "ready for openclaw",
    cardType: "automation",
    projectKey: "saint",
    workType: "backend",
    routingKey: "saint",
    priorityBucket: "high",
  },
};

function createSocketFactory() {
  let attempts = 0;
  const sentPayloads: Array<Record<string, unknown>> = [];

  return {
    attempts: () => attempts,
    sentPayloads,
    socketFactory: () => {
      attempts += 1;

      const socket: {
        readyState: number;
        send(data: string): void;
        close(): void;
        onopen: ((event: { type: "open" }) => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: ((event: { error?: unknown }) => void) | null;
        onclose: ((event: { code: number; reason: string }) => void) | null;
      } = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data: string) {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          sentPayloads.push(parsed);

          if (attempts === 1) {
            throw new Error("socket temporarily unavailable");
          }

          queueMicrotask(() => {
            socket.onmessage?.({
              data: JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  id: "card-1",
                  status: "ready",
                  summary: "Created over websocket",
                },
              }),
            });
          });
        },
        close() {
          socket.onclose?.({ code: 1000, reason: "closed" });
        },
      };

      queueMicrotask(() => {
        socket.onopen?.({ type: "open" });
      });

      return socket;
    },
  };
}

test("OpenClawWebSocketWorkboardAdapter retries transient createCard failures", async () => {
  const fake = createSocketFactory();
  const adapter = new OpenClawWebSocketWorkboardAdapter({
    url: "ws://example.invalid/workboard",
    socketFactory: fake.socketFactory,
    retry: {
      attempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    },
  });

  const created = await adapter.createCard(payload);

  assert.equal(fake.attempts(), 2);
  assert.equal(created.id, "card-1");
  assert.equal(created.status, "ready");
  assert.equal(created.raw.summary, "Created over websocket");
});

test("OpenClawWebSocketWorkboardAdapter accepts nested card create responses", async () => {
  const adapter = new OpenClawWebSocketWorkboardAdapter({
    url: "ws://example.invalid/workboard",
    socketFactory: () => {
      const socket: {
        readyState: number;
        send(data: string): void;
        close(): void;
        onopen: ((event: { type: "open" }) => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: ((event: { error?: unknown }) => void) | null;
        onclose: ((event: { code: number; reason: string }) => void) | null;
      } = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data: string) {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          queueMicrotask(() => {
            socket.onmessage?.({
              data: JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  card: {
                    id: "card-1",
                    status: "ready",
                    summary: "Created over websocket via nested payload",
                  },
                },
              }),
            });
          });
        },
        close() {
          socket.onclose?.({ code: 1000, reason: "closed" });
        },
      };

      queueMicrotask(() => {
        socket.onopen?.({ type: "open" });
      });

      return socket;
    },
  });

  const created = await adapter.createCard(payload);

  assert.equal(created.id, "card-1");
  assert.equal(created.status, "ready");
  assert.equal(created.raw.summary, "Created over websocket via nested payload");
});

test("OpenClawWebSocketWorkboardAdapter records websocket transport telemetry", async () => {
  const fake = createSocketFactory();
  const adapter = new OpenClawWebSocketWorkboardAdapter({
    url: "ws://example.invalid/workboard",
    socketFactory: fake.socketFactory,
    retry: {
      attempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    },
  });

  await adapter.createCard(payload);

  const snapshot = adapter.getTransportSnapshot();

  assert.equal(snapshot.mode, "websocket");
  assert.equal(snapshot.endpoint, "ws://example.invalid/workboard");
  assert.equal(snapshot.operations.createCard.calls, 1);
  assert.equal(snapshot.operations.createCard.retries, 1);
  assert.equal(snapshot.connectionAttempts, 2);
  assert.equal(snapshot.connectionFailures, 0);
  assert.equal(snapshot.recentFailures.length, 0);
});

test("OpenClawWebSocketWorkboardAdapter does not retry JSON-RPC application errors", async () => {
  let attempts = 0;
  const adapter = new OpenClawWebSocketWorkboardAdapter({
    url: "ws://example.invalid/workboard",
    socketFactory: () => {
      attempts += 1;

      const socket: {
        readyState: number;
        send(data: string): void;
        close(): void;
        onopen: ((event: { type: "open" }) => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: ((event: { error?: unknown }) => void) | null;
        onclose: ((event: { code: number; reason: string }) => void) | null;
      } = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data: string) {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          queueMicrotask(() => {
            socket.onmessage?.({
              data: JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                error: {
                  code: -32000,
                  message: "Worker socket pool unavailable",
                },
              }),
            });
          });
        },
        close() {
          socket.onclose?.({ code: 1000, reason: "closed" });
        },
      };

      queueMicrotask(() => {
        socket.onopen?.({ type: "open" });
      });

      return socket;
    },
  });

  await assert.rejects(async () => adapter.createCard(payload), /JSON-RPC error -32000: Worker socket pool unavailable/);
  assert.equal(attempts, 1);
});

test("loadConfig rejects non-WebSocket transport URLs", () => {
  assert.throws(
    () =>
      loadConfig({
        OPENCLAW_WORKBOARD_WS_URL: "https://example.invalid/workboard",
      }),
    /must be a ws:\/\/ or wss:\/\/ URL/,
  );
});
