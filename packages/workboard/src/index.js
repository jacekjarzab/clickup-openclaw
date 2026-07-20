export class InMemoryWorkboard {
    queue = [];
    claims = new Map();
    queuedTaskIds = new Set();
    enqueue(item) {
        if (this.queuedTaskIds.has(item.taskId) || this.claims.has(item.taskId)) {
            return;
        }
        this.queue.push(item);
        this.queuedTaskIds.add(item.taskId);
        this.queue.sort((left, right) => right.priority - left.priority);
    }
    next() {
        const item = this.queue.shift();
        if (item !== undefined) {
            this.queuedTaskIds.delete(item.taskId);
        }
        return item;
    }
    claim(record) {
        this.claims.set(record.taskId, record);
        this.queuedTaskIds.delete(record.taskId);
    }
    getClaim(taskId) {
        return this.claims.get(taskId);
    }
    release(taskId) {
        this.claims.delete(taskId);
    }
    renew(taskId, leaseExpiresAt) {
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
    reclaimExpired(now) {
        const reclaimed = [];
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
    listClaims() {
        return [...this.claims.values()];
    }
}
