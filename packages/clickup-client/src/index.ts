import type { ClickUpTask } from "@clickup-openclaw/shared";

type ClickUpClientOptions = {
  token: string;
  baseUrl?: string;
};

export function createClickUpClient(options: ClickUpClientOptions) {
  const baseUrl = options.baseUrl ?? "https://api.clickup.com/api/v2";

  const headers = {
    Authorization: options.token,
    "Content-Type": "application/json",
  };

  async function updateTask(taskId: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${baseUrl}/task/${taskId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Failed to update ClickUp task ${taskId}: ${response.status}`);
    }
  }

  return {
    async getTask(taskId: string): Promise<ClickUpTask> {
      const response = await fetch(`${baseUrl}/task/${taskId}`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch ClickUp task ${taskId}: ${response.status}`);
      }

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

      return {
        id: body.id,
        name: body.name,
        status: body.status.status,
        listId: body.list?.id,
        priority: body.priority,
        description: body.description,
        repoUrl: typeof repoUrlField?.value === "string" ? repoUrlField.value : undefined,
        prUrl: typeof prUrlField?.value === "string" ? prUrlField.value : undefined,
        artifactUrl: typeof artifactUrlField?.value === "string" ? artifactUrlField.value : undefined,
        docsUrl: typeof docsUrlField?.value === "string" ? docsUrlField.value : undefined,
        designUrl: typeof designUrlField?.value === "string" ? designUrlField.value : undefined,
        tags: body.tags?.map((tag) => tag.name) ?? [],
      };
    },

    async postTaskComment(taskId: string, comment: string): Promise<void> {
      const response = await fetch(`${baseUrl}/task/${taskId}/comment`, {
        method: "POST",
        headers,
        body: JSON.stringify({ comment_text: comment }),
      });

      if (!response.ok) {
        throw new Error(`Failed to comment on ClickUp task ${taskId}: ${response.status}`);
      }
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
