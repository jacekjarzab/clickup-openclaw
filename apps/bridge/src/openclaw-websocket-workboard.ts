import {
  bridgeToWorkboardCardSchema,
  openClawWorkboardCardStatusSchema,
  type BridgeToWorkboardCard,
  type OpenClawTerminalContext,
  type OpenClawWorkboardCardStatus,
} from "@clickup-openclaw/shared";
import {
  type OpenClawWorkboardTransport,
  type OpenClawTransportOperationName,
  type OpenClawTransportSnapshot,
  type OpenClawWorkboardCardSummary,
  type OpenClawWorkboardDispatchResult,
} from "./openclaw-workboard.js";

type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: { type: "open" }) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
};

type WebSocketConstructorLike = new (url: string, protocols?: string | string[]) => WebSocketLike;

type WebSocketRpcErrorPayload = {
  code?: number;
  message: string;
  data?: unknown;
};

type WebSocketRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: WebSocketRpcErrorPayload;
};

class OpenClawWebSocketRpcError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = "OpenClawWebSocketRpcError";
  }
}

export type OpenClawWebSocketWorkboardAdapterOptions = {
  url: string;
  boardId?: string;
  protocols?: string | string[];
  retry?: Partial<RetryOptions>;
  timeoutMs?: number;
  socketFactory?: (url: string, protocols?: string | string[]) => WebSocketLike;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetriableWebSocketError(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "retriable" in error) {
    const retriable = (error as { retriable?: unknown }).retriable;
    if (typeof retriable === "boolean") {
      return retriable;
    }
  }

  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("close before") ||
    message.includes("closed before") ||
    message.includes("temporary") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("unavailable") ||
    message.includes("fetch failed")
  );
}

function normalizeCardStatus(value: unknown): OpenClawWorkboardCardStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = openClawWorkboardCardStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readCardRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.id === "string") {
    return value;
  }

  const nestedCard = value.card;
  if (nestedCard !== null && typeof nestedCard === "object" && !Array.isArray(nestedCard)) {
    return nestedCard as Record<string, unknown>;
  }

  return undefined;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}

function readNestedValue(record: Record<string, unknown>, path: string[]): unknown | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function readTerminalArtifactList(value: unknown): Array<string | Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  const artifacts: Array<string | Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        artifacts.push(trimmed);
      }
      continue;
    }

    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const url =
        readNestedString(record, ["url"]) ??
        readNestedString(record, ["href"]) ??
        readNestedString(record, ["link"]) ??
        readNestedString(record, ["artifactUrl"]) ??
        readNestedString(record, ["artifact_url"]);
      const title = readNestedString(record, ["title"]) ?? readNestedString(record, ["name"]);

      if (title !== undefined && url !== undefined) {
        artifacts.push({ title, url });
      } else if (url !== undefined) {
        artifacts.push(url);
      } else if (title !== undefined) {
        artifacts.push(title);
      } else {
        artifacts.push(record);
      }
    }
  }

  return artifacts;
}

function readTerminalCommentList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function extractTerminalContext(
  raw: Record<string, unknown>,
  status: OpenClawWorkboardCardStatus,
): OpenClawTerminalContext {
  const summary =
    readNestedString(raw, ["summary"]) ??
    readNestedString(raw, ["execution", "summary"]) ??
    readNestedString(raw, ["proof", "note"]) ??
    readNestedString(raw, ["execution", "proof", "note"]) ??
    readNestedString(raw, ["notes"]);
  const proof = readNestedValue(raw, ["proof"]) ?? readNestedValue(raw, ["execution", "proof"]);
  const artifacts = [
    ...readTerminalArtifactList(readNestedValue(raw, ["artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["proof", "artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "proof", "artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["proof", "links"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "links"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "proof", "links"])),
  ];
  const comments = [
    ...readTerminalCommentList(readNestedValue(raw, ["comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["execution", "comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["proof", "comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["execution", "proof", "comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["comment"])),
    ...readTerminalCommentList(readNestedValue(raw, ["execution", "comment"])),
  ];
  const blockerContext =
    readNestedString(raw, ["blockerContext"]) ??
    readNestedString(raw, ["blocker_context"]) ??
    readNestedString(raw, ["blockerReason"]) ??
    readNestedString(raw, ["blocker_reason"]) ??
    readNestedString(raw, ["execution", "blockerContext"]) ??
    readNestedString(raw, ["execution", "blocker_context"]) ??
    readNestedString(raw, ["execution", "blockerReason"]) ??
    readNestedString(raw, ["execution", "blocker_reason"]) ??
    readNestedString(raw, ["execution", "proof", "blockerContext"]) ??
    readNestedString(raw, ["execution", "proof", "blocker_context"]) ??
    readNestedString(raw, ["execution", "proof", "blockerReason"]) ??
    readNestedString(raw, ["execution", "proof", "blocker_reason"]) ??
    readNestedString(raw, ["blocker", "reason"]) ??
    readNestedString(raw, ["proof", "blockerReason"]) ??
    readNestedString(raw, ["proof", "blocker_reason"]) ??
    readNestedString(raw, ["proof", "blocker"]);

  return {
    ...(summary === undefined ? {} : { summary }),
    ...(proof === undefined ? {} : { proof }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(comments.length === 0 ? {} : { comments }),
    ...(blockerContext === undefined && status === "blocked" && summary !== undefined
      ? { blockerContext: summary }
      : blockerContext === undefined
        ? {}
        : { blockerContext }),
  };
}

function toCardSummary(id: string, raw: Record<string, unknown>): OpenClawWorkboardCardSummary {
  const status = normalizeCardStatus(raw.status);
  const terminalContext = status === undefined ? undefined : extractTerminalContext(raw, status);
  return {
    id,
    raw,
    ...(terminalContext === undefined ? {} : { terminalContext }),
    ...(status === undefined ? {} : { status }),
  };
}

function createDefaultSocket(url: string, protocols?: string | string[]): WebSocketLike {
  const WebSocketCtor = (globalThis as { WebSocket?: WebSocketConstructorLike }).WebSocket;
  if (WebSocketCtor === undefined) {
    throw new Error("WebSocket API is not available in this runtime");
  }

  return new WebSocketCtor(url, protocols);
}

export class OpenClawWebSocketWorkboardAdapter implements OpenClawWorkboardTransport {
  private readonly url: string;

  private readonly boardId: string | undefined;

  private readonly protocols: string | string[] | undefined;

  private readonly timeoutMs: number;

  private readonly retry: RetryOptions;

  private readonly socketFactory: (url: string, protocols?: string | string[]) => WebSocketLike;

  private readonly transportStats: Record<
    OpenClawTransportOperationName,
    {
      calls: number;
      failures: number;
      lastError: string | undefined;
      retries: number;
      totalDurationMs: number;
    }
  >;

  private readonly recentFailures: Array<{
    at: string;
    error: string;
    operation: OpenClawTransportOperationName;
  }>;

  constructor(options: OpenClawWebSocketWorkboardAdapterOptions) {
    this.url = options.url;
    this.boardId = options.boardId;
    this.protocols = options.protocols;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retry = {
      attempts: Math.max(1, options.retry?.attempts ?? 3),
      baseDelayMs: Math.max(0, options.retry?.baseDelayMs ?? 250),
      maxDelayMs: Math.max(0, options.retry?.maxDelayMs ?? 2_000),
    };
    this.socketFactory = options.socketFactory ?? createDefaultSocket;
    this.transportStats = {
      createCard: { calls: 0, failures: 0, lastError: undefined, retries: 0, totalDurationMs: 0 },
      showCard: { calls: 0, failures: 0, lastError: undefined, retries: 0, totalDurationMs: 0 },
      listCards: { calls: 0, failures: 0, lastError: undefined, retries: 0, totalDurationMs: 0 },
      dispatch: { calls: 0, failures: 0, lastError: undefined, retries: 0, totalDurationMs: 0 },
    };
    this.recentFailures = [];
  }

  private recordTransportOutcome(
    operation: OpenClawTransportOperationName,
    durationMs: number,
    attempts: number,
    error?: string | undefined,
  ): void {
    const stats = this.transportStats[operation];
    stats.calls += 1;
    stats.totalDurationMs += durationMs;
    stats.retries += Math.max(0, attempts - 1);

    if (error === undefined) {
      return;
    }

    stats.failures += 1;
    stats.lastError = error;
    this.recentFailures.unshift({
      at: new Date().toISOString(),
      error,
      operation,
    });
    this.recentFailures.length = Math.min(this.recentFailures.length, 10);
  }

  private async runWithRetry<T>(
    operation: OpenClawTransportOperationName,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    let attempts = 0;

    for (; attempts < this.retry.attempts; attempts += 1) {
      try {
        const result = await fn();
        this.recordTransportOutcome(operation, Date.now() - startedAt, attempts + 1);
        return result;
      } catch (error) {
        if (!isRetriableWebSocketError(error) || attempts + 1 >= this.retry.attempts) {
          const failureMessage = errorMessage(error);
          this.recordTransportOutcome(operation, Date.now() - startedAt, attempts + 1, failureMessage);
          throw error instanceof Error ? error : new Error(`Failed to ${label} openclaw websocket`);
        }

        const delayMs = Math.min(this.retry.baseDelayMs * 2 ** attempts, this.retry.maxDelayMs);
        await sleep(delayMs);
      }
    }

    throw new Error(`Failed to ${label} openclaw websocket`);
  }

  private async request<T>(
    operation: OpenClawTransportOperationName,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const requestId = Math.floor(Date.now() + Math.random() * 1_000_000);
    const payload = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return this.runWithRetry(operation, method, async () => {
      let socket: WebSocketLike | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      socket = this.socketFactory(this.url, this.protocols);

      return await new Promise<T>((resolve, reject) => {
        let settled = false;

        const settle = (error?: unknown, result?: T) => {
          if (settled) {
            return;
          }

          settled = true;

          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }

          try {
            socket?.close();
          } catch {
            // Ignore close failures during cleanup.
          }

          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve(result as T);
        };

        timeoutId = setTimeout(() => {
          settle(new Error(`Timed out waiting for ${method} websocket response`));
        }, this.timeoutMs);

        socket!.onopen = () => {
          try {
            socket!.send(JSON.stringify(payload));
          } catch (error) {
            settle(error);
          }
        };

        socket!.onmessage = (event) => {
          try {
            const response = JSON.parse(String(event.data)) as WebSocketRpcResponse;
            if (response.jsonrpc !== "2.0" || response.id !== requestId) {
              settle(new Error(`Unexpected websocket response for ${method}`));
              return;
            }

            if (response.error !== undefined) {
              settle(
                new OpenClawWebSocketRpcError(
                  response.error.code === undefined
                    ? response.error.message
                    : `JSON-RPC error ${response.error.code}: ${response.error.message}`,
                ),
              );
              return;
            }

            settle(undefined, response.result as T);
          } catch (error) {
            settle(error);
          }
        };

        socket!.onerror = () => {
          settle(new Error(`WebSocket error while calling ${method}`));
        };

        socket!.onclose = () => {
          settle(new Error(`WebSocket closed before ${method} completed`));
        };
      });
    });
  }

  async createCard(input: BridgeToWorkboardCard): Promise<OpenClawWorkboardCardSummary> {
    const payload = bridgeToWorkboardCardSchema.parse(input);
    const result = await this.request<Record<string, unknown>>("createCard", "workboard.create", {
      ...(this.boardId === undefined ? {} : { boardId: this.boardId }),
      payload,
    });
    const card = readCardRecord(result);
    if (card === undefined) {
      throw new Error("WebSocket workboard create response did not include a card");
    }

    const id = typeof card.id === "string" ? card.id : undefined;
    if (id === undefined) {
      throw new Error("WebSocket workboard create response did not include an id");
    }

    return toCardSummary(id, card);
  }

  async showCard(id: string): Promise<OpenClawWorkboardCardSummary> {
    const result = await this.request<Record<string, unknown>>("showCard", "workboard.show", {
      cardId: id,
    });
    return toCardSummary(typeof result.id === "string" ? result.id : id, result);
  }

  async listCards(input: { boardId?: string; status?: OpenClawWorkboardCardStatus } = {}): Promise<OpenClawWorkboardCardSummary[]> {
    const boardId = input.boardId ?? this.boardId;
    const result = await this.request<unknown>("listCards", "workboard.list", {
      ...(boardId === undefined ? {} : { boardId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });

    if (!Array.isArray(result)) {
      throw new Error("Expected array result from WebSocket workboard list");
    }

    return result
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((raw) => toCardSummary(typeof raw.id === "string" ? raw.id : "", raw))
      .filter((item) => item.id.length > 0);
  }

  async dispatch(input: { boardId?: string; maxStarts?: number } = {}): Promise<OpenClawWorkboardDispatchResult> {
    const boardId = input.boardId ?? this.boardId;
    return this.request<OpenClawWorkboardDispatchResult>("dispatch", "workboard.dispatch", {
      ...(boardId === undefined ? {} : { boardId }),
      ...(input.maxStarts === undefined ? {} : { maxStarts: input.maxStarts }),
    });
  }

  getTransportSnapshot(): OpenClawTransportSnapshot {
    const operations = Object.fromEntries(
      (Object.entries(this.transportStats) as Array<
        [OpenClawTransportOperationName, (typeof this.transportStats)[OpenClawTransportOperationName]]
      >).map(([operation, stats]) => [
        operation,
        {
          calls: stats.calls,
          failures: stats.failures,
          lastError: stats.lastError,
          retries: stats.retries,
          averageDurationMs: stats.calls === 0 ? 0 : Math.round(stats.totalDurationMs / stats.calls),
        },
      ]),
    ) as OpenClawTransportSnapshot["operations"];

    return {
      mode: "websocket",
      endpoint: this.url,
      boardId: this.boardId,
      operations,
      connectionAttempts:
        operations.createCard.calls +
        operations.createCard.retries +
        operations.showCard.calls +
        operations.showCard.retries +
        operations.listCards.calls +
        operations.listCards.retries +
        operations.dispatch.calls +
        operations.dispatch.retries,
      connectionFailures:
        operations.createCard.failures +
        operations.showCard.failures +
        operations.listCards.failures +
        operations.dispatch.failures,
      recentFailures: this.recentFailures.slice(),
    };
  }
}
