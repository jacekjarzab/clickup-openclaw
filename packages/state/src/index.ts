import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  BridgeJobState,
  BridgeToWorkboardCard,
  ClaimRecord,
  ClickUpTask,
  IdempotencyRecord,
  OpenClawTerminalContext,
  OpenClawWorkboardCardStatus,
  WorkerEvent,
  WorkboardState,
} from "@clickup-openclaw/shared";

export type ClickUpWriteBackState = {
  running?: {
    commentKey?: string | undefined;
    commentAttemptedAt?: string | undefined;
    statusKey?: string | undefined;
    statusAttemptedAt?: string | undefined;
    lastSyncedAt?: string | undefined;
  } | undefined;
  terminal?: {
    commentKey?: string | undefined;
    commentAttemptedAt?: string | undefined;
    statusKey?: string | undefined;
    statusAttemptedAt?: string | undefined;
    lastSyncedStatus?: OpenClawWorkboardCardStatus | undefined;
    lastSyncedAt?: string | undefined;
  } | undefined;
};

export type JobRecord = {
  task: ClickUpTask;
  state: WorkboardState;
  bridgeState?: BridgeJobState | undefined;
  claim: ClaimRecord | undefined;
  handoffPayload?: BridgeToWorkboardCard | undefined;
  workboardCardId?: string | undefined;
  openClawCardStatus?: OpenClawWorkboardCardStatus | undefined;
  terminalContext?: OpenClawTerminalContext | undefined;
  clickupWriteBack?: ClickUpWriteBackState | undefined;
  handedOffAt?: string | undefined;
  dispatchedAt?: string | undefined;
  idempotencyKey: string | undefined;
  workType: string | undefined;
  workflowTemplate: string | undefined;
  decompositionPlan: string | undefined;
  triageReason: string | undefined;
  template: string | undefined;
  retryCount: number;
  lastError: string | undefined;
  lastEventAt: string | undefined;
  updatedAt: string;
  events: WorkerEvent[];
  blockedAt?: string | undefined;
  claimedAt?: string | undefined;
  terminalAt?: string | undefined;
  outcome?: "succeeded" | "failed" | "blocked" | "deadLettered" | undefined;
  deadLetteredAt?: string | undefined;
  deadLetterReason?: string | undefined;
};

export type JobPatch = {
  task?: ClickUpTask | undefined;
  state?: WorkboardState | undefined;
  bridgeState?: BridgeJobState | undefined;
  claim?: ClaimRecord | undefined;
  handoffPayload?: BridgeToWorkboardCard | undefined;
  workboardCardId?: string | undefined;
  openClawCardStatus?: OpenClawWorkboardCardStatus | undefined;
  terminalContext?: OpenClawTerminalContext | undefined;
  clickupWriteBack?: ClickUpWriteBackState | undefined;
  handedOffAt?: string | undefined;
  dispatchedAt?: string | undefined;
  idempotencyKey?: string | undefined;
  workType?: string | undefined;
  workflowTemplate?: string | undefined;
  decompositionPlan?: string | undefined;
  triageReason?: string | undefined;
  template?: string | undefined;
  retryCount?: number | undefined;
  lastError?: string | undefined;
  lastEventAt?: string | undefined;
  updatedAt?: string | undefined;
  events?: WorkerEvent[] | undefined;
  blockedAt?: string | undefined;
  claimedAt?: string | undefined;
  terminalAt?: string | undefined;
  outcome?: "succeeded" | "failed" | "blocked" | "deadLettered" | undefined;
  deadLetteredAt?: string | undefined;
  deadLetterReason?: string | undefined;
};

type PersistedState = {
  idempotency: IdempotencyRecord[];
  jobs: JobRecord[];
};

function cloneJob(job: JobRecord): JobRecord {
  return {
    ...job,
    ...(job.terminalContext === undefined
      ? {}
      : {
          terminalContext: {
            ...job.terminalContext,
            artifacts: job.terminalContext.artifacts?.slice(),
            comments: job.terminalContext.comments?.slice(),
          },
        }),
    ...(job.clickupWriteBack === undefined
      ? {}
      : {
          clickupWriteBack: {
            ...(job.clickupWriteBack.running === undefined
              ? {}
              : {
                  running: {
                    ...job.clickupWriteBack.running,
                  },
                }),
            ...(job.clickupWriteBack.terminal === undefined
              ? {}
              : {
                  terminal: {
                    ...job.clickupWriteBack.terminal,
                  },
                }),
          },
        }),
    events: job.events.slice(),
  };
}

export class InMemoryStateStore {
  protected readonly jobs = new Map<string, JobRecord>();
  protected readonly idempotency = new Map<string, IdempotencyRecord>();

  upsertJob(job: JobRecord): void {
    this.jobs.set(job.task.id, cloneJob(job));
  }

  mergeJob(taskId: string, patch: JobPatch): JobRecord | undefined {
    const current = this.jobs.get(taskId);
    if (current === undefined) {
      return undefined;
    }

    const next: JobRecord = { ...current };

    if ("task" in patch && patch.task !== undefined) next.task = patch.task;
    if ("state" in patch && patch.state !== undefined) next.state = patch.state;
    if ("bridgeState" in patch) next.bridgeState = patch.bridgeState;
    if ("claim" in patch) next.claim = patch.claim;
    if ("handoffPayload" in patch) next.handoffPayload = patch.handoffPayload;
    if ("workboardCardId" in patch) next.workboardCardId = patch.workboardCardId;
    if ("openClawCardStatus" in patch) next.openClawCardStatus = patch.openClawCardStatus;
    if ("terminalContext" in patch) next.terminalContext = patch.terminalContext;
    if ("clickupWriteBack" in patch) next.clickupWriteBack = patch.clickupWriteBack;
    if ("handedOffAt" in patch) next.handedOffAt = patch.handedOffAt;
    if ("dispatchedAt" in patch) next.dispatchedAt = patch.dispatchedAt;
    if ("idempotencyKey" in patch) next.idempotencyKey = patch.idempotencyKey;
    if ("workType" in patch) next.workType = patch.workType;
    if ("workflowTemplate" in patch) next.workflowTemplate = patch.workflowTemplate;
    if ("decompositionPlan" in patch) next.decompositionPlan = patch.decompositionPlan;
    if ("triageReason" in patch) next.triageReason = patch.triageReason;
    if ("template" in patch) next.template = patch.template;
    if ("retryCount" in patch && patch.retryCount !== undefined) next.retryCount = patch.retryCount;
    if ("lastError" in patch) next.lastError = patch.lastError;
    if ("lastEventAt" in patch) next.lastEventAt = patch.lastEventAt;
    if ("updatedAt" in patch && patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;
    if ("events" in patch && patch.events !== undefined) next.events = patch.events.slice();
    if ("blockedAt" in patch) next.blockedAt = patch.blockedAt;
    if ("claimedAt" in patch) next.claimedAt = patch.claimedAt;
    if ("terminalAt" in patch) next.terminalAt = patch.terminalAt;
    if ("outcome" in patch) next.outcome = patch.outcome;
    if ("deadLetteredAt" in patch) next.deadLetteredAt = patch.deadLetteredAt;
    if ("deadLetterReason" in patch) next.deadLetterReason = patch.deadLetterReason;

    this.jobs.set(taskId, next);
    return next;
  }

  appendJobEvent(taskId: string, event: WorkerEvent): JobRecord | undefined {
    const current = this.jobs.get(taskId);
    if (current === undefined) {
      return undefined;
    }

    const next: JobRecord = {
      ...current,
      events: [...current.events, event].slice(-100),
      lastEventAt: event.at,
      updatedAt: event.at,
    };

    this.jobs.set(taskId, next);
    return next;
  }

  getJob(taskId: string): JobRecord | undefined {
    return this.jobs.get(taskId);
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()];
  }

  recordIdempotency(record: IdempotencyRecord): boolean {
    const existing = this.idempotency.get(record.key);
    if (existing !== undefined) {
      existing.lastSeenAt = record.lastSeenAt;
      return false;
    }

    this.idempotency.set(record.key, record);
    return true;
  }

  hasIdempotencyKey(key: string): boolean {
    return this.idempotency.has(key);
  }

  listIdempotencyRecords(): IdempotencyRecord[] {
    return [...this.idempotency.values()];
  }
}

export class FileBackedStateStore extends InMemoryStateStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  override upsertJob(job: JobRecord): void {
    super.upsertJob(job);
    this.persist();
  }

  override mergeJob(taskId: string, patch: JobPatch): JobRecord | undefined {
    const result = super.mergeJob(taskId, patch);
    if (result !== undefined) {
      this.persist();
    }
    return result;
  }

  override appendJobEvent(taskId: string, event: WorkerEvent): JobRecord | undefined {
    const result = super.appendJobEvent(taskId, event);
    if (result !== undefined) {
      this.persist();
    }
    return result;
  }

  override recordIdempotency(record: IdempotencyRecord): boolean {
    const result = super.recordIdempotency(record);
    this.persist();
    return result;
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const record of parsed.idempotency ?? []) {
        this.idempotency.set(record.key, record);
      }
      for (const job of parsed.jobs ?? []) {
        this.jobs.set(job.task.id, cloneJob(job));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload: PersistedState = {
      idempotency: [...this.idempotency.values()],
      jobs: [...this.jobs.values()].map(cloneJob),
    };
    writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
