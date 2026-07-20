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
    priority: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
});
export const claimRecordSchema = z.object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    workboardId: z.string().min(1),
    leaseExpiresAt: z.string().min(1),
});
