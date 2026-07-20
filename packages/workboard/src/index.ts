import type { ClaimRecord } from "@clickup-openclaw/shared";

export type WorkItem = {
  taskId: string;
  priority: number;
  requestedAt: string;
};

export class InMemoryWorkboard {
  private readonly queue: WorkItem[] = [];

  private readonly claims = new Map<string, ClaimRecord>();

  enqueue(item: WorkItem): void {
    this.queue.push(item);
    this.queue.sort((left, right) => right.priority - left.priority);
  }

  next(): WorkItem | undefined {
    return this.queue.shift();
  }

  claim(record: ClaimRecord): void {
    this.claims.set(record.taskId, record);
  }

  getClaim(taskId: string): ClaimRecord | undefined {
    return this.claims.get(taskId);
  }

  release(taskId: string): void {
    this.claims.delete(taskId);
  }
}
