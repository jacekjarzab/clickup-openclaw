export function createClickUpClient(options) {
    const baseUrl = options.baseUrl ?? "https://api.clickup.com/api/v2";
    const headers = {
        Authorization: options.token,
        "Content-Type": "application/json",
    };
    async function updateTask(taskId, body) {
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
            await updateTask(taskId, { status });
        },
        async updateTaskMetadata(taskId, input) {
            const body = {};
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
