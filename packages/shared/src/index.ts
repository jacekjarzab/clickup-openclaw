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
  priority: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type ClickUpTask = z.infer<typeof clickupTaskSchema>;

export const claimRecordSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  workboardId: z.string().min(1),
  leaseStartedAt: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
  leaseSeconds: z.number().int().positive(),
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
