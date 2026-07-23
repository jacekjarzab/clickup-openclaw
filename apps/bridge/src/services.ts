import { createClickUpClient } from "@clickup-openclaw/clickup-client";
import { createLogger } from "@clickup-openclaw/observability";
import {
  bridgeToWorkboardCardSchema,
  clickupAutomationStatusSchema,
  getWorkboardToClickUpStatusMapping,
  claimRecordSchema,
  clickupWebhookEventSchema,
  type BridgeToWorkboardCard,
  type ClickUpTask,
  type OpenClawWorkboardCardStatus,
  type PriorityBucket,
  workerEventSchema,
  workboardStateSchema,
} from "@clickup-openclaw/shared";
import { FileBackedStateStore } from "@clickup-openclaw/state";
import { InMemoryWorkboard } from "@clickup-openclaw/workboard";
import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "./config.js";
import { OpenClawWorkboardAdapter } from "./openclaw-workboard.js";
import { resolveRepoUrl } from "./repo-url.js";

const DEFAULT_LEASE_SECONDS = 15 * 60;

type WorkTypeTemplate = {
  title: string;
  goal: string;
  context: string | undefined;
  acceptanceCriteria: string[] | undefined;
  constraints: string[] | undefined;
  links: string[] | undefined;
  notes: string[] | undefined;
  matchTags: string[] | undefined;
  steps: string[] | undefined;
};

type WorkflowTemplate = WorkTypeTemplate;

function nowIso(): string {
  return new Date().toISOString();
}

function toLeaseExpiry(startedAt: string, leaseSeconds: number): string {
  return new Date(Date.parse(startedAt) + leaseSeconds * 1000).toISOString();
}

function deriveIdempotencyKey(event: {
  event: string;
  taskId: string;
  status?: string | undefined;
  updatedAt?: string | undefined;
}): string {
  return [event.event, event.taskId, event.status ?? "unknown", event.updatedAt ?? "unknown"].join(
    "::",
  );
}

function isEligibleForOpenClaw(status?: string): boolean {
  return status?.trim().toLowerCase() === "ready for openclaw";
}

type ArtifactLinks = {
  repoUrl?: string;
  prUrl?: string;
  artifactUrl?: string;
  docsUrl?: string;
  designUrl?: string;
};

type ProjectRoutingRule = ArtifactLinks & {
  matchLabels: string[] | undefined;
  matchStatuses: string[] | undefined;
  matchListIds: string[] | undefined;
  autoPickLabels: string[] | undefined;
  autoPickStatuses: string[] | undefined;
  approvalLabels: string[] | undefined;
  approvalStatuses: string[] | undefined;
  approvalRequired: boolean | undefined;
  workType: string | undefined;
  priorityBucket: PriorityBucket | undefined;
  priorityBoost: number | undefined;
};

type TriageRule = {
  matchLabels: string[] | undefined;
  matchStatuses: string[] | undefined;
  matchListIds: string[] | undefined;
  reason: string | undefined;
  holdForHuman: boolean | undefined;
};

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function parsePriorityBucket(value: unknown): PriorityBucket | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeKey(value);
  return normalized === "low" || normalized === "normal" || normalized === "high" || normalized === "urgent"
    ? normalized
    : undefined;
}

function parseWorkTypeTemplates(input: string | undefined): Record<string, WorkTypeTemplate> {
  if (input === undefined || input.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(input) as Record<string, unknown>;
  const templates: Record<string, WorkTypeTemplate> = {};

  for (const [workType, rawTemplate] of Object.entries(parsed)) {
    if (rawTemplate === null || typeof rawTemplate !== "object" || Array.isArray(rawTemplate)) {
      continue;
    }

    const template = rawTemplate as Record<string, unknown>;
    const title = readString(template.title);
    const goal = readString(template.goal);
    if (title === undefined || goal === undefined) {
      continue;
    }

    templates[normalizeKey(workType)] = {
      title,
      goal,
      context: readString(template.context),
      acceptanceCriteria: readStringArray(template.acceptanceCriteria),
      constraints: readStringArray(template.constraints),
      links: readStringArray(template.links),
      notes: readStringArray(template.notes),
      matchTags: readStringArray(template.matchTags),
      steps: readStringArray(template.steps),
    };
  }

  return templates;
}

function parseWorkflowTemplates(input: string | undefined): Record<string, WorkflowTemplate> {
  return parseWorkTypeTemplates(input);
}

function parseTriageRules(input: string | undefined): Record<string, TriageRule> {
  if (input === undefined || input.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(input) as Record<string, unknown>;
  const rules: Record<string, TriageRule> = {};

  for (const [projectKey, rawRule] of Object.entries(parsed)) {
    if (rawRule === null || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      continue;
    }

    const rule = rawRule as Record<string, unknown>;
    rules[normalizeKey(projectKey)] = {
      matchLabels: readStringArray(rule.matchLabels),
      matchStatuses: readStringArray(rule.matchStatuses),
      matchListIds: readStringArray(rule.matchListIds),
      reason: readString(rule.reason),
      holdForHuman: typeof rule.holdForHuman === "boolean" ? rule.holdForHuman : undefined,
    };
  }

  return rules;
}

function priorityBucketScore(bucket: PriorityBucket | undefined): number {
  switch (bucket) {
    case "urgent":
      return 400;
    case "high":
      return 300;
    case "normal":
      return 200;
    case "low":
      return 100;
    default:
      return 0;
  }
}

function normalizeStatus(status: string | undefined): string {
  return normalizeKey(status ?? "");
}

function normalizeTags(tags: string[]): string[] {
  return tags.map(normalizeKey);
}

function extractPayloadTags(payload: Record<string, unknown> | undefined): string[] {
  if (payload === undefined) {
    return [];
  }

  const rawTags = payload.labels ?? payload.tags ?? payload.categories;
  return readStringArray(rawTags);
}

function extractPayloadProjectKey(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return readString(payload.projectKey) ?? readString(payload.project_key) ?? readString(payload.clientKey);
}

function extractPayloadPriorityBucket(payload: Record<string, unknown> | undefined): PriorityBucket | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return parsePriorityBucket(payload.priorityBucket ?? payload.priority_bucket);
}

function extractPayloadApprovalRequired(payload: Record<string, unknown> | undefined): boolean | undefined {
  if (payload === undefined) {
    return undefined;
  }

  const candidate = payload.approvalRequired ?? payload.approval_required;
  if (typeof candidate === "boolean") {
    return candidate;
  }

  if (typeof candidate === "string") {
    const normalized = normalizeKey(candidate);
    if (normalized === "true" || normalized === "yes" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "no" || normalized === "0") {
      return false;
    }
  }

  return undefined;
}

function extractPayloadAutomationAllowed(payload: Record<string, unknown> | undefined): boolean | undefined {
  if (payload === undefined) {
    return undefined;
  }

  const candidate = payload.automationAllowed ?? payload.automation_allowed;
  if (typeof candidate === "boolean") {
    return candidate;
  }

  if (typeof candidate === "string") {
    const normalized = normalizeKey(candidate);
    if (normalized === "true" || normalized === "yes" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "no" || normalized === "0") {
      return false;
    }
  }

  return undefined;
}

function scorePriorityBucket(bucket: PriorityBucket | undefined, boost = 0): number {
  return priorityBucketScore(bucket) + boost;
}

function renderTaskTemplate(workType: string, template: WorkTypeTemplate): string {
  const lines = [`Task template for ${workType}:`, "", `- Title: ${template.title}`, `- Goal: ${template.goal}`];

  if (template.context !== undefined) {
    lines.push(`- Context: ${template.context}`);
  }

  if (template.acceptanceCriteria !== undefined && template.acceptanceCriteria.length > 0) {
    lines.push("- Acceptance criteria:");
    for (const item of template.acceptanceCriteria) {
      lines.push(`  - ${item}`);
    }
  }

  if (template.constraints !== undefined && template.constraints.length > 0) {
    lines.push("- Constraints:");
    for (const item of template.constraints) {
      lines.push(`  - ${item}`);
    }
  }

  if (template.links !== undefined && template.links.length > 0) {
    lines.push("- Links:");
    for (const item of template.links) {
      lines.push(`  - ${item}`);
    }
  }

  if (template.notes !== undefined && template.notes.length > 0) {
    lines.push("- Notes:");
    for (const item of template.notes) {
      lines.push(`  - ${item}`);
    }
  }

  return lines.join("\n");
}

function renderWorkflowTemplate(projectKey: string, template: WorkflowTemplate): string {
  const lines = [
    `Workflow template for ${projectKey}:`,
    "",
    `- Title: ${template.title}`,
    `- Goal: ${template.goal}`,
  ];

  if (template.context !== undefined) {
    lines.push(`- Context: ${template.context}`);
  }

  if (template.acceptanceCriteria !== undefined && template.acceptanceCriteria.length > 0) {
    lines.push("- Acceptance criteria:");
    for (const item of template.acceptanceCriteria) {
      lines.push(`  - ${item}`);
    }
  }

  if (template.constraints !== undefined && template.constraints.length > 0) {
    lines.push("- Constraints:");
    for (const item of template.constraints) {
      lines.push(`  - ${item}`);
    }
  }

  if (template.links !== undefined && template.links.length > 0) {
    lines.push("- Links:");
    for (const item of template.links) {
      lines.push(`  - ${item}`);
    }
  }

  if (template.notes !== undefined && template.notes.length > 0) {
    lines.push("- Notes:");
    for (const item of template.notes) {
      lines.push(`  - ${item}`);
    }
  }

  return lines.join("\n");
}

function renderDecompositionPlan(label: string, steps: string[]): string {
  const lines = [`Decomposition plan for ${label}:`, ""];

  for (const [index, step] of steps.entries()) {
    lines.push(`- Step ${index + 1}: ${step}`);
  }

  return lines.join("\n");
}

function resolveTriageRule(
  input: {
    projectKey?: string | undefined;
    listId?: string | undefined;
    status?: string | undefined;
    tags: string[];
  },
  triageRules: Record<string, TriageRule>,
): { projectKey: string | undefined; rule: TriageRule | undefined } {
  const normalizedProjectKey = input.projectKey === undefined ? undefined : normalizeKey(input.projectKey);
  const normalizedListId = input.listId === undefined ? undefined : normalizeKey(input.listId);
  const normalizedStatus = normalizeStatus(input.status);
  const normalizedTags = normalizeTags(input.tags);
  const entries = Object.entries(triageRules);

  if (normalizedProjectKey !== undefined) {
    const directRule = entries.find(([key]) => normalizeKey(key) === normalizedProjectKey);
    if (directRule !== undefined) {
      return { projectKey: directRule[0], rule: directRule[1] };
    }
  }

  const matched = entries.find(([key, rule]) => {
    const normalizedKey = normalizeKey(key);
    const matchLabels = rule.matchLabels?.map(normalizeKey) ?? [];
    const matchStatuses = rule.matchStatuses?.map(normalizeKey) ?? [];
    const matchListIds = rule.matchListIds?.map(normalizeKey) ?? [];

    return (
      normalizedProjectKey === normalizedKey ||
      (normalizedListId !== undefined && matchListIds.includes(normalizedListId)) ||
      (normalizedStatus.length > 0 && matchStatuses.includes(normalizedStatus)) ||
      normalizedTags.some((tag) => matchLabels.includes(tag))
    );
  });

  if (matched !== undefined) {
    return { projectKey: matched[0], rule: matched[1] };
  }

  return { projectKey: input.projectKey, rule: undefined };
}

function findTemplateByTagMatch(
  tags: string[],
  templates: Record<string, WorkTypeTemplate>,
): string | undefined {
  const normalizedTags = tags.map(normalizeKey);

  for (const [workType, template] of Object.entries(templates)) {
    const candidates = [workType, ...(template.matchTags ?? [])].map(normalizeKey);
    if (candidates.some((candidate) => normalizedTags.includes(candidate))) {
      return workType;
    }
  }

  return undefined;
}

function extractPayloadWorkType(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return (
    readString(payload.workType) ??
    readString(payload.template) ??
    readString(payload.type) ??
    readString(payload.work_type)
  );
}

function buildClaimComment(
  workflowTemplateText?: string,
  decompositionText?: string,
  triageText?: string,
  templateText?: string,
): string {
  const lines = ["Claimed by OpenClaw, starting work."];

  if (workflowTemplateText !== undefined) {
    lines.push("", workflowTemplateText);
  }

  if (decompositionText !== undefined) {
    lines.push("", decompositionText);
  }

  if (triageText !== undefined) {
    lines.push("", triageText);
  }

  if (templateText !== undefined) {
    lines.push("", templateText);
  }

  return lines.join("\n");
}

function parseProjectRoutingRules(input: string | undefined): Record<string, ProjectRoutingRule> {
  if (input === undefined) {
    return {};
  }

  const parsed = JSON.parse(input) as Record<string, unknown>;
  const rules: Record<string, ProjectRoutingRule> = {};

  for (const [projectKey, rawRule] of Object.entries(parsed)) {
    if (rawRule === null || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      continue;
    }

    const rule = rawRule as Record<string, unknown>;
    const nextRule: ProjectRoutingRule = {
      matchLabels: readStringArray(rule.matchLabels),
      matchStatuses: readStringArray(rule.matchStatuses),
      matchListIds: readStringArray(rule.matchListIds),
      autoPickLabels: readStringArray(rule.autoPickLabels),
      autoPickStatuses: readStringArray(rule.autoPickStatuses),
      approvalLabels: readStringArray(rule.approvalLabels),
      approvalStatuses: readStringArray(rule.approvalStatuses),
      approvalRequired: typeof rule.approvalRequired === "boolean" ? rule.approvalRequired : undefined,
      workType: readString(rule.workType),
      priorityBucket: parsePriorityBucket(rule.priorityBucket),
      priorityBoost:
        typeof rule.priorityBoost === "number" && Number.isFinite(rule.priorityBoost)
          ? rule.priorityBoost
          : undefined,
    };

    if (typeof rule.repoUrl === "string" && rule.repoUrl.trim().length > 0) {
      nextRule.repoUrl = rule.repoUrl;
    }
    if (typeof rule.prUrl === "string" && rule.prUrl.trim().length > 0) {
      nextRule.prUrl = rule.prUrl;
    }
    if (typeof rule.artifactUrl === "string" && rule.artifactUrl.trim().length > 0) {
      nextRule.artifactUrl = rule.artifactUrl;
    }
    if (typeof rule.docsUrl === "string" && rule.docsUrl.trim().length > 0) {
      nextRule.docsUrl = rule.docsUrl;
    }
    if (typeof rule.designUrl === "string" && rule.designUrl.trim().length > 0) {
      nextRule.designUrl = rule.designUrl;
    }

    rules[projectKey] = nextRule;
  }

  return rules;
}

function resolveRoutingRule(
  input: {
    projectKey?: string | undefined;
    listId?: string | undefined;
    status?: string | undefined;
    tags: string[];
  },
  routingRules: Record<string, ProjectRoutingRule>,
): { projectKey: string | undefined; rule: ProjectRoutingRule | undefined } {
  const normalizedProjectKey = input.projectKey === undefined ? undefined : normalizeKey(input.projectKey);
  const normalizedListId = input.listId === undefined ? undefined : normalizeKey(input.listId);
  const normalizedStatus = normalizeStatus(input.status);
  const normalizedTags = normalizeTags(input.tags);

  const entries = Object.entries(routingRules);

  if (normalizedProjectKey !== undefined) {
    const directRule = entries.find(([key]) => normalizeKey(key) === normalizedProjectKey);
    if (directRule !== undefined) {
      return { projectKey: directRule[0], rule: directRule[1] };
    }
  }

  const matched = entries.find(([key, rule]) => {
    const normalizedKey = normalizeKey(key);
    const matchLabels = rule.matchLabels?.map(normalizeKey) ?? [];
    const matchStatuses = rule.matchStatuses?.map(normalizeKey) ?? [];
    const matchListIds = rule.matchListIds?.map(normalizeKey) ?? [];

    return (
      normalizedProjectKey === normalizedKey ||
      (normalizedListId !== undefined && matchListIds.includes(normalizedListId)) ||
      (normalizedStatus.length > 0 && matchStatuses.includes(normalizedStatus)) ||
      normalizedTags.some((tag) => matchLabels.includes(tag))
    );
  });

  if (matched !== undefined) {
    return { projectKey: matched[0], rule: matched[1] };
  }

  return { projectKey: input.projectKey, rule: undefined };
}

function shouldAutoPickTask(input: {
  status?: string | undefined;
  tags: string[];
  automationAllowed?: boolean | undefined;
  rule?: ProjectRoutingRule | undefined;
  approvalRequired?: boolean | undefined;
}): boolean {
  if (input.automationAllowed === true) {
    return true;
  }

  const normalizedStatus = normalizeStatus(input.status);
  const normalizedTags = normalizeTags(input.tags);
  const rule = input.rule;

  const statusEligible =
    normalizedStatus === "ready for openclaw" ||
    (rule?.autoPickStatuses?.map(normalizeKey) ?? []).includes(normalizedStatus);
  const labelEligible =
    normalizedTags.some((tag) => (rule?.autoPickLabels?.map(normalizeKey) ?? []).includes(tag)) ||
    normalizedTags.includes("automation");
  const approvalRequired =
    input.approvalRequired === true ||
    rule?.approvalRequired === true ||
    normalizedTags.includes("needs-human") ||
    normalizedTags.includes("needs-review") ||
    normalizedStatus === "triage" ||
    normalizedStatus === "needs-human" ||
    normalizedStatus === "needs-review" ||
    (rule?.approvalStatuses?.map(normalizeKey) ?? []).includes(normalizedStatus) ||
    normalizedTags.some((tag) => (rule?.approvalLabels?.map(normalizeKey) ?? []).includes(tag));

  return (statusEligible || labelEligible) && !approvalRequired;
}

function determinePriorityBucket(input: {
  clickupPriority?: string | undefined;
  taskBucket?: PriorityBucket | undefined;
  routingRule?: ProjectRoutingRule | undefined;
  tags: string[];
}): PriorityBucket | undefined {
  const normalizedTags = normalizeTags(input.tags);

  return (
    input.taskBucket ??
    input.routingRule?.priorityBucket ??
    parsePriorityBucket(input.clickupPriority) ??
    (normalizedTags.includes("urgent")
      ? "urgent"
      : normalizedTags.includes("high")
        ? "high"
        : normalizedTags.includes("low")
          ? "low"
          : undefined)
  );
}

function buildGitDetailLines(
  task: Pick<ClickUpTask, "branchName" | "commitSha" | "commitUrl" | "prNumber">,
): string[] {
  return [
    task.branchName === undefined ? undefined : `- Branch: ${task.branchName}`,
    task.commitSha === undefined ? undefined : `- Commit: ${task.commitSha}`,
    task.commitUrl === undefined ? undefined : `- Commit URL: ${task.commitUrl}`,
    task.prNumber === undefined ? undefined : `- PR number: #${task.prNumber}`,
  ].filter((line): line is string => line !== undefined);
}

function buildArtifactComment(
  summary: string,
  links: ArtifactLinks,
  task?: Pick<ClickUpTask, "branchName" | "commitSha" | "commitUrl" | "prNumber">,
): string {
  const lines = [summary];
  const linkLines = [
    links.repoUrl === undefined ? undefined : `- Repo: ${links.repoUrl}`,
    links.prUrl === undefined ? undefined : `- PR: ${links.prUrl}`,
    links.artifactUrl === undefined ? undefined : `- Preview or deployment: ${links.artifactUrl}`,
    links.docsUrl === undefined ? undefined : `- Docs: ${links.docsUrl}`,
    links.designUrl === undefined ? undefined : `- Design: ${links.designUrl}`,
  ].filter((line): line is string => line !== undefined);

  if (linkLines.length > 0) {
    lines.push("", "Useful links:", ...linkLines);
  }

  const gitLines = task === undefined ? [] : buildGitDetailLines(task);
  if (gitLines.length > 0) {
    lines.push("", "Git details:", ...gitLines);
  }

  return lines.join("\n");
}

function buildTaskWriteBackFields(
  task: Partial<
    Pick<
    ClickUpTask,
    | "routingKey"
    | "priorityBucket"
    | "automationAllowed"
    | "approvalRequired"
    | "autoPicked"
    | "triageReason"
    | "branchName"
    | "commitSha"
    | "commitUrl"
    | "prNumber"
    >
  > | undefined,
  now: string,
  links: ArtifactLinks,
  extraFields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    last_sync_at: now,
    ...extraFields,
    ...(task?.routingKey === undefined ? {} : { routing_key: task.routingKey }),
    ...(task?.priorityBucket === undefined ? {} : { priority_bucket: task.priorityBucket }),
    ...(task?.automationAllowed === undefined ? {} : { automation_allowed: task.automationAllowed }),
    ...(task?.approvalRequired === undefined ? {} : { approval_required: task.approvalRequired }),
    ...(task?.autoPicked === undefined ? {} : { auto_picked: task.autoPicked }),
    ...(task?.triageReason === undefined ? {} : { triage_reason: task.triageReason }),
    ...(task?.branchName === undefined ? {} : { branch_name: task.branchName }),
    ...(task?.commitSha === undefined ? {} : { commit_sha: task.commitSha }),
    ...(task?.commitUrl === undefined ? {} : { commit_url: task.commitUrl }),
    ...(task?.prNumber === undefined ? {} : { pr_number: task.prNumber }),
    ...(links.repoUrl === undefined ? {} : { repo_url: links.repoUrl }),
    ...(links.prUrl === undefined ? {} : { pr_url: links.prUrl }),
    ...(links.artifactUrl === undefined ? {} : { artifact_url: links.artifactUrl }),
    ...(links.docsUrl === undefined ? {} : { docs_url: links.docsUrl }),
    ...(links.designUrl === undefined ? {} : { design_url: links.designUrl }),
  };
}

function buildHeartbeatComment(taskId: string, leaseExpiresAt: string): string {
  return [
    `OpenClaw detected a missed heartbeat for task ${taskId}.`,
    `The lease expired at ${leaseExpiresAt}, so the task was requeued for another attempt.`,
  ].join("\n");
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}

function buildOpenClawStatusComment(
  status: OpenClawWorkboardCardStatus,
  raw: Record<string, unknown>,
): string | undefined {
  const summary =
    readNestedString(raw, ["summary"]) ??
    readNestedString(raw, ["execution", "summary"]) ??
    readNestedString(raw, ["proof", "note"]) ??
    readNestedString(raw, ["notes"]);

  switch (status) {
    case "running":
      return "OpenClaw started work on this task.";
    case "review":
    case "done":
      return summary ?? "OpenClaw finished this task and returned it for human review.";
    case "blocked":
      return summary ?? "OpenClaw blocked this task and needs human input before continuing.";
    default:
      return undefined;
  }
}

function resolveArtifactLinks(
  projectKey: string | undefined,
  defaults: ArtifactLinks,
  routingRules: Record<string, ProjectRoutingRule>,
): ArtifactLinks {
  const routingRule = projectKey === undefined ? undefined : routingRules[projectKey];
  const links: ArtifactLinks = {};

  if (routingRule?.repoUrl !== undefined) {
    links.repoUrl = routingRule.repoUrl;
  } else if (defaults.repoUrl !== undefined) {
    links.repoUrl = defaults.repoUrl;
  }

  if (routingRule?.prUrl !== undefined) {
    links.prUrl = routingRule.prUrl;
  } else if (defaults.prUrl !== undefined) {
    links.prUrl = defaults.prUrl;
  }

  if (routingRule?.artifactUrl !== undefined) {
    links.artifactUrl = routingRule.artifactUrl;
  } else if (defaults.artifactUrl !== undefined) {
    links.artifactUrl = defaults.artifactUrl;
  }

  if (routingRule?.docsUrl !== undefined) {
    links.docsUrl = routingRule.docsUrl;
  } else if (defaults.docsUrl !== undefined) {
    links.docsUrl = defaults.docsUrl;
  }

  if (routingRule?.designUrl !== undefined) {
    links.designUrl = routingRule.designUrl;
  } else if (defaults.designUrl !== undefined) {
    links.designUrl = defaults.designUrl;
  }

  return links;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createBridgeServices(config: BridgeConfig) {
  const logger = createLogger("bridge");
  const state = new FileBackedStateStore(config.STATE_FILE_PATH ?? ".data/bridge-state.json");
  const workboard = new InMemoryWorkboard();
  let paused = false;
  const defaultProjectKey = config.DEFAULT_PROJECT_KEY;
  const repoUrl = resolveRepoUrl(config);
  const prUrl = config.PR_URL ?? config.CLICKUP_PR_URL;
  const artifactUrl = config.ARTIFACT_URL ?? config.CLICKUP_ARTIFACT_URL;
  const docsUrl = config.DOCS_URL ?? config.CLICKUP_DOCS_URL;
  const designUrl = config.DESIGN_URL ?? config.CLICKUP_DESIGN_URL;
  const heartbeatMonitorIntervalMs = Number(config.HEARTBEAT_MONITOR_INTERVAL_MS ?? "60000");
  const openClawWatchIntervalMs = Number(config.OPENCLAW_WATCH_INTERVAL_MS ?? "15000");
  const queueStallAlertMs = toNumber(config.QUEUE_STALL_ALERT_MS, 10 * 60 * 1000);
  const blockedEscalationMs = toNumber(config.BLOCKED_ESCALATION_MS, 4 * 60 * 60 * 1000);
  const projectRoutingRules = parseProjectRoutingRules(config.PROJECT_ROUTING_JSON);
  const workTypeTemplates = parseWorkTypeTemplates(config.WORK_TYPE_TEMPLATES_JSON);
  const workflowTemplates = parseWorkflowTemplates(config.WORKFLOW_TEMPLATES_JSON);
  const triageRules = parseTriageRules(config.TRIAGE_RULES_JSON);
  const defaultWorkType = readString(config.DEFAULT_WORK_TYPE);
  const artifactLinks: ArtifactLinks = {};
  if (repoUrl !== undefined) {
    artifactLinks.repoUrl = repoUrl;
  }
  if (prUrl !== undefined) {
    artifactLinks.prUrl = prUrl;
  }
  if (artifactUrl !== undefined) {
    artifactLinks.artifactUrl = artifactUrl;
  }
  if (docsUrl !== undefined) {
    artifactLinks.docsUrl = docsUrl;
  }
  if (designUrl !== undefined) {
    artifactLinks.designUrl = designUrl;
  }
  const clickup =
    config.CLICKUP_API_TOKEN === undefined
      ? undefined
      : createClickUpClient({
          token: config.CLICKUP_API_TOKEN,
          ...(config.CLICKUP_BASE_URL === undefined ? {} : { baseUrl: config.CLICKUP_BASE_URL }),
        });
  const openClawWorkboard = new OpenClawWorkboardAdapter({
    ...(config.OPENCLAW_BIN === undefined ? {} : { binary: config.OPENCLAW_BIN }),
    ...(config.OPENCLAW_WORKBOARD_BOARD_ID === undefined
      ? {}
      : { boardId: config.OPENCLAW_WORKBOARD_BOARD_ID }),
    cwd: process.cwd(),
    timeoutMs: toNumber(config.OPENCLAW_WORKBOARD_CLI_TIMEOUT_MS, 30_000),
  });

  function mapOutcomeToWorkboardStatus(outcome: "succeeded" | "failed" | "blocked"): OpenClawWorkboardCardStatus {
    if (outcome === "succeeded") {
      return "done";
    }

    return outcome === "blocked" ? "blocked" : "blocked";
  }

  function renderTaskSnapshotForWorkboard(job: ReturnType<typeof state.getJob> extends infer T ? T : never): string {
    if (job === undefined) {
      return "";
    }

    const lines = [
      `ClickUp task: ${job.task.name}`,
      `Task ID: ${job.task.id}`,
      `Status: ${job.task.status}`,
    ];

    if (job.task.projectKey !== undefined) {
      lines.push(`Project key: ${job.task.projectKey}`);
    }
    if (job.task.workType !== undefined) {
      lines.push(`Work type: ${job.task.workType}`);
    }
    if (job.task.priorityBucket !== undefined) {
      lines.push(`Priority bucket: ${job.task.priorityBucket}`);
    }
    if (job.task.description !== undefined && job.task.description.trim().length > 0) {
      lines.push("", "Description:", job.task.description.trim());
    }
    if (job.triageReason !== undefined) {
      lines.push("", `Triage note: ${job.triageReason}`);
    }
    if (job.workflowTemplate !== undefined) {
      lines.push("", job.workflowTemplate);
    }
    if (job.decompositionPlan !== undefined) {
      lines.push("", job.decompositionPlan);
    }
    if (job.template !== undefined) {
      lines.push("", job.template);
    }

    const links = [
      job.task.repoUrl === undefined ? undefined : `- Repo: ${job.task.repoUrl}`,
      job.task.prUrl === undefined ? undefined : `- PR: ${job.task.prUrl}`,
      job.task.artifactUrl === undefined ? undefined : `- Artifact: ${job.task.artifactUrl}`,
      job.task.docsUrl === undefined ? undefined : `- Docs: ${job.task.docsUrl}`,
      job.task.designUrl === undefined ? undefined : `- Design: ${job.task.designUrl}`,
    ].filter((line): line is string => line !== undefined);

    if (links.length > 0) {
      lines.push("", "Links:", ...links);
    }

    return lines.join("\n");
  }

  function buildWorkboardLabels(task: ClickUpTask): string[] {
    return [
      "clickup",
      "automation",
      task.projectKey === undefined ? undefined : `project:${normalizeKey(task.projectKey)}`,
      task.workType === undefined ? undefined : `work-type:${normalizeKey(task.workType)}`,
      task.routingKey === undefined ? undefined : `route:${normalizeKey(task.routingKey)}`,
      ...normalizeTags(task.tags).map((tag) => `tag:${tag}`),
    ].filter((label): label is string => label !== undefined);
  }

  function buildBridgeToWorkboardCard(taskId: string): BridgeToWorkboardCard {
    const job = state.getJob(taskId);
    if (job === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const payload = bridgeToWorkboardCardSchema.parse({
      card: {
        title: job.task.name,
        notes: renderTaskSnapshotForWorkboard(job),
        status: "ready",
        priority: job.task.priorityBucket ?? "normal",
        labels: buildWorkboardLabels(job.task),
        boardId: config.OPENCLAW_WORKBOARD_BOARD_ID,
        idempotencyKey: `clickup-task:${job.task.id}`,
      },
      metadata: {
        sourceSystem: "clickup",
        clickupTaskId: job.task.id,
        ...(clickupAutomationStatusSchema.safeParse(normalizeStatus(job.task.status)).success
          ? {
              clickupStatus: clickupAutomationStatusSchema.parse(normalizeStatus(job.task.status)),
            }
          : {}),
        projectKey: job.task.projectKey,
        workType: job.task.workType,
        routingKey: job.task.routingKey,
        automationAllowed: job.task.automationAllowed,
        approvalRequired: job.task.approvalRequired,
        priorityBucket: job.task.priorityBucket,
        tags: job.task.tags,
        repoUrl: job.task.repoUrl,
        prUrl: job.task.prUrl,
        artifactUrl: job.task.artifactUrl,
        docsUrl: job.task.docsUrl,
        designUrl: job.task.designUrl,
      },
    });

    return payload;
  }

  async function handoffJobToOpenClaw(taskId: string) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    if (current.workboardCardId !== undefined) {
      return {
        taskId,
        workboardCardId: current.workboardCardId,
        status: current.openClawCardStatus,
        duplicate: true,
      };
    }

    const payload = buildBridgeToWorkboardCard(taskId);
    const created = await openClawWorkboard.createCard(payload);
    const handedOffAt = nowIso();

    state.mergeJob(taskId, {
      bridgeState: "card_created",
      handoffPayload: payload,
      workboardCardId: created.id,
      openClawCardStatus: created.status ?? payload.card.status,
      handedOffAt,
      updatedAt: handedOffAt,
    });

    logger.info("job handed off to OpenClaw workboard", {
      taskId,
      workboardCardId: created.id,
      status: created.status ?? payload.card.status,
    });

    return {
      taskId,
      workboardCardId: created.id,
      status: created.status ?? payload.card.status,
      duplicate: false,
    };
  }

  async function dispatchOpenClawWorkboard(input?: { maxStarts?: number | undefined }) {
    const dispatchedAt = nowIso();
    const result = await openClawWorkboard.dispatch({
      ...(config.OPENCLAW_WORKBOARD_BOARD_ID === undefined
        ? {}
        : { boardId: config.OPENCLAW_WORKBOARD_BOARD_ID }),
      ...(input?.maxStarts === undefined ? {} : { maxStarts: input.maxStarts }),
    });

    for (const job of state.listJobs().filter((entry) => entry.workboardCardId !== undefined)) {
      state.mergeJob(job.task.id, {
        bridgeState: "dispatched",
        dispatchedAt,
        updatedAt: dispatchedAt,
      });
    }

    logger.info("openclaw workboard dispatch requested", {
      boardId: config.OPENCLAW_WORKBOARD_BOARD_ID,
      result,
    });

    return {
      dispatchedAt,
      result,
    };
  }

  async function refreshOpenClawCard(taskId: string) {
    const current = state.getJob(taskId);
    if (current?.workboardCardId === undefined) {
      throw new Error(`Task ${taskId} has not been handed off to OpenClaw`);
    }

    const card = await openClawWorkboard.showCard(current.workboardCardId);
    const updatedAt = nowIso();
    const mapping = card.status === undefined ? undefined : getWorkboardToClickUpStatusMapping(card.status);

    state.mergeJob(taskId, {
      bridgeState:
        mapping?.isTerminal === true
          ? "completed"
          : card.status === "running"
            ? "running"
            : current.bridgeState,
      openClawCardStatus: card.status,
      updatedAt,
    });

    return {
      taskId,
      workboardCardId: current.workboardCardId,
      status: card.status,
      raw: card.raw,
    };
  }

  async function syncOpenClawCardToClickUp(taskId: string) {
    const current = state.getJob(taskId);
    if (current === undefined || current.workboardCardId === undefined) {
      throw new Error(`Task ${taskId} has not been handed off to OpenClaw`);
    }

    const previousStatus = current.openClawCardStatus;
    const refreshed = await refreshOpenClawCard(taskId);
    const next = state.getJob(taskId);
    if (refreshed.status === undefined || next === undefined) {
      return {
        taskId,
        workboardCardId: current.workboardCardId,
        synced: false,
        reason: "card status unavailable",
      };
    }

    const mapping = getWorkboardToClickUpStatusMapping(refreshed.status);
    const links = resolveArtifactLinks(next.task.projectKey ?? next.task.routingKey, artifactLinks, projectRoutingRules);
    const updatedAt = nowIso();
    const runId =
      next.claim?.runId ??
      current.claim?.runId ??
      readNestedString(refreshed.raw, ["execution", "runId"]) ??
      "";
    const comment = previousStatus === refreshed.status ? undefined : buildOpenClawStatusComment(refreshed.status, refreshed.raw);

    if (clickup !== undefined) {
      if (comment !== undefined && mapping.syncComment) {
        await clickup.postTaskComment(taskId, comment);
      }

      await clickup.updateTaskMetadata(taskId, {
        status: mapping.clickupStatus,
        customFields: buildTaskWriteBackFields(next.task, updatedAt, links, {
          automation_state: mapping.automationState,
          last_error: refreshed.status === "blocked" ? comment ?? "Blocked in OpenClaw" : "",
          run_id: runId,
          workboard_id: current.workboardCardId,
        }),
      });
    }

    state.mergeJob(taskId, {
      bridgeState: mapping.isTerminal ? "synced_back" : next.bridgeState,
      openClawCardStatus: refreshed.status,
      updatedAt,
      ...(mapping.isTerminal
        ? {
            terminalAt: updatedAt,
            outcome:
              refreshed.status === "blocked"
                ? "blocked"
                : refreshed.status === "review" || refreshed.status === "done"
                  ? "succeeded"
                  : next.outcome,
          }
        : {}),
    });

    logger.info("synced OpenClaw card status back to ClickUp", {
      taskId,
      workboardCardId: current.workboardCardId,
      previousStatus: previousStatus ?? null,
      status: refreshed.status,
      clickupStatus: mapping.clickupStatus,
    });

    return {
      taskId,
      workboardCardId: current.workboardCardId,
      status: refreshed.status,
      clickupStatus: mapping.clickupStatus,
      synced: true,
    };
  }

  async function watchOpenClawCards() {
    const jobs = state.listJobs().filter(
      (job) =>
        job.workboardCardId !== undefined &&
        job.bridgeState !== "synced_back" &&
        job.openClawCardStatus !== "review" &&
        job.openClawCardStatus !== "done" &&
        job.openClawCardStatus !== "blocked",
    );
    const results: Array<Record<string, unknown>> = [];

    for (const job of jobs) {
      try {
        results.push(await syncOpenClawCardToClickUp(job.task.id));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn("failed to sync OpenClaw card to ClickUp", {
          taskId: job.task.id,
          workboardCardId: job.workboardCardId,
          error: reason,
        });
        results.push({
          taskId: job.task.id,
          workboardCardId: job.workboardCardId,
          synced: false,
          error: reason,
        });
      }
    }

    return {
      watched: jobs.length,
      results,
    };
  }

  async function writeClaimSideEffects(taskId: string, runId: string, claimWorkboardId: string, now: string) {
    if (clickup === undefined) {
      return;
    }

    const job = state.getJob(taskId);
    const projectKey = job?.task.projectKey ?? job?.task.routingKey;
    const links = resolveArtifactLinks(projectKey, artifactLinks, projectRoutingRules);

    await clickup.postTaskComment(
      taskId,
      buildClaimComment(job?.workflowTemplate, job?.decompositionPlan, job?.triageReason, job?.template),
    );
    await clickup.updateTaskMetadata(taskId, {
      status: "in progress",
      customFields: buildTaskWriteBackFields(job?.task ?? {}, now, links, {
        run_id: runId,
        workboard_id: claimWorkboardId,
        automation_state: "claimed",
      }),
    });
  }

  async function ingestTaskSnapshot(input: {
    task: ClickUpTask;
    sourceEvent: string;
    listId?: string | undefined;
    status?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  }) {
    const receivedAt = nowIso();
    const idempotencyKey = deriveIdempotencyKey({
      event: input.sourceEvent,
      taskId: input.task.id,
      status: input.status ?? input.task.status,
      updatedAt: input.task.updatedAt,
    });

    if (state.hasIdempotencyKey(idempotencyKey)) {
      logger.info("task snapshot duplicate ignored", { event: input.sourceEvent, taskId: input.task.id });
      return { accepted: true, duplicate: true };
    }

    state.recordIdempotency({
      key: idempotencyKey,
      taskId: input.task.id,
      event: input.sourceEvent,
      firstSeenAt: receivedAt,
      lastSeenAt: receivedAt,
    });

    const payloadRecord = input.payload;
    const payloadWorkType = extractPayloadWorkType(payloadRecord);
    const payloadTags = extractPayloadTags(payloadRecord);
    const payloadProjectKey = extractPayloadProjectKey(payloadRecord);
    const payloadPriorityBucket = extractPayloadPriorityBucket(payloadRecord);
    const payloadAutomationAllowed = extractPayloadAutomationAllowed(payloadRecord);
    const payloadApprovalRequired = extractPayloadApprovalRequired(payloadRecord);
    const mergedTags = [...new Set([...(input.task.tags ?? []), ...payloadTags])];
    const taggedWorkType = mergedTags.length > 0 ? findTemplateByTagMatch(mergedTags, workTypeTemplates) : undefined;
    const currentStatus = input.task.status ?? input.status ?? "unknown";
    const routing = resolveRoutingRule(
      {
        projectKey: input.task.projectKey ?? payloadProjectKey ?? defaultProjectKey,
        listId: input.task.listId ?? input.listId,
        status: currentStatus,
        tags: mergedTags,
      },
      projectRoutingRules,
    );
    const triage = resolveTriageRule(
      {
        projectKey: input.task.projectKey ?? payloadProjectKey ?? defaultProjectKey,
        listId: input.task.listId ?? input.listId,
        status: currentStatus,
        tags: mergedTags,
      },
      triageRules,
    );
    const projectKey =
      routing.projectKey ?? input.task.projectKey ?? payloadProjectKey ?? defaultProjectKey;
    const automationAllowed = input.task.automationAllowed ?? payloadAutomationAllowed ?? undefined;
    const approvalRequired =
      input.task.approvalRequired ??
      payloadApprovalRequired ??
      (triage.rule?.holdForHuman === true ? true : undefined) ??
      (normalizeStatus(currentStatus) === "triage" ||
      normalizeTags(mergedTags).includes("needs-human") ||
      normalizeTags(mergedTags).includes("needs-review")
        ? true
        : undefined);
    const workTypeSource =
      payloadWorkType ??
      input.task.workType ??
      routing.rule?.workType ??
      taggedWorkType ??
      defaultWorkType ??
      "";
    const normalizedWorkType = normalizeKey(workTypeSource);
    const workType = normalizedWorkType.length > 0 ? normalizedWorkType : undefined;
    const template = workType === undefined ? undefined : workTypeTemplates[workType];
    const templateText =
      workType !== undefined && template !== undefined ? renderTaskTemplate(workType, template) : undefined;
    const workflowTemplateKey = projectKey === undefined ? undefined : normalizeKey(projectKey);
    const workflowTemplateMatch =
      mergedTags.length > 0 ? findTemplateByTagMatch(mergedTags, workflowTemplates) : undefined;
    const workflowTemplateLabel = workflowTemplateKey ?? workType ?? workflowTemplateMatch;
    const workflowTemplate =
      (workflowTemplateKey === undefined ? undefined : workflowTemplates[workflowTemplateKey]) ??
      (workType === undefined ? undefined : workflowTemplates[workType]) ??
      (workflowTemplateMatch === undefined ? undefined : workflowTemplates[workflowTemplateMatch]);
    const workflowTemplateText =
      workflowTemplateLabel !== undefined && workflowTemplate !== undefined
        ? renderWorkflowTemplate(workflowTemplateLabel, workflowTemplate)
        : undefined;
    const decompositionSteps =
      workflowTemplate?.steps ??
      template?.steps ??
      readStringArray(payloadRecord?.decompositionSteps ?? payloadRecord?.steps);
    const decompositionText =
      workflowTemplateLabel !== undefined && decompositionSteps.length > 0
        ? renderDecompositionPlan(workflowTemplateLabel, decompositionSteps)
        : undefined;
    const triageReason =
      triage.rule?.reason ??
      (triage.rule !== undefined
        ? `Triage rule matched for ${triage.projectKey ?? projectKey ?? "unclassified"}`
        : undefined);
    const priorityBucket = determinePriorityBucket({
      clickupPriority: input.task.priority,
      taskBucket: payloadPriorityBucket ?? input.task.priorityBucket,
      routingRule: routing.rule,
      tags: mergedTags,
    });
    const priorityScore = scorePriorityBucket(priorityBucket, routing.rule?.priorityBoost ?? 0);
    const autoPicked = shouldAutoPickTask({
      status: currentStatus,
      tags: mergedTags,
      automationAllowed: automationAllowed ?? undefined,
      rule: routing.rule,
      approvalRequired,
    });
    const effectiveApprovalRequired = automationAllowed === true ? false : approvalRequired === true;

    state.upsertJob({
      task: {
        id: input.task.id,
        name: input.task.name,
        status: currentStatus,
        listId: input.task.listId ?? input.listId,
        projectKey: typeof projectKey === "string" ? projectKey : undefined,
        routingKey: routing.projectKey,
        workType,
        priorityBucket,
        automationAllowed,
        approvalRequired: effectiveApprovalRequired,
        autoPicked,
        priority: input.task.priority,
        description: input.task.description,
        repoUrl: input.task.repoUrl ?? repoUrl,
        prUrl: input.task.prUrl ?? prUrl,
        branchName: input.task.branchName,
        commitSha: input.task.commitSha,
        commitUrl: input.task.commitUrl,
        prNumber: input.task.prNumber,
        updatedAt: input.task.updatedAt,
        artifactUrl: input.task.artifactUrl ?? artifactUrl,
        docsUrl: input.task.docsUrl ?? docsUrl,
        designUrl: input.task.designUrl ?? designUrl,
        triageReason,
        tags: mergedTags,
      },
      state:
        autoPicked && effectiveApprovalRequired !== true
          ? "eligible"
          : isEligibleForOpenClaw(currentStatus)
            ? "eligible"
            : "normalized",
      bridgeState: autoPicked || isEligibleForOpenClaw(currentStatus) ? "eligible" : "received",
      claim: undefined,
      idempotencyKey,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: receivedAt,
      updatedAt: receivedAt,
      events: [],
      workType,
      workflowTemplate: workflowTemplateText,
      decompositionPlan: decompositionText,
      triageReason,
      template: templateText,
    });

    if ((autoPicked || isEligibleForOpenClaw(currentStatus)) && effectiveApprovalRequired !== true && triage.rule === undefined) {
      workboard.enqueue({
        taskId: input.task.id,
        priority: priorityScore,
        requestedAt: receivedAt,
        idempotencyKey,
      });
    }

    return { accepted: true, duplicate: false };
  }

  async function ingestWebhook(input: unknown) {
    const event = clickupWebhookEventSchema.parse(input);
    logger.info("webhook received", { event: event.event, taskId: event.taskId });

    const fetchedTask = clickup === undefined ? undefined : await clickup.getTask(event.taskId).catch((error: unknown) => {
      logger.warn("failed to fetch task details during ingest", {
        taskId: event.taskId,
        error: String(error),
      });
      return undefined;
    });
    const fallbackTask: ClickUpTask =
      fetchedTask ??
      {
        id: event.taskId,
        name: event.taskId,
        status: event.status ?? "unknown",
        listId: event.listId,
        tags: [],
      };

    return ingestTaskSnapshot({
      task: fallbackTask,
      sourceEvent: event.event,
      listId: event.listId,
      status: event.status,
      payload: event.payload as Record<string, unknown> | undefined,
    });
  }

  async function syncList(listId: string) {
    if (clickup === undefined) {
      throw new Error("ClickUp client not configured");
    }

    const discovered = await clickup.getListTasks(listId);
    let accepted = 0;
    let duplicate = 0;

    for (const discoveredTask of discovered) {
      const hydratedTask = await clickup.getTask(discoveredTask.id).catch((error: unknown) => {
        logger.warn("failed to hydrate task during list sync", {
          taskId: discoveredTask.id,
          listId,
          error: String(error),
        });
        return undefined;
      });

      if (hydratedTask === undefined) {
        continue;
      }

      const result = await ingestTaskSnapshot({
        task: hydratedTask,
        sourceEvent: "taskUpdated",
        listId,
        status: hydratedTask.status,
      });

      if (result.accepted && !result.duplicate) {
        accepted += 1;
      }
      if (result.duplicate) {
        duplicate += 1;
      }
    }

    logger.info("clickup list synced", {
      listId,
      discovered: discovered.length,
      accepted,
      duplicate,
    });

    return {
      listId,
      discovered: discovered.length,
      accepted,
      duplicate,
    };
  }

  async function claimNextJob(input?: { leaseSeconds?: number | undefined }) {
    if (paused) {
      logger.info("claim skipped while paused");
      return null;
    }

    const leaseSeconds = input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    const now = nowIso();

    workboard.reclaimExpired(now);
    const next = workboard.next();
    if (next === undefined) {
      return null;
    }

    const runId = randomUUID();
    const claim = claimRecordSchema.parse({
      taskId: next.taskId,
      runId,
      workboardId: `workboard-${next.taskId}`,
      leaseStartedAt: now,
      leaseExpiresAt: toLeaseExpiry(now, leaseSeconds),
      leaseSeconds,
      priorityScore: next.priority,
      priorityBucket: state.getJob(next.taskId)?.task.priorityBucket,
    });

    workboard.claim(claim);
    state.mergeJob(next.taskId, {
      state: "leased",
      claim,
      claimedAt: now,
      retryCount: (state.getJob(next.taskId)?.retryCount ?? 0) + 1,
      updatedAt: now,
    });

    try {
      await writeClaimSideEffects(next.taskId, runId, claim.workboardId, now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(next.taskId, {
        state: "deadLettered",
        claim: undefined,
        outcome: "deadLettered",
        terminalAt: nowIso(),
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      workboard.release(next.taskId);
      logger.error("job dead-lettered during claim write-back", { taskId: next.taskId, reason });
      throw error;
    }

    logger.info("job claimed", { taskId: next.taskId, runId });

    return {
      taskId: next.taskId,
      runId,
      leaseExpiresAt: claim.leaseExpiresAt,
      leaseSeconds,
      requestedAt: next.requestedAt,
      task: state.getJob(next.taskId)?.task,
    };
  }

  async function manualClaimJob(taskId: string, input?: { leaseSeconds?: number | undefined }) {
    const existing = state.getJob(taskId);
    if (existing === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const currentClaim = workboard.getClaim(taskId);
    if (currentClaim !== undefined) {
      return {
        taskId,
        runId: currentClaim.runId,
        leaseExpiresAt: currentClaim.leaseExpiresAt,
        leaseSeconds: currentClaim.leaseSeconds,
        requestedAt: existing.updatedAt,
        task: existing.task,
      };
    }

    const leaseSeconds = input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    const now = nowIso();
    const runId = randomUUID();
    workboard.removeQueued(taskId);
    const claim = claimRecordSchema.parse({
      taskId,
      runId,
      workboardId: `workboard-${taskId}`,
      leaseStartedAt: now,
      leaseExpiresAt: toLeaseExpiry(now, leaseSeconds),
      leaseSeconds,
      priorityScore: scorePriorityBucket(existing.task.priorityBucket),
      priorityBucket: existing.task.priorityBucket,
    });

    workboard.claim(claim);
    state.mergeJob(taskId, {
      state: "leased",
      claim,
      claimedAt: now,
      retryCount: (existing.retryCount ?? 0) + 1,
      updatedAt: now,
    });

    try {
      await writeClaimSideEffects(taskId, runId, claim.workboardId, now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(taskId, {
        state: "deadLettered",
        claim: undefined,
        outcome: "deadLettered",
        terminalAt: nowIso(),
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      workboard.release(taskId);
      logger.error("job dead-lettered during manual claim write-back", { taskId, reason });
      throw error;
    }

    logger.info("job manually claimed", { taskId, runId });
    return {
      taskId,
      runId,
      leaseExpiresAt: claim.leaseExpiresAt,
      leaseSeconds,
      requestedAt: now,
      task: existing.task,
    };
  }

  async function releaseJob(taskId: string, input?: { requeue?: boolean | undefined }) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      return null;
    }

    const hadClaim = workboard.getClaim(taskId);
    if (hadClaim === undefined) {
      return { taskId, released: false, requeued: false };
    }

    workboard.release(taskId);
    const now = nowIso();
    state.mergeJob(taskId, {
      claim: undefined,
      state: input?.requeue === true ? "eligible" : "normalized",
      updatedAt: now,
    });

    if (input?.requeue === true) {
      workboard.enqueue({
        taskId,
        priority:
          current.claim?.priorityScore ??
          scorePriorityBucket(current.task.priorityBucket) ??
          0,
        requestedAt: now,
      });
    }

    logger.info("job released", { taskId, requeued: input?.requeue === true });
    return { taskId, released: true, requeued: input?.requeue === true };
  }

  async function requeueJob(taskId: string) {
    const result = await releaseJob(taskId, { requeue: true });
    if (result === null) {
      return null;
    }

    logger.info("job requeued", { taskId });
    return result;
  }

  function pauseWork(): { paused: true } {
    paused = true;
    logger.warn("bridge paused");
    return { paused: true };
  }

  function resumeWork(): { paused: false } {
    paused = false;
    logger.warn("bridge resumed");
    return { paused: false };
  }

  function getControlState() {
    return {
      paused,
      heartbeatMonitorIntervalMs,
      openClawWatchIntervalMs,
      queueStallAlertMs,
      blockedEscalationMs,
    };
  }

  async function monitorHeartbeats(input?: { now?: string | undefined }) {
    const now = input?.now ?? nowIso();
    const reclaimed = workboard.reclaimExpired(now);
    const notified: Array<{ taskId: string; reason: string }> = [];

    for (const item of reclaimed) {
      const current = state.getJob(item.taskId);
      const leaseExpiresAt = current?.claim?.leaseExpiresAt;
      const reason = leaseExpiresAt
        ? `Lease expired at ${leaseExpiresAt} and task was requeued.`
        : "Lease expired and task was requeued.";

      state.mergeJob(item.taskId, {
        state: "reclaimed",
        claim: undefined,
        lastError: reason,
        updatedAt: now,
      });

      if (clickup !== undefined) {
        try {
          await clickup.postTaskComment(item.taskId, buildHeartbeatComment(item.taskId, leaseExpiresAt ?? now));
          await clickup.updateTaskMetadata(item.taskId, {
            status: "ready for openclaw",
            customFields: {
              automation_state: "candidate",
              last_sync_at: now,
              last_error: reason,
              ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
              ...(prUrl === undefined ? {} : { pr_url: prUrl }),
              ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
              ...(docsUrl === undefined ? {} : { docs_url: docsUrl }),
              ...(designUrl === undefined ? {} : { design_url: designUrl }),
            },
          });
        } catch (error) {
          logger.warn("failed to report reclaimed heartbeat", {
            taskId: item.taskId,
            error: String(error),
          });
        }
      }

      logger.warn("job reclaimed after missed heartbeat", {
        taskId: item.taskId,
        leaseExpiresAt: leaseExpiresAt ?? null,
      });
      notified.push({ taskId: item.taskId, reason });
    }

    const blockedJobs = state
      .listJobs()
      .filter((job) => job.state === "blocked" && job.blockedAt !== undefined);
    const escalated: Array<{ taskId: string; reason: string }> = [];
    const blockedEscalationThresholdMs = Math.max(0, blockedEscalationMs);

    for (const job of blockedJobs) {
      const blockedAtMs = Date.parse(job.blockedAt ?? "");
      if (!Number.isFinite(blockedAtMs)) {
        continue;
      }

      const elapsedMs = Date.parse(now) - blockedAtMs;
      if (blockedEscalationThresholdMs === 0 || elapsedMs < blockedEscalationThresholdMs) {
        continue;
      }

      const reason =
        elapsedMs < 60_000
          ? `Auto-escalated after ${Math.max(1, Math.round(elapsedMs / 1000))} seconds blocked.`
          : `Auto-escalated after ${Math.max(1, Math.round(elapsedMs / 60000))} minutes blocked.`;
      try {
        await autoEscalateBlockedJob(job.task.id, reason, now);
        escalated.push({ taskId: job.task.id, reason });
      } catch (error) {
        logger.warn("failed to auto-escalate blocked job", {
          taskId: job.task.id,
          error: String(error),
        });
      }
    }

    const queuedItems = workboard.listQueuedItems();
    const queueAgeMs = queuedItems.reduce((oldest, item) => {
      const ageMs = Date.parse(now) - Date.parse(item.requestedAt);
      return Math.max(oldest, Number.isFinite(ageMs) ? ageMs : 0);
    }, 0);
    const staleClaims = workboard.listClaims().filter((claim) => claim.leaseExpiresAt <= now);

    if (staleClaims.length > 0 || queueAgeMs >= queueStallAlertMs) {
      logger.error("queue stall detected", {
        queueDepth: queuedItems.length,
        staleClaims: staleClaims.length,
        queueAgeMs,
        queueStallAlertMs,
      });
    }

    return { now, reclaimed, notified, escalated };
  }

  async function autoEscalateBlockedJob(taskId: string, reason: string, now: string) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const claim = workboard.getClaim(taskId);
    const links = resolveArtifactLinks(current.task.projectKey ?? current.task.routingKey, artifactLinks, projectRoutingRules);
    workboard.release(taskId);

    state.mergeJob(taskId, {
      state: "normalized",
      claim: undefined,
      blockedAt: undefined,
      terminalAt: undefined,
      outcome: undefined,
      lastError: reason,
      updatedAt: now,
    });

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(taskId, `Auto-escalated into review by OpenClaw: ${reason}`);
        await clickup.updateTaskMetadata(taskId, {
          status: "review",
          customFields: buildTaskWriteBackFields(current.task, now, links, {
            automation_state: "candidate",
            last_error: reason,
            run_id: claim?.runId ?? current.claim?.runId ?? "",
            workboard_id: claim?.workboardId ?? current.claim?.workboardId ?? "",
          }),
        });
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      state.mergeJob(taskId, {
        state: "deadLettered",
        claim: undefined,
        outcome: "deadLettered",
        terminalAt: nowIso(),
        lastError: failure,
        deadLetteredAt: nowIso(),
        deadLetterReason: failure,
        updatedAt: nowIso(),
      });
      logger.error("job dead-lettered during auto escalation write-back", { taskId, reason: failure });
      throw error;
    }

    logger.warn("job auto-escalated to review", { taskId, reason });
    return {
      taskId,
      reviewAt: now,
      reason,
    };
  }

  function getMetricsSnapshot(input?: { now?: string | undefined }) {
    const now = input?.now ?? nowIso();
    const jobs = state.listJobs();
    const claims = workboard.listClaims();
    const queuedItems = workboard.listQueuedItems();

    const jobCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.state] = (counts[job.state] ?? 0) + 1;
      return counts;
    }, {});

    const terminalJobs = jobs.filter((job) => job.terminalAt !== undefined && job.claimedAt !== undefined);
    const averageClaimToTerminalMs =
      terminalJobs.length === 0
        ? 0
        : Math.round(
            terminalJobs.reduce((sum, job) => {
              return sum + (Date.parse(job.terminalAt ?? now) - Date.parse(job.claimedAt ?? now));
            }, 0) / terminalJobs.length,
          );

    const oldestQueuedAgeMs =
      queuedItems.length === 0
        ? 0
        : Math.max(
            ...queuedItems.map((item) => {
              const ageMs = Date.parse(now) - Date.parse(item.requestedAt);
              return Number.isFinite(ageMs) ? ageMs : 0;
            }),
          );

    const workTypeCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      const workType = job.workType ?? "unclassified";
      counts[workType] = (counts[workType] ?? 0) + 1;
      return counts;
    }, {});

    const priorityBucketCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      const priorityBucket = job.task.priorityBucket ?? "unclassified";
      counts[priorityBucket] = (counts[priorityBucket] ?? 0) + 1;
      return counts;
    }, {});

    const autoPickedJobs = jobs.filter((job) => job.task.autoPicked === true).length;
    const approvalRequiredJobs = jobs.filter((job) => job.task.approvalRequired === true).length;
    const succeededJobs = jobs.filter((job) => job.outcome === "succeeded").length;
    const failedJobs = jobs.filter((job) => job.outcome === "failed").length;
    const blockedJobs = jobs.filter((job) => job.outcome === "blocked").length;
    const deadLetteredJobs = jobs.filter((job) => job.outcome === "deadLettered").length;

    return {
      now,
      queueDepth: queuedItems.length,
      activeClaims: claims.length,
      staleClaims: claims.filter((claim) => claim.leaseExpiresAt <= now).length,
      jobCounts,
      workTypeCounts,
      priorityBucketCounts,
      autoPickedJobs,
      approvalRequiredJobs,
      throughput: {
        terminalJobs: terminalJobs.length,
        succeededJobs,
        failedJobs,
        blockedJobs,
        deadLetteredJobs,
      },
      latency: {
        averageClaimToTerminalMs,
        oldestQueuedAgeMs,
      },
      thresholds: {
        queueStallAlertMs,
      },
    };
  }

  function getDashboardSnapshot(input?: { now?: string | undefined }) {
    const metrics = getMetricsSnapshot(input);
    const now = metrics.now;
    const jobs = state.listJobs();
    const claims = workboard.listClaims();
    const queuedItems = workboard.listQueuedItems();
    const completedJobs = jobs.filter((job) => job.terminalAt !== undefined);
    const successfulJobs = jobs.filter((job) => job.outcome === "succeeded");
    const blockedJobs = jobs.filter((job) => job.outcome === "blocked");
    const failedJobs = jobs.filter((job) => job.outcome === "failed");
    const deadLetteredJobs = jobs.filter((job) => job.outcome === "deadLettered");

    const byWorkType = Object.entries(
      jobs.reduce<Record<string, Array<(typeof jobs)[number]>>>((groups, job) => {
        const workType = job.workType ?? "unclassified";
        groups[workType] = groups[workType] ?? [];
        groups[workType].push(job);
        return groups;
      }, {}),
    ).map(([workType, items]) => {
      const terminal = items.filter((job) => job.terminalAt !== undefined);
      const succeeded = items.filter((job) => job.outcome === "succeeded").length;
      const blocked = items.filter((job) => job.outcome === "blocked").length;
      const failed = items.filter((job) => job.outcome === "failed").length;
      return {
        workType,
        total: items.length,
        terminal: terminal.length,
        succeeded,
        blocked,
        failed,
        completionRate: items.length === 0 ? 0 : Number((terminal.length / items.length).toFixed(2)),
        successRate: items.length === 0 ? 0 : Number((succeeded / items.length).toFixed(2)),
      };
    });

    const byProject = Object.entries(
      jobs.reduce<Record<string, Array<(typeof jobs)[number]>>>((groups, job) => {
        const projectKey = job.task.projectKey ?? "unclassified";
        groups[projectKey] = groups[projectKey] ?? [];
        groups[projectKey].push(job);
        return groups;
      }, {}),
    ).map(([projectKey, items]) => ({
      projectKey,
      total: items.length,
      succeeded: items.filter((job) => job.outcome === "succeeded").length,
      blocked: items.filter((job) => job.outcome === "blocked").length,
      failed: items.filter((job) => job.outcome === "failed").length,
      deadLettered: items.filter((job) => job.outcome === "deadLettered").length,
    }));

    const byPriorityBucket = Object.entries(
      jobs.reduce<Record<string, Array<(typeof jobs)[number]>>>((groups, job) => {
        const priorityBucket = job.task.priorityBucket ?? "unclassified";
        groups[priorityBucket] = groups[priorityBucket] ?? [];
        groups[priorityBucket].push(job);
        return groups;
      }, {}),
    ).map(([priorityBucket, items]) => ({
      priorityBucket,
      total: items.length,
      completed: items.filter((job) => job.terminalAt !== undefined).length,
      succeeded: items.filter((job) => job.outcome === "succeeded").length,
      failed: items.filter((job) => job.outcome === "failed").length,
      blocked: items.filter((job) => job.outcome === "blocked").length,
    }));

    const failureRate =
      jobs.length === 0 ? 0 : Number(((failedJobs.length + blockedJobs.length + deadLetteredJobs.length) / jobs.length).toFixed(2));

    return {
      now,
      queueHealth: {
        queueDepth: metrics.queueDepth,
        activeClaims: metrics.activeClaims,
        staleClaims: metrics.staleClaims,
        queueStallAlertMs: metrics.thresholds.queueStallAlertMs,
        oldestQueuedAgeMs: metrics.latency.oldestQueuedAgeMs,
        stalled: metrics.staleClaims > 0 || metrics.latency.oldestQueuedAgeMs >= metrics.thresholds.queueStallAlertMs,
        jobCounts: metrics.jobCounts,
        workTypeCounts: metrics.workTypeCounts,
        priorityBucketCounts: metrics.priorityBucketCounts,
        autoPickedJobs: metrics.autoPickedJobs,
        approvalRequiredJobs: metrics.approvalRequiredJobs,
        claims,
        queuedItems,
      },
      completionRates: {
        totalJobs: jobs.length,
        completedJobs: completedJobs.length,
        succeededJobs: successfulJobs.length,
        blockedJobs: blockedJobs.length,
        failedJobs: failedJobs.length,
        deadLetteredJobs: deadLetteredJobs.length,
        completionRate: jobs.length === 0 ? 0 : Number((completedJobs.length / jobs.length).toFixed(2)),
        failureRate,
        successRate: jobs.length === 0 ? 0 : Number((successfulJobs.length / jobs.length).toFixed(2)),
        byWorkType,
        byProject,
        byPriorityBucket,
      },
    };
  }

  async function heartbeatJob(taskId: string, input?: { leaseSeconds?: number | undefined }) {
    const current = workboard.getClaim(taskId);
    if (current === undefined) {
      return null;
    }

    const leaseStartedAt = nowIso();
    const leaseSeconds = input?.leaseSeconds ?? current.leaseSeconds;
    const renewed = workboard.renew(taskId, toLeaseExpiry(leaseStartedAt, leaseSeconds));
    if (renewed === undefined) {
      return null;
    }

    state.mergeJob(taskId, {
      claim: renewed,
      updatedAt: leaseStartedAt,
    });

    return renewed;
  }

  async function recordWorkerEvent(taskId: string, input: unknown) {
    const event = workerEventSchema.parse(input);
    if (event.taskId !== taskId) {
      throw new Error(`Task mismatch for event on ${taskId}`);
    }

    const recorded = state.appendJobEvent(taskId, event);
    if (recorded === undefined) {
      return null;
    }

    logger.info("worker event recorded", {
      taskId,
      runId: event.runId,
      kind: event.kind,
      ...(event.kind === "log"
        ? { level: event.level }
        : { step: event.step, progressState: event.state }),
    });

    return recorded;
  }

  async function completeJob(
    taskId: string,
    input: { outcome: "succeeded" | "failed" | "blocked"; summary: string },
  ) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const claim = workboard.getClaim(taskId);
    const completedAt = nowIso();
    const links = resolveArtifactLinks(current.task.projectKey ?? current.task.routingKey, artifactLinks, projectRoutingRules);
    workboard.release(taskId);

    const nextState = workboardStateSchema.parse(
      input.outcome === "succeeded" ? "succeeded" : input.outcome === "blocked" ? "blocked" : "failed",
    );

    state.mergeJob(taskId, {
      state: nextState,
      claim: undefined,
      outcome: input.outcome,
      lastError: input.outcome === "succeeded" ? undefined : input.summary,
      terminalAt: completedAt,
      updatedAt: completedAt,
    });

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(taskId, buildArtifactComment(input.summary, links, current.task));
        const mappedStatus = getWorkboardToClickUpStatusMapping(mapOutcomeToWorkboardStatus(input.outcome));
        await clickup.updateTaskMetadata(taskId, {
          status: mappedStatus.clickupStatus,
          customFields: buildTaskWriteBackFields(current.task, completedAt, links, {
            automation_state: mappedStatus.automationState,
            last_error: input.outcome === "succeeded" ? "" : input.summary,
            run_id: claim?.runId ?? current.claim?.runId ?? "",
            workboard_id: claim?.workboardId ?? current.claim?.workboardId ?? "",
          }),
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(taskId, {
        state: "deadLettered",
        claim: undefined,
        terminalAt: nowIso(),
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      logger.error("job dead-lettered during completion write-back", { taskId, reason });
      throw error;
    }

    logger.info("job completed", { taskId, outcome: input.outcome });
    return {
      taskId,
      outcome: input.outcome,
      completedAt,
    };
  }

  async function markBlockedJob(taskId: string, input: { reason: string }) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const now = nowIso();
    const claim = workboard.getClaim(taskId);
    const links = resolveArtifactLinks(current.task.projectKey ?? current.task.routingKey, artifactLinks, projectRoutingRules);
    workboard.release(taskId);

    state.mergeJob(taskId, {
      state: "blocked",
      claim: undefined,
      outcome: "blocked",
      blockedAt: now,
      terminalAt: now,
      lastError: input.reason,
      updatedAt: now,
    });

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(taskId, `Marked blocked by OpenClaw: ${input.reason}`);
        await clickup.updateTaskMetadata(taskId, {
          status: "blocked",
          customFields: buildTaskWriteBackFields(current.task, now, links, {
            automation_state: "blocked",
            last_error: input.reason,
            run_id: claim?.runId ?? current.claim?.runId ?? "",
            workboard_id: claim?.workboardId ?? current.claim?.workboardId ?? "",
          }),
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(taskId, {
        state: "deadLettered",
        claim: undefined,
        outcome: "deadLettered",
        terminalAt: nowIso(),
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      logger.error("job dead-lettered during blocked write-back", { taskId, reason });
      throw error;
    }

    logger.warn("job marked blocked", { taskId, reason: input.reason });
    return {
      taskId,
      blockedAt: now,
      reason: input.reason,
    };
  }

  async function forceReviewJob(taskId: string, input: { reason: string }) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    const now = nowIso();
    const claim = workboard.getClaim(taskId);
    const links = resolveArtifactLinks(current.task.projectKey ?? current.task.routingKey, artifactLinks, projectRoutingRules);
    workboard.release(taskId);

    state.mergeJob(taskId, {
      state: "normalized",
      claim: undefined,
      blockedAt: undefined,
      terminalAt: undefined,
      outcome: undefined,
      lastError: input.reason,
      updatedAt: now,
    });

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(taskId, `Forced into review by OpenClaw: ${input.reason}`);
        await clickup.updateTaskMetadata(taskId, {
          status: "human-review",
          customFields: buildTaskWriteBackFields(current.task, now, links, {
            automation_state: "candidate",
            last_error: input.reason,
            run_id: claim?.runId ?? current.claim?.runId ?? "",
            workboard_id: claim?.workboardId ?? current.claim?.workboardId ?? "",
          }),
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.mergeJob(taskId, {
        state: "deadLettered",
        claim: undefined,
        outcome: "deadLettered",
        terminalAt: nowIso(),
        lastError: reason,
        deadLetteredAt: nowIso(),
        deadLetterReason: reason,
        updatedAt: nowIso(),
      });
      logger.error("job dead-lettered during force review write-back", { taskId, reason });
      throw error;
    }

    logger.warn("job forced into review", { taskId, reason: input.reason });
    return {
      taskId,
      reviewAt: now,
      reason: input.reason,
    };
  }

  return {
    logger,
    state,
    workboard,
    clickup,
    openClawWorkboard,
    ingestWebhook,
    syncList,
    buildBridgeToWorkboardCard,
    handoffJobToOpenClaw,
    dispatchOpenClawWorkboard,
    refreshOpenClawCard,
    syncOpenClawCardToClickUp,
    watchOpenClawCards,
    claimNextJob,
    manualClaimJob,
    releaseJob,
    requeueJob,
    markBlockedJob,
    forceReviewJob,
    pauseWork,
    resumeWork,
    getControlState,
    heartbeatJob,
    recordWorkerEvent,
    completeJob,
    monitorHeartbeats,
    heartbeatMonitorIntervalMs,
    openClawWatchIntervalMs,
    queueStallAlertMs,
    getMetricsSnapshot,
    getDashboardSnapshot,
    listJobs: () => state.listJobs(),
  };
}
