# clickup-openclaw

Private ClickUp + OpenClaw integration for controlled task automation.

Current execution path:

- ClickUp task enters the agreed automation-ready path
- Bridge normalizes and persists the job
- Bridge creates and dispatches an OpenClaw Workboard card
- OpenClaw processes it with the default agent
- Bridge syncs status back to ClickUp and returns successful work to `human-review`

## Layout

- `apps/bridge` - ClickUp webhooks, polling, auth, event normalization
- `packages/shared` - shared types, schemas, constants
- `packages/clickup-client` - ClickUp API wrapper
- `packages/state` - persistence layer and migrations
- `packages/observability` - logs, metrics, tracing helpers
