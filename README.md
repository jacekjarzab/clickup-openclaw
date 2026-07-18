# clickup-openclaw

Private ClickUp + OpenClaw integration for controlled task automation.

## Layout

- `apps/bridge` - ClickUp webhooks, polling, auth, event normalization
- `apps/worker` - task execution runtime
- `apps/reporter` - ClickUp write-back for status/comments/links
- `packages/shared` - shared types, schemas, constants
- `packages/clickup-client` - ClickUp API wrapper
- `packages/workboard` - claim/lease/queue logic
- `packages/state` - persistence layer and migrations
- `packages/observability` - logs, metrics, tracing helpers

