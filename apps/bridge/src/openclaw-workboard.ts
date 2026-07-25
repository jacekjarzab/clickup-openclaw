import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  bridgeToWorkboardCardSchema,
  openClawWorkboardCardStatusSchema,
  type OpenClawTerminalContext,
  type BridgeToWorkboardCard,
  type OpenClawWorkboardCardStatus,
} from "@clickup-openclaw/shared";

const execFileAsync = promisify(execFile);

type CommandResult = {
  stdout: string;
  stderr: string;
};

type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type OpenClawCommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export type OpenClawWorkboardDispatchResult = {
  failures?: number;
  gatewayUnavailable?: boolean;
  started?: number;
  [key: string]: unknown;
};

export type OpenClawTransportOperationName = "createCard" | "showCard" | "listCards" | "dispatch";

export type OpenClawTransportOperationSnapshot = {
  calls: number;
  failures: number;
  lastError?: string | undefined;
  retries: number;
  averageDurationMs: number;
};

export type OpenClawTransportSnapshot = {
  mode: "cli" | "websocket";
  binary?: string | undefined;
  endpoint?: string | undefined;
  boardId: string | undefined;
  operations: Record<OpenClawTransportOperationName, OpenClawTransportOperationSnapshot>;
  connectionAttempts: number;
  connectionFailures: number;
  recentFailures: Array<{
    at: string;
    error: string;
    operation: OpenClawTransportOperationName;
  }>;
};

export interface OpenClawWorkboardTransport {
  createCard(input: BridgeToWorkboardCard): Promise<OpenClawWorkboardCardSummary>;
  showCard(id: string): Promise<OpenClawWorkboardCardSummary>;
  listCards(input?: {
    boardId?: string;
    status?: OpenClawWorkboardCardStatus;
  }): Promise<OpenClawWorkboardCardSummary[]>;
  dispatch(input?: { boardId?: string; maxStarts?: number }): Promise<OpenClawWorkboardDispatchResult>;
  getTransportSnapshot(): OpenClawTransportSnapshot;
}

export type OpenClawWorkboardCardSummary = {
  id: string;
  status?: OpenClawWorkboardCardStatus | undefined;
  terminalContext?: OpenClawTerminalContext | undefined;
  raw: Record<string, unknown>;
};

export type OpenClawWorkboardAdapterOptions = {
  binary?: string;
  boardId?: string;
  cwd?: string;
  runner?: OpenClawCommandRunner;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
};

function defaultRunner(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
): Promise<CommandResult> {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetriableOpenClawError(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "retriable" in error) {
    const retriable = (error as { retriable?: unknown }).retriable;
    if (typeof retriable === "boolean") {
      return retriable;
    }
  }

  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("gateway unavailable") ||
    message.includes("temporary") ||
    message.includes("temporarily unavailable") ||
    message.includes("connection refused") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("etimedout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("i/o error") ||
    message.includes("broken pipe")
  );
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object from openclaw workboard command");
  }

  return parsed as Record<string, unknown>;
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

function parseListResponse(stdout: string): Record<string, unknown>[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
  }

  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.cards)) {
      return record.cards.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
    }
  }

  throw new Error("Expected JSON array or { cards: [] } from openclaw workboard list");
}

function normalizeCardStatus(value: unknown): OpenClawWorkboardCardStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = openClawWorkboardCardStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function buildRunnerOptions(cwd: string | undefined, timeoutMs: number): { cwd?: string; timeoutMs?: number } {
  return {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs,
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
        continue;
      }

      if (url !== undefined) {
        artifacts.push(url);
        continue;
      }

      if (title !== undefined) {
        artifacts.push(title);
        continue;
      }

      artifacts.push(record);
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

export function renderBridgeMetadataBlock(payload: BridgeToWorkboardCard): string {
  return [
    "## Bridge metadata",
    "```json",
    JSON.stringify(payload.metadata, null, 2),
    "```",
  ].join("\n");
}

export function buildOpenClawNotes(payload: BridgeToWorkboardCard): string {
  return [payload.card.notes, renderBridgeMetadataBlock(payload)].join("\n\n");
}

export class OpenClawWorkboardAdapter {
  private readonly binary: string;

  private readonly boardId: string | undefined;

  private readonly cwd: string | undefined;

  private readonly runner: OpenClawCommandRunner;

  private readonly timeoutMs: number;

  private readonly retry: RetryOptions;

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

  constructor(options: OpenClawWorkboardAdapterOptions = {}) {
    this.binary = options.binary ?? "openclaw";
    this.boardId = options.boardId;
    this.cwd = options.cwd;
    this.runner = options.runner ?? defaultRunner;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = {
      attempts: Math.max(1, options.retry?.attempts ?? 3),
      baseDelayMs: Math.max(0, options.retry?.baseDelayMs ?? 250),
      maxDelayMs: Math.max(0, options.retry?.maxDelayMs ?? 2_000),
    };
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
        if (!isRetriableOpenClawError(error) || attempts + 1 >= this.retry.attempts) {
          const failureMessage = error instanceof Error ? error.message : String(error);
          this.recordTransportOutcome(operation, Date.now() - startedAt, attempts + 1, failureMessage);
          throw error instanceof Error
            ? error
            : new Error(`Failed to ${label} openclaw workboard`);
        }

        const delayMs = Math.min(this.retry.baseDelayMs * 2 ** attempts, this.retry.maxDelayMs);
        await sleep(delayMs);
      }
    }

    throw new Error(`Failed to ${label} openclaw workboard`);
  }

  async createCard(input: BridgeToWorkboardCard): Promise<OpenClawWorkboardCardSummary> {
    return this.runWithRetry("createCard", "create card", async () => {
      const payload = bridgeToWorkboardCardSchema.parse(input);
      const args = [
        "workboard",
        "create",
        payload.card.title,
        "--notes",
        buildOpenClawNotes(payload),
        "--status",
        payload.card.status,
        "--priority",
        payload.card.priority,
        "--json",
      ];

      const boardId = payload.card.boardId ?? this.boardId;
      if (boardId !== undefined) {
        args.push("--board", boardId);
      }

      if (payload.card.agentId !== undefined) {
        args.push("--agent", payload.card.agentId);
      }

      if (payload.card.labels.length > 0) {
        args.push("--labels", payload.card.labels.join(","));
      }

      const { stdout } = await this.runner(
        this.binary,
        args,
        buildRunnerOptions(this.cwd, this.timeoutMs),
      );
      const raw = parseJsonObject(stdout);
      const card = readCardRecord(raw);
      if (card === undefined) {
        throw new Error("OpenClaw card create response did not include a card");
      }

      const id = typeof card.id === "string" ? card.id : undefined;
      if (id === undefined) {
        throw new Error("OpenClaw card create response did not include an id");
      }

      return toCardSummary(id, card);
    });
  }

  async showCard(id: string): Promise<OpenClawWorkboardCardSummary> {
    return this.runWithRetry("showCard", `show card ${id}`, async () => {
      const { stdout } = await this.runner(
        this.binary,
        ["workboard", "show", id, "--json"],
        buildRunnerOptions(this.cwd, this.timeoutMs),
      );
      const raw = parseJsonObject(stdout);
      return toCardSummary(typeof raw.id === "string" ? raw.id : id, raw);
    });
  }

  async listCards(input: {
    boardId?: string;
    status?: OpenClawWorkboardCardStatus;
  } = {}): Promise<OpenClawWorkboardCardSummary[]> {
    const args = ["workboard", "list", "--json"];
    const boardId = input.boardId ?? this.boardId;
    if (boardId !== undefined) {
      args.push("--board", boardId);
    }
    if (input.status !== undefined) {
      args.push("--status", input.status);
    }

    return this.runWithRetry("listCards", "list cards", async () => {
      const { stdout } = await this.runner(
        this.binary,
        args,
        buildRunnerOptions(this.cwd, this.timeoutMs),
      );
      return parseListResponse(stdout)
        .map((raw) => toCardSummary(typeof raw.id === "string" ? raw.id : "", raw))
        .filter((item) => item.id.length > 0);
    });
  }

  async dispatch(input: { boardId?: string; maxStarts?: number } = {}): Promise<OpenClawWorkboardDispatchResult> {
    const args = ["workboard", "dispatch", "--json"];
    const boardId = input.boardId ?? this.boardId;
    if (boardId !== undefined) {
      args.push("--board", boardId);
    }
    if (input.maxStarts !== undefined) {
      args.push("--max-starts", String(input.maxStarts));
    }

    return this.runWithRetry("dispatch", "dispatch workboard", async () => {
      const { stdout } = await this.runner(
        this.binary,
        args,
        buildRunnerOptions(this.cwd, this.timeoutMs),
      );

      return parseJsonObject(stdout);
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
    ) as Record<OpenClawTransportOperationName, OpenClawTransportOperationSnapshot>;

    return {
      mode: "cli",
      binary: this.binary,
      boardId: this.boardId,
      operations,
      connectionAttempts: 0,
      connectionFailures: 0,
      recentFailures: this.recentFailures.slice(),
    };
  }
}
