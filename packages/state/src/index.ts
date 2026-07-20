import type { ClaimRecord, ClickUpTask, WorkboardState } from "@clickup-openclaw/shared";

export type JobRecord = {
  task: ClickUpTask;
  state: WorkboardState;
  claim?: ClaimRecord;
  lastError?: string;
  updatedAt: string;
};

export class InMemoryStateStore {
  private readonly jobs = new Map<string, JobRecord>();

  upsertJob(job: JobRecord): void {
    this.jobs.set(job.task.id, job);
  }

  getJob(taskId: string): JobRecord | undefined {
    return this.jobs.get(taskId);
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()];
  }
}
