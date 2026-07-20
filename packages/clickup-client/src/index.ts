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
      };

      return {
        id: body.id,
        name: body.name,
        status: body.status.status,
        listId: body.list?.id,
        priority: body.priority,
        description: body.description,
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
      const response = await fetch(`${baseUrl}/task/${taskId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update ClickUp task ${taskId}: ${response.status}`);
      }
    },
  };
}
