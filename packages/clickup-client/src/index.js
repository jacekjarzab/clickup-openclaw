export function createClickUpClient(options) {
    const baseUrl = options.baseUrl ?? "https://api.clickup.com/api/v2";
    const headers = {
        Authorization: options.token,
        "Content-Type": "application/json",
    };
    return {
        async getTask(taskId) {
            const response = await fetch(`${baseUrl}/task/${taskId}`, { headers });
            if (!response.ok) {
                throw new Error(`Failed to fetch ClickUp task ${taskId}: ${response.status}`);
            }
            const body = (await response.json());
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
        async postTaskComment(taskId, comment) {
            const response = await fetch(`${baseUrl}/task/${taskId}/comment`, {
                method: "POST",
                headers,
                body: JSON.stringify({ comment_text: comment }),
            });
            if (!response.ok) {
                throw new Error(`Failed to comment on ClickUp task ${taskId}: ${response.status}`);
            }
        },
        async updateTaskStatus(taskId, status) {
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
