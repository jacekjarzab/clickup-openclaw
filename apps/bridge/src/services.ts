import { createClickUpClient } from "@clickup-openclaw/clickup-client";
import { createLogger } from "@clickup-openclaw/observability";
import {
  bridgeToWorkboardCardSchema,
  clickupAutomationStatusSchema,
  getWorkboardToClickUpStatusMapping,
  clickupWebhookEventSchema,
  type OpenClawTerminalContext,
  type BridgeToWorkboardCard,
  type BridgeJobState,
  type ClickUpTask,
  type OpenClawWorkboardCardStatus,
  type PriorityBucket,
} from "@clickup-openclaw/shared";
import { FileBackedStateStore, InMemoryStateStore, type JobRecord } from "@clickup-openclaw/state";

import type { BridgeConfig } from "./config.js";
import { OpenClawWorkboardAdapter } from "./openclaw-workboard.js";
import { resolveRepoUrl } from "./repo-url.js";

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

type ClickUpWriteBackState = NonNullable<JobRecord["clickupWriteBack"]>;

function nowIso(): string {
  return new Date().toISOString();
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

function readNestedValue(record: Record<string, unknown>, path: string[]): unknown | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function readTerminalArtifactList(value: unknown): Array<string | Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  const artifacts: Array<string | Record<string, unknown>> = [];

  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        artifacts.push(trimmed);
      }
      continue;
    }

    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const url =
        readString(record.url) ??
        readString(record.href) ??
        readString(record.link) ??
        readString(record.artifactUrl) ??
        readString(record.artifact_url);
      const title = readString(record.title) ?? readString(record.name);

      if (title !== undefined && url !== undefined) {
        artifacts.push({ title, url });
        continue;
      }

      if (url !== undefined) {
        artifacts.push(url);
        continue;
      }

      if (title !== undefined) {
        artifacts.push(title);
        continue;
      }

      artifacts.push(record);
    }
  }

  return artifacts;
}

function readTerminalCommentList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function renderTerminalContextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const title = readString(record.title) ?? readString(record.name) ?? readString(record.label);
    const url =
      readString(record.url) ??
      readString(record.href) ??
      readString(record.link) ??
      readString(record.artifactUrl) ??
      readString(record.artifact_url);
    const candidate =
      readString(record.url) ??
      readString(record.href) ??
      readString(record.link) ??
      readString(record.note) ??
      readString(record.message) ??
      readString(record.description) ??
      readString(record.summary) ??
      readString(record.text) ??
      readString(record.title) ??
      readString(record.name);

    if (title !== undefined && url !== undefined) {
      return `${title} (${url})`;
    }

    if (url !== undefined) {
      return url;
    }

    if (title !== undefined) {
      return title;
    }

    return candidate ?? JSON.stringify(record);
  }

  return undefined;
}

function renderTerminalContextSection(
  label: string,
  values: Array<string | Record<string, unknown>> | undefined,
): string[] {
  if (values === undefined || values.length === 0) {
    return [];
  }

  const renderedItems = values
    .map((value) => renderTerminalContextValue(value))
    .filter((value): value is string => value !== undefined)
    .map((value) => `- ${value}`);

  return renderedItems.length > 0 ? [label + ":", ...renderedItems] : [];
}

export function extractOpenClawTerminalContext(
  raw: Record<string, unknown>,
  status: OpenClawWorkboardCardStatus,
): OpenClawTerminalContext {
  const summary =
    readNestedString(raw, ["summary"]) ??
    readNestedString(raw, ["execution", "summary"]) ??
    readNestedString(raw, ["proof", "note"]) ??
    readNestedString(raw, ["execution", "proof", "note"]) ??
    readNestedString(raw, ["notes"]);
  const proof = readNestedValue(raw, ["proof"]) ?? readNestedValue(raw, ["execution", "proof"]);
  const artifacts = [
    ...readTerminalArtifactList(readNestedValue(raw, ["artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["proof", "artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "proof", "artifacts"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["proof", "links"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "links"])),
    ...readTerminalArtifactList(readNestedValue(raw, ["execution", "proof", "links"])),
  ];
  const comments = [
    ...readTerminalCommentList(readNestedValue(raw, ["comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["execution", "comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["proof", "comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["execution", "proof", "comments"])),
    ...readTerminalCommentList(readNestedValue(raw, ["comment"])),
    ...readTerminalCommentList(readNestedValue(raw, ["execution", "comment"])),
  ];
  const blockerContext =
    readNestedString(raw, ["blockerContext"]) ??
    readNestedString(raw, ["blocker_context"]) ??
    readNestedString(raw, ["blockerReason"]) ??
    readNestedString(raw, ["blocker_reason"]) ??
    readNestedString(raw, ["execution", "blockerContext"]) ??
    readNestedString(raw, ["execution", "blocker_context"]) ??
    readNestedString(raw, ["execution", "blockerReason"]) ??
    readNestedString(raw, ["execution", "blocker_reason"]) ??
    readNestedString(raw, ["execution", "proof", "blockerContext"]) ??
    readNestedString(raw, ["execution", "proof", "blocker_context"]) ??
    readNestedString(raw, ["execution", "proof", "blockerReason"]) ??
    readNestedString(raw, ["execution", "proof", "blocker_reason"]) ??
    readNestedString(raw, ["blocker", "reason"]) ??
    readNestedString(raw, ["proof", "blockerReason"]) ??
    readNestedString(raw, ["proof", "blocker_reason"]) ??
    readNestedString(raw, ["proof", "blocker"]);

  return {
    ...(summary === undefined ? {} : { summary }),
    ...(proof === undefined ? {} : { proof }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(comments.length === 0 ? {} : { comments }),
    ...(blockerContext === undefined && status === "blocked" && summary !== undefined
      ? { blockerContext: summary }
      : blockerContext === undefined
        ? {}
        : { blockerContext }),
  };
}

function buildOpenClawTerminalSummary(
  status: OpenClawWorkboardCardStatus,
  terminalContext: OpenClawTerminalContext | undefined,
): string {
  if (status === "blocked") {
    return (
      terminalContext?.blockerContext ??
      terminalContext?.summary ??
      "OpenClaw blocked this task and needs human input before continuing."
    );
  }

  return (
    terminalContext?.summary ??
    "OpenClaw finished this task and returned it for human review."
  );
}

function buildOpenClawTerminalFollowUp(status: OpenClawWorkboardCardStatus): string | undefined {
  switch (status) {
    case "review":
    case "done":
      return "Next step: review the result in ClickUp and close the task if it looks right.";
    case "blocked":
      return "Next step: resolve the blocker, then rerun OpenClaw.";
    default:
      return undefined;
  }
}

function appendTerminalContextSections(
  lines: string[],
  terminalContext: OpenClawTerminalContext | undefined,
): void {
  const proof = renderTerminalContextValue(terminalContext?.proof);
  if (proof !== undefined) {
    lines.push("", `Proof: ${proof}`);
  }

  const artifactLines = renderTerminalContextSection("Artifacts", terminalContext?.artifacts);
  if (artifactLines.length > 0) {
    lines.push("", ...artifactLines);
  }

  const commentLines = renderTerminalContextSection("Comments", terminalContext?.comments?.map((comment) => comment));
  if (commentLines.length > 0) {
    lines.push("", ...commentLines);
  }
}

export function buildOpenClawStatusComment(
  status: OpenClawWorkboardCardStatus,
  terminalContext: OpenClawTerminalContext | undefined,
): string | undefined {
  switch (status) {
    case "running":
      return "OpenClaw started work on this task.";
    case "review":
    case "done": {
      const lines = [buildOpenClawTerminalSummary(status, terminalContext)];
      appendTerminalContextSections(lines, terminalContext);

      const followUp = buildOpenClawTerminalFollowUp(status);
      if (followUp !== undefined) {
        lines.push("", followUp);
      }

      return lines.join("\n");
    }
    case "blocked": {
      const lines = [buildOpenClawTerminalSummary(status, terminalContext)];
      if (
        terminalContext?.summary !== undefined &&
        terminalContext.summary !== terminalContext.blockerContext
      ) {
        lines.push("", `Summary: ${terminalContext.summary}`);
      }

      appendTerminalContextSections(lines, terminalContext);

      const followUp = buildOpenClawTerminalFollowUp(status);
      if (followUp !== undefined) {
        lines.push("", followUp);
      }

      return lines.join("\n");
    }
    default:
      return undefined;
  }
}

function updateClickUpWriteBack(
  taskId: string,
  state: InMemoryStateStore | FileBackedStateStore,
  updater: (current: ClickUpWriteBackState | undefined) => ClickUpWriteBackState | undefined,
): ClickUpWriteBackState | undefined {
  const job = state.getJob(taskId);
  if (job === undefined) {
    return undefined;
  }

  const next = updater(job.clickupWriteBack);
  if (next === undefined) {
    return undefined;
  }

  state.mergeJob(taskId, { clickupWriteBack: next });
  return next;
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

function preserveBridgeState(value: BridgeJobState | undefined): BridgeJobState | undefined {
  if (
    value === "eligible" ||
    value === "card_created" ||
    value === "dispatched" ||
    value === "running" ||
    value === "blocked" ||
    value === "completed" ||
    value === "synced_back" ||
    value === "dead_lettered"
  ) {
    return value;
  }

  return undefined;
}

type BridgeServiceDependencies = {
  stateStore?: FileBackedStateStore | InMemoryStateStore;
  openClawWorkboard?: OpenClawWorkboardAdapter;
};

export function createBridgeServices(config: BridgeConfig, dependencies: BridgeServiceDependencies = {}) {
  const logger = createLogger("bridge");
  const state =
    dependencies.stateStore ?? new FileBackedStateStore(config.STATE_FILE_PATH ?? ".data/bridge-state.json");
  let paused = false;
  const defaultProjectKey = config.DEFAULT_PROJECT_KEY;
  const repoUrl = resolveRepoUrl(config);
  const prUrl = config.PR_URL ?? config.CLICKUP_PR_URL;
  const artifactUrl = config.ARTIFACT_URL ?? config.CLICKUP_ARTIFACT_URL;
  const docsUrl = config.DOCS_URL ?? config.CLICKUP_DOCS_URL;
  const designUrl = config.DESIGN_URL ?? config.CLICKUP_DESIGN_URL;
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
  const openClawWorkboard =
    dependencies.openClawWorkboard ??
    new OpenClawWorkboardAdapter({
      ...(config.OPENCLAW_BIN === undefined ? {} : { binary: config.OPENCLAW_BIN }),
      ...(config.OPENCLAW_WORKBOARD_BOARD_ID === undefined
        ? {}
        : { boardId: config.OPENCLAW_WORKBOARD_BOARD_ID }),
      cwd: process.cwd(),
      timeoutMs: toNumber(config.OPENCLAW_WORKBOARD_CLI_TIMEOUT_MS, 30_000),
    });

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

    for (const job of state
      .listJobs()
      .filter((entry) => (entry.bridgeState === "eligible" || entry.bridgeState === "card_created") && entry.workboardCardId !== undefined)) {
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

  async function autoHandoffAndDispatchEligibleJob(taskId: string) {
    const current = state.getJob(taskId);
    if (current === undefined) {
      throw new Error(`Unknown task ${taskId}`);
    }

    if (paused) {
      return {
        taskId,
        paused: true,
        handedOff: false,
        dispatched: false,
      };
    }

    if (current.bridgeState !== "eligible" && current.bridgeState !== "card_created") {
      return {
        taskId,
        paused: false,
        handedOff: false,
        dispatched: false,
      };
    }

    let handedOff = false;
    if (current.workboardCardId === undefined) {
      await handoffJobToOpenClaw(taskId);
      handedOff = true;
    }

    const afterHandoff = state.getJob(taskId);
    if (afterHandoff?.bridgeState !== "eligible" && afterHandoff?.bridgeState !== "card_created") {
      return {
        taskId,
        paused: false,
        handedOff,
        dispatched: false,
      };
    }

    await dispatchOpenClawWorkboard();

    return {
      taskId,
      paused: false,
      handedOff,
      dispatched: true,
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
      ...(card.terminalContext === undefined ? {} : { terminalContext: card.terminalContext }),
      updatedAt,
    });

    return {
      taskId,
      workboardCardId: current.workboardCardId,
      status: card.status,
      terminalContext: card.terminalContext,
      raw: card.raw,
    };
  }

  async function syncOpenClawCardToClickUp(taskId: string) {
    const current = state.getJob(taskId);
    if (current === undefined || current.workboardCardId === undefined) {
      throw new Error(`Task ${taskId} has not been handed off to OpenClaw`);
    }

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
    const terminalContext =
      refreshed.terminalContext ?? extractOpenClawTerminalContext(refreshed.raw, refreshed.status);
    const runId =
      next.claim?.runId ??
      current.claim?.runId ??
      readNestedString(refreshed.raw, ["execution", "runId"]) ??
      "";
    const comment = buildOpenClawStatusComment(refreshed.status, terminalContext);
    const currentWriteBack = next.clickupWriteBack;
    const writeBackTimestamp = updatedAt;
    const terminalAlreadySynced = currentWriteBack?.terminal?.lastSyncedStatus === refreshed.status;
    const mergeRunningWriteBack = (patch: Partial<NonNullable<ClickUpWriteBackState["running"]>>) =>
      updateClickUpWriteBack(taskId, state, (existing) => ({
        ...(existing ?? {}),
        running: {
          ...((existing?.running ?? {}) as NonNullable<ClickUpWriteBackState["running"]>),
          ...patch,
        },
      }));
    const mergeTerminalWriteBack = (patch: Partial<NonNullable<ClickUpWriteBackState["terminal"]>>) =>
      updateClickUpWriteBack(taskId, state, (existing) => ({
        ...(existing ?? {}),
        terminal: {
          ...((existing?.terminal ?? {}) as NonNullable<ClickUpWriteBackState["terminal"]>),
          ...patch,
        },
      }));

    if (clickup !== undefined) {
      if (refreshed.status === "running") {
        const runningWriteBack = currentWriteBack?.running;
        const shouldSyncStatus = runningWriteBack?.statusKey !== mapping.clickupStatus;

        if (shouldSyncStatus) {
          mergeRunningWriteBack({
            statusKey: mapping.clickupStatus,
            statusAttemptedAt: writeBackTimestamp,
          });

          await clickup.updateTaskMetadata(taskId, {
            status: mapping.clickupStatus,
            customFields: buildTaskWriteBackFields(next.task, updatedAt, links, {
              automation_state: mapping.automationState,
              last_error: "",
              run_id: runId,
              workboard_id: current.workboardCardId,
            }),
          });

          mergeRunningWriteBack({
            lastSyncedAt: writeBackTimestamp,
          });
        }

        const latestRunningWriteBack = state.getJob(taskId)?.clickupWriteBack?.running;
        if (comment !== undefined && latestRunningWriteBack?.commentKey !== comment) {
          mergeRunningWriteBack({
            commentKey: comment,
            commentAttemptedAt: writeBackTimestamp,
          });

          await clickup.postTaskComment(taskId, comment);
        }
      } else if (mapping.isTerminal) {
        const terminalWriteBack = currentWriteBack?.terminal;
        const shouldSyncStatus = terminalWriteBack?.statusKey !== refreshed.status;

        if (shouldSyncStatus) {
          mergeTerminalWriteBack({
            statusKey: refreshed.status,
            statusAttemptedAt: writeBackTimestamp,
            lastSyncedStatus: refreshed.status,
            lastSyncedAt: writeBackTimestamp,
          });

          await clickup.updateTaskMetadata(taskId, {
            status: mapping.clickupStatus,
            customFields: buildTaskWriteBackFields(next.task, updatedAt, links, {
              automation_state: mapping.automationState,
              last_error: refreshed.status === "blocked" ? buildOpenClawTerminalSummary("blocked", terminalContext) : "",
              run_id: runId,
              workboard_id: current.workboardCardId,
            }),
          });
        }

        const latestTerminalWriteBack = state.getJob(taskId)?.clickupWriteBack?.terminal;
        if (comment !== undefined && !terminalAlreadySynced && latestTerminalWriteBack?.commentKey !== comment) {
          mergeTerminalWriteBack({
            commentKey: comment,
            commentAttemptedAt: writeBackTimestamp,
          });

          await clickup.postTaskComment(taskId, comment);
        }
      }
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
      previousStatus: current.openClawCardStatus ?? null,
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
      (job) => job.workboardCardId !== undefined && job.bridgeState !== "synced_back",
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
    const autoPicked = shouldAutoPickTask({
      status: currentStatus,
      tags: mergedTags,
      automationAllowed: automationAllowed ?? undefined,
      rule: routing.rule,
      approvalRequired,
    });
    const effectiveApprovalRequired = automationAllowed === true ? false : approvalRequired === true;
    const currentJob = state.getJob(input.task.id);

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
      bridgeState:
        preserveBridgeState(currentJob?.bridgeState) ??
        (autoPicked || isEligibleForOpenClaw(currentStatus) ? "eligible" : "received"),
      claim: currentJob?.claim,
      handoffPayload: currentJob?.handoffPayload,
      workboardCardId: currentJob?.workboardCardId,
      openClawCardStatus: currentJob?.openClawCardStatus,
      handedOffAt: currentJob?.handedOffAt,
      dispatchedAt: currentJob?.dispatchedAt,
      idempotencyKey,
      retryCount: currentJob?.retryCount ?? 0,
      lastError: currentJob?.lastError,
      lastEventAt: receivedAt,
      updatedAt: receivedAt,
      events: currentJob?.events ?? [],
      blockedAt: currentJob?.blockedAt,
      claimedAt: currentJob?.claimedAt,
      terminalAt: currentJob?.terminalAt,
      outcome: currentJob?.outcome,
      deadLetteredAt: currentJob?.deadLetteredAt,
      deadLetterReason: currentJob?.deadLetterReason,
      workType,
      workflowTemplate: workflowTemplateText,
      decompositionPlan: decompositionText,
      triageReason,
      template: templateText,
    });

    const postIngestJob = state.getJob(input.task.id);
    if (postIngestJob?.bridgeState === "eligible" || postIngestJob?.bridgeState === "card_created") {
      await autoHandoffAndDispatchEligibleJob(input.task.id);
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
        updatedAt: event.updatedAt,
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
      openClawWatchIntervalMs,
      queueStallAlertMs,
      blockedEscalationMs,
    };
  }

  function getMetricsSnapshot(input?: { now?: string | undefined }) {
    const now = input?.now ?? nowIso();
    const jobs = state.listJobs();
    const queuedJobs = jobs.filter((job) => job.bridgeState === "eligible" || job.bridgeState === "card_created");
    const dispatchedJobs = jobs.filter((job) => job.bridgeState === "dispatched");
    const runningJobs = jobs.filter((job) => job.bridgeState === "dispatched" || job.openClawCardStatus === "running" || job.state === "running");
    const terminalJobs = jobs.filter((job) => {
      const status = job.openClawCardStatus ?? job.state;
      return status === "review" || status === "done" || status === "blocked";
    });
    const syncedBackJobs = jobs.filter((job) => job.bridgeState === "synced_back");

    const cardLifecycleCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      const status = job.openClawCardStatus ?? job.bridgeState;
      if (status === "eligible" || status === "card_created" || status === "dispatched" || status === "running" || status === "review" || status === "done" || status === "blocked" || status === "synced_back") {
        counts[status] = (counts[status] ?? 0) + 1;
      }
      return counts;
    }, {});

    const jobCounts = jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.state] = (counts[job.state] ?? 0) + 1;
      return counts;
    }, {});

    const averageDispatchToTerminalMs =
      terminalJobs.length === 0
        ? 0
        : Math.round(
            terminalJobs.reduce((sum, job) => {
              return sum + (Date.parse(job.terminalAt ?? now) - Date.parse(job.dispatchedAt ?? now));
            }, 0) / terminalJobs.length,
          );

    const oldestUnsyncedAgeMs =
      jobs.filter((job) => job.bridgeState !== "synced_back").length === 0
        ? 0
        : Math.max(
            ...jobs
              .filter((job) => job.bridgeState !== "synced_back")
              .map((job) => {
                const ageMs = Date.parse(now) - Date.parse(job.updatedAt);
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
    const handoffFailures = jobs.filter((job) => job.outcome === "failed" && job.dispatchedAt === undefined).length;
    const dispatchFailures = jobs.filter((job) => job.outcome === "failed" && job.dispatchedAt !== undefined).length;

    return {
      now,
      cardsQueued: queuedJobs.length,
      cardsCreated: jobs.filter((job) => job.bridgeState === "card_created").length,
      cardsDispatched: dispatchedJobs.length,
      cardsRunning: runningJobs.length,
      cardsTerminal: terminalJobs.length,
      cardsSyncedBack: syncedBackJobs.length,
      cardLifecycleCounts,
      jobCounts,
      workTypeCounts,
      priorityBucketCounts,
      autoPickedJobs,
      approvalRequiredJobs,
      syncLagMs: oldestUnsyncedAgeMs,
      throughput: {
        terminalCards: terminalJobs.length,
        succeededJobs,
        failedJobs,
        blockedJobs,
        deadLetteredJobs,
        dispatchFailures,
        handoffFailures,
      },
      latency: {
        averageDispatchToTerminalMs,
        oldestUnsyncedAgeMs,
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
    const activeCards = jobs
      .filter((job) => job.bridgeState === "dispatched" || job.openClawCardStatus === "running")
      .map((job) => ({
        taskId: job.task.id,
        workboardCardId: job.workboardCardId,
        status: job.openClawCardStatus ?? job.bridgeState,
        dispatchedAt: job.dispatchedAt,
        updatedAt: job.updatedAt,
      }));
    const queuedItems = jobs
      .filter((job) => job.bridgeState === "eligible" || job.bridgeState === "card_created")
      .map((job) => ({
        taskId: job.task.id,
        workboardCardId: job.workboardCardId,
        status: job.openClawCardStatus ?? job.bridgeState,
        requestedAt: job.updatedAt,
      }));
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
        cardsQueued: metrics.cardsQueued,
        cardsCreated: metrics.cardsCreated,
        cardsDispatched: metrics.cardsDispatched,
        cardsRunning: metrics.cardsRunning,
        cardsTerminal: metrics.cardsTerminal,
        cardsSyncedBack: metrics.cardsSyncedBack,
        queueStallAlertMs: metrics.thresholds.queueStallAlertMs,
        oldestUnsyncedAgeMs: metrics.latency.oldestUnsyncedAgeMs,
        stalled: metrics.latency.oldestUnsyncedAgeMs >= metrics.thresholds.queueStallAlertMs,
        jobCounts: metrics.jobCounts,
        cardLifecycleCounts: metrics.cardLifecycleCounts,
        workTypeCounts: metrics.workTypeCounts,
        priorityBucketCounts: metrics.priorityBucketCounts,
        autoPickedJobs: metrics.autoPickedJobs,
        approvalRequiredJobs: metrics.approvalRequiredJobs,
        cards: activeCards,
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

  return {
    logger,
    state,
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
    pauseWork,
    resumeWork,
    getControlState,
    openClawWatchIntervalMs,
    queueStallAlertMs,
    getMetricsSnapshot,
    getDashboardSnapshot,
    listJobs: () => state.listJobs(),
  };
}
