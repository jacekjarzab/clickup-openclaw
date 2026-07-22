import type { ClickUpTask } from "@clickup-openclaw/shared";

type ClickUpClientOptions = {
  token: string;
  baseUrl?: string;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

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
        if (attempt === retry.maxAttempts) {
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
            tags?: Array<{ name: string }>;
            custom_fields?: Array<{ id: string; value?: unknown }>;
          };
          const repoUrlField = body.custom_fields?.find((field) => field.id === "repo_url");
          const prUrlField = body.custom_fields?.find((field) => field.id === "pr_url");
          const artifactUrlField = body.custom_fields?.find((field) => field.id === "artifact_url");
          const docsUrlField = body.custom_fields?.find((field) => field.id === "docs_url");
          const designUrlField = body.custom_fields?.find((field) => field.id === "design_url");
          const workTypeField = body.custom_fields?.find((field) => field.id === "work_type");

          return {
            id: body.id,
            name: body.name,
            status: body.status.status,
            listId: body.list?.id,
            workType: typeof workTypeField?.value === "string" ? workTypeField.value : undefined,
            priority: body.priority,
            description: body.description,
            repoUrl: typeof repoUrlField?.value === "string" ? repoUrlField.value : undefined,
            prUrl: typeof prUrlField?.value === "string" ? prUrlField.value : undefined,
            artifactUrl:
              typeof artifactUrlField?.value === "string" ? artifactUrlField.value : undefined,
            docsUrl: typeof docsUrlField?.value === "string" ? docsUrlField.value : undefined,
            designUrl: typeof designUrlField?.value === "string" ? designUrlField.value : undefined,
            tags: body.tags?.map((tag) => tag.name) ?? [],
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
