import { createClickUpClient } from "@clickup-openclaw/clickup-client";
import { createLogger } from "@clickup-openclaw/observability";
import {
  claimRecordSchema,
  clickupWebhookEventSchema,
  type ClickUpTask,
  type PriorityBucket,
  workerEventSchema,
  workboardStateSchema,
} from "@clickup-openclaw/shared";
import { InMemoryStateStore } from "@clickup-openclaw/state";
import { InMemoryWorkboard } from "@clickup-openclaw/workboard";
import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "./config.js";
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
};

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
    };
  }

  return templates;
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

function buildClaimComment(templateText?: string): string {
  const lines = ["Claimed by OpenClaw, starting work."];

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
  const state = new InMemoryStateStore();
  const workboard = new InMemoryWorkboard();
  let paused = false;
  const defaultProjectKey = config.DEFAULT_PROJECT_KEY;
  const repoUrl = resolveRepoUrl(config);
  const prUrl = config.PR_URL ?? config.CLICKUP_PR_URL;
  const artifactUrl = config.ARTIFACT_URL ?? config.CLICKUP_ARTIFACT_URL;
  const docsUrl = config.DOCS_URL ?? config.CLICKUP_DOCS_URL;
  const designUrl = config.DESIGN_URL ?? config.CLICKUP_DESIGN_URL;
  const heartbeatMonitorIntervalMs = Number(config.HEARTBEAT_MONITOR_INTERVAL_MS ?? "60000");
  const queueStallAlertMs = toNumber(config.QUEUE_STALL_ALERT_MS, 10 * 60 * 1000);
  const projectRoutingRules = parseProjectRoutingRules(config.PROJECT_ROUTING_JSON);
  const workTypeTemplates = parseWorkTypeTemplates(config.WORK_TYPE_TEMPLATES_JSON);
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

  async function writeClaimSideEffects(taskId: string, runId: string, claimWorkboardId: string, now: string) {
    if (clickup === undefined) {
      return;
    }

    const job = state.getJob(taskId);
    const projectKey = job?.task.projectKey ?? job?.task.routingKey;
    const links = resolveArtifactLinks(projectKey, artifactLinks, projectRoutingRules);

    await clickup.postTaskComment(taskId, buildClaimComment(job?.template));
    await clickup.updateTaskMetadata(taskId, {
      status: "in progress",
      customFields: buildTaskWriteBackFields(job?.task ?? {}, now, links, {
        run_id: runId,
        workboard_id: claimWorkboardId,
        automation_state: "claimed",
      }),
    });
  }

  async function ingestWebhook(input: unknown) {
    const event = clickupWebhookEventSchema.parse(input);
    const idempotencyKey = deriveIdempotencyKey(event);
    const receivedAt = nowIso();

    if (state.hasIdempotencyKey(idempotencyKey)) {
      logger.info("webhook duplicate ignored", { event: event.event, taskId: event.taskId });
      return { accepted: true, duplicate: true };
    }

    state.recordIdempotency({
      key: idempotencyKey,
      taskId: event.taskId,
      event: event.event,
      firstSeenAt: receivedAt,
      lastSeenAt: receivedAt,
    });

    logger.info("webhook received", { event: event.event, taskId: event.taskId });

    const fetchedTask = clickup === undefined ? undefined : await clickup.getTask(event.taskId).catch((error: unknown) => {
      logger.warn("failed to fetch task details during ingest", {
        taskId: event.taskId,
        error: String(error),
      });
      return undefined;
    });
    const payloadRecord =
      event.payload !== undefined && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const payloadWorkType = extractPayloadWorkType(payloadRecord);
    const payloadTags = extractPayloadTags(payloadRecord);
    const payloadProjectKey = extractPayloadProjectKey(payloadRecord);
    const payloadPriorityBucket = extractPayloadPriorityBucket(payloadRecord);
    const payloadAutomationAllowed = extractPayloadAutomationAllowed(payloadRecord);
    const payloadApprovalRequired = extractPayloadApprovalRequired(payloadRecord);
    const mergedTags = [...new Set([...(fetchedTask?.tags ?? []), ...payloadTags])];
    const taggedWorkType = mergedTags.length > 0 ? findTemplateByTagMatch(mergedTags, workTypeTemplates) : undefined;
    const currentStatus = fetchedTask?.status ?? event.status ?? "unknown";
    const routing = resolveRoutingRule(
      {
        projectKey: fetchedTask?.projectKey ?? payloadProjectKey ?? defaultProjectKey,
        listId: fetchedTask?.listId ?? event.listId,
        status: currentStatus,
        tags: mergedTags,
      },
      projectRoutingRules,
    );
    const projectKey =
      routing.projectKey ?? fetchedTask?.projectKey ?? payloadProjectKey ?? defaultProjectKey;
    const automationAllowed =
      fetchedTask?.automationAllowed ?? payloadAutomationAllowed ?? undefined;
    const approvalRequired =
      fetchedTask?.approvalRequired ??
      payloadApprovalRequired ??
      (normalizeStatus(currentStatus) === "triage" ||
      normalizeTags(mergedTags).includes("needs-human") ||
      normalizeTags(mergedTags).includes("needs-review")
        ? true
        : undefined);
    const workTypeSource =
      payloadWorkType ??
      fetchedTask?.workType ??
      routing.rule?.workType ??
      taggedWorkType ??
      defaultWorkType ??
      "";
    const normalizedWorkType = normalizeKey(workTypeSource);
    const workType = normalizedWorkType.length > 0 ? normalizedWorkType : undefined;
    const template = workType === undefined ? undefined : workTypeTemplates[workType];
    const templateText =
      workType !== undefined && template !== undefined ? renderTaskTemplate(workType, template) : undefined;
    const priorityBucket = determinePriorityBucket({
      clickupPriority: fetchedTask?.priority,
      taskBucket: payloadPriorityBucket ?? fetchedTask?.priorityBucket,
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
        id: fetchedTask?.id ?? event.taskId,
        name: fetchedTask?.name ?? event.taskId,
        status: currentStatus,
        listId: fetchedTask?.listId ?? event.listId,
        projectKey: typeof projectKey === "string" ? projectKey : undefined,
        routingKey: routing.projectKey,
        workType,
        priorityBucket,
        automationAllowed,
        approvalRequired: effectiveApprovalRequired,
        autoPicked,
        priority: fetchedTask?.priority,
        description: fetchedTask?.description,
        repoUrl: fetchedTask?.repoUrl ?? repoUrl,
        prUrl: fetchedTask?.prUrl ?? prUrl,
        branchName: fetchedTask?.branchName,
        commitSha: fetchedTask?.commitSha,
        commitUrl: fetchedTask?.commitUrl,
        prNumber: fetchedTask?.prNumber,
        artifactUrl: fetchedTask?.artifactUrl ?? artifactUrl,
        docsUrl: fetchedTask?.docsUrl ?? docsUrl,
        designUrl: fetchedTask?.designUrl ?? designUrl,
        tags: mergedTags,
      },
      state:
        autoPicked && effectiveApprovalRequired !== true
          ? "eligible"
          : isEligibleForOpenClaw(currentStatus)
            ? "eligible"
            : "normalized",
      claim: undefined,
      idempotencyKey,
      retryCount: 0,
      lastError: undefined,
      lastEventAt: receivedAt,
      updatedAt: receivedAt,
      events: [],
      workType,
      template: templateText,
    });

    if ((autoPicked || isEligibleForOpenClaw(currentStatus)) && effectiveApprovalRequired !== true) {
      workboard.enqueue({
        taskId: event.taskId,
        priority: priorityScore,
        requestedAt: receivedAt,
        idempotencyKey,
      });
    }

    return { accepted: true, duplicate: false };
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
      queueStallAlertMs,
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

    return { now, reclaimed, notified };
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
        await clickup.updateTaskMetadata(taskId, {
          status:
            input.outcome === "succeeded"
              ? "done"
              : input.outcome === "blocked"
                ? "blocked"
                : "failed",
          customFields: buildTaskWriteBackFields(current.task, completedAt, links, {
            automation_state:
              input.outcome === "succeeded"
                ? "done"
                : input.outcome === "blocked"
                  ? "blocked"
                  : "manual",
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
      terminalAt: undefined,
      outcome: undefined,
      lastError: input.reason,
      updatedAt: now,
    });

    try {
      if (clickup !== undefined) {
        await clickup.postTaskComment(taskId, `Forced into review by OpenClaw: ${input.reason}`);
        await clickup.updateTaskMetadata(taskId, {
          status: "review",
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
    ingestWebhook,
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
    queueStallAlertMs,
    getMetricsSnapshot,
    getDashboardSnapshot,
    listJobs: () => state.listJobs(),
  };
}
