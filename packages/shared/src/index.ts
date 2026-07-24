import { z } from "zod";

export const automationStates = [
  "manual",
  "candidate",
  "claimed",
  "running",
  "blocked",
  "done",
] as const;

export type AutomationState = (typeof automationStates)[number];

export const automationStateSchema = z.enum(automationStates);

export const priorityBuckets = ["low", "normal", "high", "urgent"] as const;

export type PriorityBucket = (typeof priorityBuckets)[number];

export const priorityBucketSchema = z.enum(priorityBuckets);

export const clickupAutomationStatuses = [
  "new",
  "triage",
  "ready for openclaw",
  "in progress",
  "blocked",
  "human-review",
  "done",
  "closed",
] as const;

export type ClickUpAutomationStatus = (typeof clickupAutomationStatuses)[number];

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
] as const;

export type OpenClawWorkboardCardStatus = (typeof openClawWorkboardCardStatuses)[number];

export const openClawWorkboardCardStatusSchema = z.enum(openClawWorkboardCardStatuses);

export type OpenClawTerminalContext = {
  summary?: string | undefined;
  proof?: unknown;
  artifacts?: Array<string | Record<string, unknown>> | undefined;
  comments?: string[] | undefined;
  blockerContext?: string | undefined;
};

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
] as const;

export type BridgeJobState = (typeof bridgeJobStates)[number];

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
] as const;

export type WorkboardState = (typeof workboardStates)[number];

export const workboardStateSchema = z.enum(workboardStates);

export const clickupWebhookEventSchema = z.object({
  event: z.string().min(1),
  taskId: z.string().min(1),
  listId: z.string().min(1).optional(),
  status: z.string().optional(),
  updatedAt: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

export type ClickUpWebhookEvent = z.infer<typeof clickupWebhookEventSchema>;

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
  tags: z.array(z.string()).default([]),
});

export type ClickUpTask = z.infer<typeof clickupTaskSchema>;

export const workboardCardPrioritySchema = priorityBucketSchema;

export type WorkboardCardPriority = PriorityBucket;

export const workboardCardCreateSchema = z.object({
  title: z.string().min(1),
  notes: z.string().min(1),
  status: z.enum(["todo", "ready"]).default("ready"),
  priority: workboardCardPrioritySchema.default("normal"),
  labels: z.array(z.string().min(1)).default([]),
  agentId: z.string().min(1).optional(),
  boardId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
});

export type WorkboardCardCreate = z.infer<typeof workboardCardCreateSchema>;

export const workboardCardMetadataSchema = z.object({
  sourceSystem: z.literal("clickup"),
  clickupTaskId: z.string().min(1),
  clickupStatus: clickupAutomationStatusSchema.optional(),
  projectKey: z.string().min(1).optional(),
  workType: z.string().min(1).optional(),
  routingKey: z.string().min(1).optional(),
  automationAllowed: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  priorityBucket: priorityBucketSchema.optional(),
  tags: z.array(z.string()).default([]),
  repoUrl: z.string().min(1).optional(),
  prUrl: z.string().min(1).optional(),
  artifactUrl: z.string().min(1).optional(),
  docsUrl: z.string().min(1).optional(),
  designUrl: z.string().min(1).optional(),
});

export type WorkboardCardMetadata = z.infer<typeof workboardCardMetadataSchema>;

export const bridgeToWorkboardCardSchema = z.object({
  card: workboardCardCreateSchema,
  metadata: workboardCardMetadataSchema,
});

export type BridgeToWorkboardCard = z.infer<typeof bridgeToWorkboardCardSchema>;

export const workboardToClickUpStatusMappingSchema = z.object({
  workboardStatus: openClawWorkboardCardStatusSchema,
  clickupStatus: clickupAutomationStatusSchema,
  automationState: automationStateSchema,
  isTerminal: z.boolean(),
  syncComment: z.boolean(),
});

export type WorkboardToClickUpStatusMapping = z.infer<typeof workboardToClickUpStatusMappingSchema>;

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
    clickupStatus: "human-review",
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
    clickupStatus: "human-review",
    automationState: "done",
    isTerminal: true,
    syncComment: true,
  },
] as const satisfies readonly WorkboardToClickUpStatusMapping[];

export function getWorkboardToClickUpStatusMapping(
  status: OpenClawWorkboardCardStatus,
): WorkboardToClickUpStatusMapping {
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

export type ClaimRecord = z.infer<typeof claimRecordSchema>;

export const idempotencyRecordSchema = z.object({
  key: z.string().min(1),
  taskId: z.string().min(1),
  event: z.string().min(1),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
});

export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

export const workerLogLevels = ["debug", "info", "warn", "error"] as const;

export type WorkerLogLevel = (typeof workerLogLevels)[number];

export const workerProgressStates = [
  "started",
  "running",
  "completed",
  "blocked",
  "canceled",
  "failed",
] as const;

export type WorkerProgressState = (typeof workerProgressStates)[number];

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

export type WorkerLogEvent = z.infer<typeof workerLogEventSchema>;

export const workerProgressEventSchema = workerEventCommonSchema.extend({
  kind: z.literal("progress"),
  step: z.string().min(1),
  state: z.enum(workerProgressStates),
});

export type WorkerProgressEvent = z.infer<typeof workerProgressEventSchema>;

export const workerEventSchema = z.discriminatedUnion("kind", [
  workerLogEventSchema,
  workerProgressEventSchema,
]);

export type WorkerEvent = z.infer<typeof workerEventSchema>;
