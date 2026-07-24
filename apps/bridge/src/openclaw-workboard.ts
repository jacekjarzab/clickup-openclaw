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

function parseJsonObject(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object from openclaw workboard command");
  }

  return parsed as Record<string, unknown>;
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

  return value.flatMap((item) => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }

    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const candidate =
        readNestedString(record, ["url"]) ??
        readNestedString(record, ["href"]) ??
        readNestedString(record, ["link"]) ??
        readNestedString(record, ["artifactUrl"]) ??
        readNestedString(record, ["artifact_url"]) ??
        readNestedString(record, ["title"]) ??
        readNestedString(record, ["name"]);

      return [candidate ?? record];
    }

    return [];
  });
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

  constructor(options: OpenClawWorkboardAdapterOptions = {}) {
    this.binary = options.binary ?? "openclaw";
    this.boardId = options.boardId;
    this.cwd = options.cwd;
    this.runner = options.runner ?? defaultRunner;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createCard(input: BridgeToWorkboardCard): Promise<OpenClawWorkboardCardSummary> {
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
    const id = typeof raw.id === "string" ? raw.id : undefined;
    if (id === undefined) {
      throw new Error("OpenClaw card create response did not include an id");
    }

    return toCardSummary(id, raw);
  }

  async showCard(id: string): Promise<OpenClawWorkboardCardSummary> {
    const { stdout } = await this.runner(this.binary, ["workboard", "show", id, "--json"], buildRunnerOptions(this.cwd, this.timeoutMs));
    const raw = parseJsonObject(stdout);
    return toCardSummary(typeof raw.id === "string" ? raw.id : id, raw);
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

    const { stdout } = await this.runner(
      this.binary,
      args,
      buildRunnerOptions(this.cwd, this.timeoutMs),
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Expected JSON array from openclaw workboard list");
    }

    return parsed
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((raw) => toCardSummary(typeof raw.id === "string" ? raw.id : "", raw))
      .filter((item) => item.id.length > 0);
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

    const { stdout } = await this.runner(
      this.binary,
      args,
      buildRunnerOptions(this.cwd, this.timeoutMs),
    );

    return parseJsonObject(stdout);
  }
}
