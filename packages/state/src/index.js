import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function cloneJob(job) {
    return {
        ...job,
        events: job.events.slice(),
    };
}
export class InMemoryStateStore {
    jobs = new Map();
    idempotency = new Map();
    upsertJob(job) {
        this.jobs.set(job.task.id, cloneJob(job));
    }
    mergeJob(taskId, patch) {
        const current = this.jobs.get(taskId);
        if (current === undefined) {
            return undefined;
        }
        const next = { ...current };
        if ("task" in patch && patch.task !== undefined)
            next.task = patch.task;
        if ("state" in patch && patch.state !== undefined)
            next.state = patch.state;
        if ("bridgeState" in patch)
            next.bridgeState = patch.bridgeState;
        if ("claim" in patch)
            next.claim = patch.claim;
        if ("handoffPayload" in patch)
            next.handoffPayload = patch.handoffPayload;
        if ("workboardCardId" in patch)
            next.workboardCardId = patch.workboardCardId;
        if ("openClawCardStatus" in patch)
            next.openClawCardStatus = patch.openClawCardStatus;
        if ("handedOffAt" in patch)
            next.handedOffAt = patch.handedOffAt;
        if ("dispatchedAt" in patch)
            next.dispatchedAt = patch.dispatchedAt;
        if ("idempotencyKey" in patch)
            next.idempotencyKey = patch.idempotencyKey;
        if ("workType" in patch)
            next.workType = patch.workType;
        if ("workflowTemplate" in patch)
            next.workflowTemplate = patch.workflowTemplate;
        if ("decompositionPlan" in patch)
            next.decompositionPlan = patch.decompositionPlan;
        if ("triageReason" in patch)
            next.triageReason = patch.triageReason;
        if ("template" in patch)
            next.template = patch.template;
        if ("retryCount" in patch && patch.retryCount !== undefined)
            next.retryCount = patch.retryCount;
        if ("lastError" in patch)
            next.lastError = patch.lastError;
        if ("lastEventAt" in patch)
            next.lastEventAt = patch.lastEventAt;
        if ("updatedAt" in patch && patch.updatedAt !== undefined)
            next.updatedAt = patch.updatedAt;
        if ("events" in patch && patch.events !== undefined)
            next.events = patch.events.slice();
        if ("blockedAt" in patch)
            next.blockedAt = patch.blockedAt;
        if ("claimedAt" in patch)
            next.claimedAt = patch.claimedAt;
        if ("terminalAt" in patch)
            next.terminalAt = patch.terminalAt;
        if ("outcome" in patch)
            next.outcome = patch.outcome;
        if ("deadLetteredAt" in patch)
            next.deadLetteredAt = patch.deadLetteredAt;
        if ("deadLetterReason" in patch)
            next.deadLetterReason = patch.deadLetterReason;
        this.jobs.set(taskId, next);
        return next;
    }
    appendJobEvent(taskId, event) {
        const current = this.jobs.get(taskId);
        if (current === undefined) {
            return undefined;
        }
        const next = {
            ...current,
            events: [...current.events, event].slice(-100),
            lastEventAt: event.at,
            updatedAt: event.at,
        };
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
export class FileBackedStateStore extends InMemoryStateStore {
    filePath;
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.load();
    }
    upsertJob(job) {
        super.upsertJob(job);
        this.persist();
    }
    mergeJob(taskId, patch) {
        const result = super.mergeJob(taskId, patch);
        if (result !== undefined) {
            this.persist();
        }
        return result;
    }
    appendJobEvent(taskId, event) {
        const result = super.appendJobEvent(taskId, event);
        if (result !== undefined) {
            this.persist();
        }
        return result;
    }
    recordIdempotency(record) {
        const result = super.recordIdempotency(record);
        this.persist();
        return result;
    }
    load() {
        try {
            const raw = readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            for (const record of parsed.idempotency ?? []) {
                this.idempotency.set(record.key, record);
            }
            for (const job of parsed.jobs ?? []) {
                this.jobs.set(job.task.id, cloneJob(job));
            }
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT") {
                throw error;
            }
        }
    }
    persist() {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const payload = {
            idempotency: [...this.idempotency.values()],
            jobs: [...this.jobs.values()].map(cloneJob),
        };
        writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }
}
