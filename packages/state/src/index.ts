import type {
  ClaimRecord,
  ClickUpTask,
  IdempotencyRecord,
  WorkerEvent,
  WorkboardState,
} from "@clickup-openclaw/shared";

export type JobRecord = {
  task: ClickUpTask;
  state: WorkboardState;
  claim: ClaimRecord | undefined;
  idempotencyKey: string | undefined;
  workType: string | undefined;
  template: string | undefined;
  retryCount: number;
  lastError: string | undefined;
  lastEventAt: string | undefined;
  updatedAt: string;
  events: WorkerEvent[];
  claimedAt?: string | undefined;
  terminalAt?: string | undefined;
  outcome?: "succeeded" | "failed" | "blocked" | "deadLettered" | undefined;
  deadLetteredAt?: string | undefined;
  deadLetterReason?: string | undefined;
};

export type JobPatch = {
  task?: ClickUpTask | undefined;
  state?: WorkboardState | undefined;
  claim?: ClaimRecord | undefined;
  idempotencyKey?: string | undefined;
  workType?: string | undefined;
  template?: string | undefined;
  retryCount?: number | undefined;
  lastError?: string | undefined;
  lastEventAt?: string | undefined;
  updatedAt?: string | undefined;
  events?: WorkerEvent[] | undefined;
  claimedAt?: string | undefined;
  terminalAt?: string | undefined;
  outcome?: "succeeded" | "failed" | "blocked" | "deadLettered" | undefined;
  deadLetteredAt?: string | undefined;
  deadLetterReason?: string | undefined;
};

export class InMemoryStateStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  upsertJob(job: JobRecord): void {
    this.jobs.set(job.task.id, {
      ...job,
      events: job.events.slice(),
    });
  }

  mergeJob(taskId: string, patch: JobPatch): JobRecord | undefined {
    const current = this.jobs.get(taskId);
    if (current === undefined) {
      return undefined;
    }

    const next: JobRecord = { ...current };

    if ("task" in patch && patch.task !== undefined) {
      next.task = patch.task;
    }
    if ("state" in patch && patch.state !== undefined) {
      next.state = patch.state;
    }
    if ("claim" in patch) {
      next.claim = patch.claim;
    }
    if ("idempotencyKey" in patch) {
      next.idempotencyKey = patch.idempotencyKey;
    }
    if ("workType" in patch) {
      next.workType = patch.workType;
    }
    if ("template" in patch) {
      next.template = patch.template;
    }
    if ("retryCount" in patch && patch.retryCount !== undefined) {
      next.retryCount = patch.retryCount;
    }
    if ("lastError" in patch) {
      next.lastError = patch.lastError;
    }
    if ("lastEventAt" in patch) {
      next.lastEventAt = patch.lastEventAt;
    }
    if ("updatedAt" in patch && patch.updatedAt !== undefined) {
      next.updatedAt = patch.updatedAt;
    }
    if ("events" in patch && patch.events !== undefined) {
      next.events = patch.events.slice();
    }
    if ("claimedAt" in patch) {
      next.claimedAt = patch.claimedAt;
    }
    if ("terminalAt" in patch) {
      next.terminalAt = patch.terminalAt;
    }
    if ("outcome" in patch) {
      next.outcome = patch.outcome;
    }
    if ("deadLetteredAt" in patch) {
      next.deadLetteredAt = patch.deadLetteredAt;
    }
    if ("deadLetterReason" in patch) {
      next.deadLetterReason = patch.deadLetterReason;
    }

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
