import type { ClickUpTask, PriorityBucket } from "@clickup-openclaw/shared";

type ClickUpClientOptions = {
  token: string;
  baseUrl?: string;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractStatusCode(error: unknown): number | undefined {
  const message = errorMessage(error);
  const matches = [
    /:\s*(\d{3})(?:\b|$)/,
    /\bstatus\s+(\d{3})\b/i,
    /\bHTTP\s+(\d{3})\b/i,
  ];

  for (const pattern of matches) {
    const match = message.match(pattern);
    if (match?.[1] !== undefined) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function isRetriableClickUpError(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "retriable" in error) {
    const retriable = (error as { retriable?: unknown }).retriable;
    if (typeof retriable === "boolean") {
      return retriable;
    }
  }

  const status = extractStatusCode(error);
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enetunreach") ||
    message.includes("eai_again") ||
    message.includes("etimedout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("temporary") ||
    message.includes("unavailable")
  );
}

export function createClickUpClient(options: ClickUpClientOptions) {
  const baseUrl = options.baseUrl ?? "https://api.clickup.com/api/v2";
  const retry = {
    maxAttempts: Math.max(1, options.retry?.maxAttempts ?? 3),
    baseDelayMs: Math.max(0, options.retry?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(options.retry?.maxDelayMs ?? 2000, 0),
  };

  const headers = {
    Authorization: options.token,
    "Content-Type": "application/json",
  };

  function isRetriableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function requestWithRetry<T>(
    taskId: string,
    action: string,
    request: () => Promise<Response>,
    parse: (response: Response) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await request();
      } catch (error) {
        if (!isRetriableClickUpError(error) || attempt === retry.maxAttempts) {
          throw error instanceof Error
            ? error
            : new Error(`Failed to ${action} ClickUp task ${taskId}`);
        }

        const delayMs = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
        await sleep(delayMs);
        continue;
      }

      if (response.ok) {
        return await parse(response);
      }

      if (!isRetriableStatus(response.status) || attempt === retry.maxAttempts) {
        throw new Error(`Failed to ${action} ClickUp task ${taskId}: ${response.status}`);
      }

      const delayMs = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
      await sleep(delayMs);
    }

    throw new Error(`Failed to ${action} ClickUp task ${taskId}`);
  }

  async function updateTask(taskId: string, body: Record<string, unknown>): Promise<void> {
    await requestWithRetry(taskId, "update", () =>
      fetch(`${baseUrl}/task/${taskId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      }),
    async () => undefined);
  }

  function parseBooleanField(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "no" || normalized === "0") {
        return false;
      }
    }

    return undefined;
  }

function parseNumberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function parsePriorityBucket(value: unknown): PriorityBucket | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "low" || normalized === "normal" || normalized === "high" || normalized === "urgent"
    ? normalized
    : undefined;
}

  return {
    async getTask(taskId: string): Promise<ClickUpTask> {
      return requestWithRetry(
        taskId,
        "fetch",
        () => fetch(`${baseUrl}/task/${taskId}`, { headers }),
        async (response) => {
          const body = (await response.json()) as {
            id: string;
            name: string;
            status: { status: string };
            list?: { id: string };
            priority?: string;
            description?: string;
            date_updated?: string;
            updated_at?: string;
            custom_fields?: Array<{ id: string; value?: unknown }>;
          };
          const repoUrlField = body.custom_fields?.find((field) => field.id === "repo_url");
          const prUrlField = body.custom_fields?.find((field) => field.id === "pr_url");
          const artifactUrlField = body.custom_fields?.find((field) => field.id === "artifact_url");
          const docsUrlField = body.custom_fields?.find((field) => field.id === "docs_url");
          const designUrlField = body.custom_fields?.find((field) => field.id === "design_url");
          const workTypeField = body.custom_fields?.find((field) => field.id === "work_type");
          const projectKeyField = body.custom_fields?.find((field) => field.id === "project_key");
          const automationAllowedField = body.custom_fields?.find(
            (field) => field.id === "automation_allowed",
          );
          const approvalRequiredField = body.custom_fields?.find(
            (field) => field.id === "approval_required",
          );
          const triageReasonField = body.custom_fields?.find((field) => field.id === "triage_reason");
          const branchNameField = body.custom_fields?.find((field) => field.id === "branch_name");
          const commitShaField = body.custom_fields?.find((field) => field.id === "commit_sha");
          const commitUrlField = body.custom_fields?.find((field) => field.id === "commit_url");
          const prNumberField = body.custom_fields?.find((field) => field.id === "pr_number");

          return {
            id: body.id,
            name: body.name,
            status: body.status.status,
            listId: body.list?.id,
            projectKey: typeof projectKeyField?.value === "string" ? projectKeyField.value : undefined,
            workType: typeof workTypeField?.value === "string" ? workTypeField.value : undefined,
            automationAllowed: parseBooleanField(automationAllowedField?.value),
            approvalRequired: parseBooleanField(approvalRequiredField?.value),
            priorityBucket: parsePriorityBucket(body.priority),
            branchName: typeof branchNameField?.value === "string" ? branchNameField.value : undefined,
            commitSha: typeof commitShaField?.value === "string" ? commitShaField.value : undefined,
            commitUrl: typeof commitUrlField?.value === "string" ? commitUrlField.value : undefined,
            prNumber: parseNumberField(prNumberField?.value),
            triageReason:
              typeof triageReasonField?.value === "string" ? triageReasonField.value : undefined,
            updatedAt: body.date_updated ?? body.updated_at,
            priority: body.priority,
            description: body.description,
            repoUrl: typeof repoUrlField?.value === "string" ? repoUrlField.value : undefined,
            prUrl: typeof prUrlField?.value === "string" ? prUrlField.value : undefined,
            artifactUrl:
              typeof artifactUrlField?.value === "string" ? artifactUrlField.value : undefined,
            docsUrl: typeof docsUrlField?.value === "string" ? docsUrlField.value : undefined,
            designUrl: typeof designUrlField?.value === "string" ? designUrlField.value : undefined,
          };
        },
      );
    },

    async postTaskComment(taskId: string, comment: string): Promise<void> {
      await requestWithRetry(
        taskId,
        "comment on",
        () =>
          fetch(`${baseUrl}/task/${taskId}/comment`, {
            method: "POST",
            headers,
            body: JSON.stringify({ comment_text: comment }),
          }),
        async () => undefined,
      );
    },

    async updateTaskStatus(taskId: string, status: string): Promise<void> {
      await updateTask(taskId, { status });
    },

    async getListTasks(listId: string): Promise<ClickUpTask[]> {
      const tasks: ClickUpTask[] = [];
      let page = 0;

      while (true) {
        const response = await requestWithRetry(
          listId,
          "fetch list tasks from",
          () => fetch(`${baseUrl}/list/${listId}/task?page=${page}`, { headers }),
          async (response) => {
            const body = (await response.json()) as
              | {
                  tasks?: Array<{
                    id: string;
                    name: string;
                    status: { status: string };
                    list?: { id: string };
                    priority?: string;
                    description?: string;
                    date_updated?: string;
                    updated_at?: string;
                    custom_fields?: Array<{ id: string; value?: unknown }>;
                  }>;
                  last_page?: boolean;
                }
              | Array<{
                  id: string;
                  name: string;
                  status: { status: string };
                  list?: { id: string };
                  priority?: string;
                  description?: string;
                  date_updated?: string;
                  updated_at?: string;
                  custom_fields?: Array<{ id: string; value?: unknown }>;
                }>;

            const pageTasks = Array.isArray(body) ? body : body.tasks ?? [];
            for (const taskBody of pageTasks) {
              tasks.push(
                {
                  id: taskBody.id,
                  name: taskBody.name ?? taskBody.id,
                  status: taskBody.status?.status ?? "unknown",
                  listId: taskBody.list?.id,
                  priority: taskBody.priority,
                  description: taskBody.description,
                  updatedAt: taskBody.date_updated ?? taskBody.updated_at,
                } as ClickUpTask,
              );
            }

            return {
              lastPage: Array.isArray(body) ? true : body.last_page ?? true,
            };
          },
        );

        if (response.lastPage) {
          break;
        }

        page += 1;
      }

      return tasks;
    },

    async updateTaskMetadata(
      taskId: string,
      input: { status?: string; customFields?: Record<string, unknown> },
    ): Promise<void> {
      const body: Record<string, unknown> = {};

      if (input.status !== undefined) {
        body.status = input.status;
      }

      if (input.customFields !== undefined) {
        body.custom_fields = Object.entries(input.customFields).map(([id, value]) => ({
          id,
          value,
        }));
      }

      await updateTask(taskId, body);
    },
  };
}
