export class InMemoryStateStore {
    jobs = new Map();
    upsertJob(job) {
        this.jobs.set(job.task.id, job);
    }
    getJob(taskId) {
        return this.jobs.get(taskId);
    }
    listJobs() {
        return [...this.jobs.values()];
    }
}
