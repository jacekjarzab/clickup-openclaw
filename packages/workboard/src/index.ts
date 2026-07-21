import type { ClaimRecord } from "@clickup-openclaw/shared";

export type WorkItem = {
  taskId: string;
  priority: number;
  requestedAt: string;
  idempotencyKey?: string;
};

export class InMemoryWorkboard {
  private readonly queue: WorkItem[] = [];

  private readonly claims = new Map<string, ClaimRecord>();
  private readonly queuedTaskIds = new Set<string>();

  enqueue(item: WorkItem): void {
    if (this.queuedTaskIds.has(item.taskId) || this.claims.has(item.taskId)) {
      return;
    }

    this.queue.push(item);
    this.queuedTaskIds.add(item.taskId);
    this.queue.sort((left, right) => right.priority - left.priority);
  }

  next(): WorkItem | undefined {
    const item = this.queue.shift();
    if (item !== undefined) {
      this.queuedTaskIds.delete(item.taskId);
    }

    return item;
  }

  removeQueued(taskId: string): WorkItem | undefined {
    const index = this.queue.findIndex((item) => item.taskId === taskId);
    if (index === -1) {
      return undefined;
    }

    const [removed] = this.queue.splice(index, 1);
    this.queuedTaskIds.delete(taskId);
    return removed;
  }

  claim(record: ClaimRecord): void {
    this.claims.set(record.taskId, record);
    this.queuedTaskIds.delete(record.taskId);
  }

  getClaim(taskId: string): ClaimRecord | undefined {
    return this.claims.get(taskId);
  }

  release(taskId: string): void {
    this.claims.delete(taskId);
  }

  renew(taskId: string, leaseExpiresAt: string): ClaimRecord | undefined {
    const current = this.claims.get(taskId);
    if (current === undefined) {
      return undefined;
    }

    const next = {
      ...current,
      leaseExpiresAt,
    };
    this.claims.set(taskId, next);
    return next;
  }

  reclaimExpired(now: string): WorkItem[] {
    const reclaimed: WorkItem[] = [];

    for (const [taskId, claim] of this.claims.entries()) {
      if (claim.leaseExpiresAt > now) {
        continue;
      }

      this.claims.delete(taskId);
      if (!this.queuedTaskIds.has(taskId)) {
        const item = {
          taskId,
          priority: 0,
          requestedAt: now,
        };
        this.queue.push(item);
        this.queuedTaskIds.add(taskId);
        reclaimed.push(item);
      }
    }

    this.queue.sort((left, right) => right.priority - left.priority);
    return reclaimed;
  }

  listClaims(): ClaimRecord[] {
    return [...this.claims.values()];
  }

  listQueuedItems(): WorkItem[] {
    return [...this.queue];
  }
}
