export class InMemoryStateStore {
    jobs = new Map();
    idempotency = new Map();
    upsertJob(job) {
        this.jobs.set(job.task.id, job);
    }
    mergeJob(taskId, patch) {
        const current = this.jobs.get(taskId);
        if (current === undefined) {
            return undefined;
        }
        const next = { ...current };
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
        this.jobs.set(taskId, next);
        return next;
    }
    getJob(taskId) {
        return this.jobs.get(taskId);
    }
    listJobs() {
        return [...this.jobs.values()];
    }
    recordIdempotency(record) {
        const existing = this.idempotency.get(record.key);
        if (existing !== undefined) {
            existing.lastSeenAt = record.lastSeenAt;
            return false;
        }
        this.idempotency.set(record.key, record);
        return true;
    }
    hasIdempotencyKey(key) {
        return this.idempotency.has(key);
    }
    listIdempotencyRecords() {
        return [...this.idempotency.values()];
    }
}
