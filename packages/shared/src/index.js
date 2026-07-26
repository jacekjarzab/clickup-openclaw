import { z } from "zod";
export const automationStates = [
    "manual",
    "candidate",
    "claimed",
    "running",
    "blocked",
    "done",
];
export const automationStateSchema = z.enum(automationStates);
export const priorityBuckets = ["low", "normal", "high", "urgent"];
export const priorityBucketSchema = z.enum(priorityBuckets);
export const clickupAutomationStatuses = [
    "new",
    "triage",
    "ready for openclaw",
    "in progress",
    "blocked",
    "human-review",
    "approval",
    "done",
    "closed",
];
export const clickupAutomationStatusSchema = z.enum(clickupAutomationStatuses);
export const openClawWorkboardCardStatuses = [
    "triage",
    "backlog",
    "todo",
    "scheduled",
    "ready",
    "running",
    "review",
    "blocked",
    "done",
];
export const openClawWorkboardCardStatusSchema = z.enum(openClawWorkboardCardStatuses);
export const openClawTerminalWorkboardCardStatuses = ["review", "done", "blocked"];
export const openClawTerminalWorkboardCardStatusSchema = z.enum(openClawTerminalWorkboardCardStatuses);
export function isHumanReviewWorkboardStatus(status) {
    return status === "review" || status === "done";
}
export function isBlockedWorkboardStatus(status) {
    return status === "blocked";
}
export const bridgeJobStates = [
    "received",
    "deduplicated",
    "eligible",
    "card_created",
    "dispatched",
    "running",
    "blocked",
    "completed",
    "synced_back",
    "dead_lettered",
];
export const bridgeJobStateSchema = z.enum(bridgeJobStates);
export const workboardStates = [
    "received",
    "normalized",
    "eligible",
    "leased",
    "running",
    "blocked",
    "succeeded",
    "failed",
    "reclaimed",
    "deadLettered",
];
export const workboardStateSchema = z.enum(workboardStates);
export const clickupWebhookEventSchema = z.object({
    event: z.string().min(1),
    taskId: z.string().min(1),
    listId: z.string().min(1).optional(),
    status: z.string().optional(),
    updatedAt: z.string().optional(),
    payload: z.record(z.unknown()).optional(),
});
export const clickupTaskSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1),
    listId: z.string().min(1).optional(),
    projectKey: z.string().min(1).optional(),
    workType: z.string().min(1).optional(),
    routingKey: z.string().min(1).optional(),
    priorityBucket: priorityBucketSchema.optional(),
    automationAllowed: z.boolean().optional(),
    approvalRequired: z.boolean().optional(),
    autoPicked: z.boolean().optional(),
    triageReason: z.string().min(1).optional(),
    priority: z.string().optional(),
    description: z.string().optional(),
    repoUrl: z.string().min(1).optional(),
    prUrl: z.string().min(1).optional(),
    branchName: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    commitUrl: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    updatedAt: z.string().optional(),
    artifactUrl: z.string().min(1).optional(),
    docsUrl: z.string().min(1).optional(),
    designUrl: z.string().min(1).optional(),
});
export const workboardCardPrioritySchema = priorityBucketSchema;
export const workboardCardCreateSchema = z.object({
    title: z.string().min(1),
    notes: z.string().min(1),
    status: z.enum(["todo", "ready"]).default("ready"),
    priority: workboardCardPrioritySchema.default("normal"),
    labels: z.array(z.string().min(1)).default([]),
    agentId: z.string().min(1).optional(),
    boardId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
}).strict();
export const workboardCardMetadataSchema = z.object({
    sourceSystem: z.literal("clickup"),
    clickupTaskId: z.string().min(1),
    clickupStatus: clickupAutomationStatusSchema.optional(),
    cardType: z.literal("automation").optional(),
    projectKey: z.string().min(1).optional(),
    workType: z.string().min(1).optional(),
    routingKey: z.string().min(1).optional(),
    automationAllowed: z.boolean().optional(),
    approvalRequired: z.boolean().optional(),
    priorityBucket: priorityBucketSchema.optional(),
    repoUrl: z.string().min(1).optional(),
    prUrl: z.string().min(1).optional(),
    artifactUrl: z.string().min(1).optional(),
    docsUrl: z.string().min(1).optional(),
    designUrl: z.string().min(1).optional(),
}).strict();
export const bridgeToWorkboardCardSchema = z.object({
    card: workboardCardCreateSchema,
    metadata: workboardCardMetadataSchema,
}).strict();
export const workboardToClickUpStatusMappingSchema = z.object({
    workboardStatus: openClawWorkboardCardStatusSchema,
    clickupStatus: clickupAutomationStatusSchema,
    automationState: automationStateSchema,
    isTerminal: z.boolean(),
    syncComment: z.boolean(),
}).strict();
export const workboardToClickUpStatusMappings = [
    {
        workboardStatus: "triage",
        clickupStatus: "triage",
        automationState: "candidate",
        isTerminal: false,
        syncComment: false,
    },
    {
        workboardStatus: "backlog",
        clickupStatus: "ready for openclaw",
        automationState: "candidate",
        isTerminal: false,
        syncComment: false,
    },
    {
        workboardStatus: "todo",
        clickupStatus: "ready for openclaw",
        automationState: "candidate",
        isTerminal: false,
        syncComment: false,
    },
    {
        workboardStatus: "scheduled",
        clickupStatus: "ready for openclaw",
        automationState: "candidate",
        isTerminal: false,
        syncComment: false,
    },
    {
        workboardStatus: "ready",
        clickupStatus: "ready for openclaw",
        automationState: "candidate",
        isTerminal: false,
        syncComment: false,
    },
    {
        workboardStatus: "running",
        clickupStatus: "in progress",
        automationState: "running",
        isTerminal: false,
        syncComment: true,
    },
    {
        workboardStatus: "review",
        clickupStatus: "approval",
        automationState: "done",
        isTerminal: true,
        syncComment: true,
    },
    {
        workboardStatus: "blocked",
        clickupStatus: "blocked",
        automationState: "blocked",
        isTerminal: true,
        syncComment: true,
    },
    {
        workboardStatus: "done",
        clickupStatus: "approval",
        automationState: "done",
        isTerminal: true,
        syncComment: true,
    },
];
export function getWorkboardToClickUpStatusMapping(status) {
    const mapping = workboardToClickUpStatusMappings.find((item) => item.workboardStatus === status);
    if (mapping === undefined) {
        throw new Error(`Unsupported Workboard status: ${status}`);
    }
    return mapping;
}
export const claimRecordSchema = z.object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    workboardId: z.string().min(1),
    leaseStartedAt: z.string().min(1),
    leaseExpiresAt: z.string().min(1),
    leaseSeconds: z.number().int().positive(),
    priorityScore: z.number().int().optional(),
    priorityBucket: priorityBucketSchema.optional(),
});
export const idempotencyRecordSchema = z.object({
    key: z.string().min(1),
    taskId: z.string().min(1),
    event: z.string().min(1),
    firstSeenAt: z.string().min(1),
    lastSeenAt: z.string().min(1),
});
export const workerLogLevels = ["debug", "info", "warn", "error"];
export const workerProgressStates = [
    "started",
    "running",
    "completed",
    "blocked",
    "canceled",
    "failed",
];
const workerEventCommonSchema = z.object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    at: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional(),
});
export const workerLogEventSchema = workerEventCommonSchema.extend({
    kind: z.literal("log"),
    level: z.enum(workerLogLevels),
});
export const workerProgressEventSchema = workerEventCommonSchema.extend({
    kind: z.literal("progress"),
    step: z.string().min(1),
    state: z.enum(workerProgressStates),
});
export const workerEventSchema = z.discriminatedUnion("kind", [
    workerLogEventSchema,
    workerProgressEventSchema,
]);
