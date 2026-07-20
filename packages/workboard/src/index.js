export class InMemoryWorkboard {
    queue = [];
    claims = new Map();
    enqueue(item) {
        this.queue.push(item);
        this.queue.sort((left, right) => right.priority - left.priority);
    }
    next() {
        return this.queue.shift();
    }
    claim(record) {
        this.claims.set(record.taskId, record);
    }
    getClaim(taskId) {
        return this.claims.get(taskId);
    }
    release(taskId) {
        this.claims.delete(taskId);
    }
}
