# OpenClaw Bridge Technical Spec

## Purpose

Define the private bridge that connects ClickUp events to the existing local OpenClaw Gateway while keeping the system safe, idempotent, and observable.

## Scope

- Ingest ClickUp events
- Poll ClickUp as fallback
- Normalize eligible tasks into Bridge job records
- Create and dispatch OpenClaw Workboard cards
- Report results back to ClickUp
- Handle retries, failures, and reconciliation

## Contract Summary

Bridge owns orchestration state and OpenClaw owns execution state.

- Bridge writes a Workboard card contract with:
  - `title`
  - `notes`
  - `status`
  - `priority`
  - `labels`
  - optional `agentId` for future dedicated-agent routing
  - optional `boardId`
  - stable `idempotencyKey`
- Bridge also keeps machine metadata alongside that card contract:
  - `sourceSystem = clickup`
  - `clickupTaskId`
  - `clickupStatus`
  - `projectKey`
  - `workType`
  - `routingKey`
  - `automationAllowed`
  - `approvalRequired`
  - `priorityBucket`
  - useful artifact links already known at handoff time
- OpenClaw Workboard returns runtime truth:
  - card status
  - execution summary
  - proof
  - artifacts
  - blocker reason

## Core Services

- Bridge API
  - private ingress
  - webhook receiver
  - no explicit auth in the current local-only service
- Sync Service
  - event normalization
  - task reconciliation
  - ClickUp write-back
- OpenClaw Adapter
  - local `openclaw workboard` CLI wrapper
  - card creation, show, list, and dispatch commands
- Workboard Watcher
  - reads card state
  - detects terminal outcomes
  - syncs status back to ClickUp today
  - summary, proof, artifact, and blocker-context enrichment is still planned
- State Store
  - task-to-card mappings
  - idempotency keys
  - sync timestamps
  - execution history

## Data Flow

1. ClickUp emits a webhook or the poller detects a change.
2. Bridge API receives the event.
3. Sync Service deduplicates it.
4. Sync Service checks whether the task is automation-eligible.
5. Sync Service maps the task to a Bridge job record.
6. OpenClaw Adapter creates the matching Workboard card once, then reuses the stored mapping on later syncs.
7. OpenClaw Adapter triggers Workboard dispatch.
8. The default OpenClaw agent picks up the card and performs the work.
9. Workboard Watcher reads card state until a terminal result is reached.
10. Bridge posts the final outcome to ClickUp.
11. State Store keeps the audit trail.

## Bridge States

- `received`
- `eligible`
- `card_created`
- `dispatched`
- `running`
- `blocked`
- `completed`
- `synced_back`

Workboard card statuses are tracked separately as `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, and `done`.

## Status Mapping

- `triage` in Workboard maps to ClickUp `triage` with `automation_state=candidate`
- `backlog`, `todo`, `scheduled`, and `ready` map to ClickUp `ready for openclaw` with `automation_state=candidate`
- `running` maps to ClickUp `in progress` with `automation_state=running`
- `review` maps to ClickUp `approval` with `automation_state=done`
- `blocked` maps to ClickUp `blocked` with `automation_state=blocked`
- `done` maps to ClickUp `approval` with `automation_state=done`

Successful OpenClaw completion does not move ClickUp directly to `done` in v1.

## Idempotency Rules

- Every ClickUp event gets a stable idempotency key.
- Every Bridge job maps to one durable Workboard card id.
- Duplicate events must not create duplicate cards.
- Duplicate write-backs must not duplicate comments or status updates.

## Reconciliation Rules

- Before creating a new card, Bridge must check its stored ClickUp to Workboard mapping.
- If mapping exists, Bridge should read the current card instead of creating another one.
- If the Gateway or Bridge restarts mid-run, Bridge must re-read Workboard state and resume syncing.
- Terminal Workboard cards should not be re-dispatched unless a human explicitly requeues the task.

## Failure Handling

- Webhook failure
  - fallback polling covers the gap.
- Local OpenClaw command failure
  - retry with backoff and record the error.
- Gateway unavailable
  - do not create duplicate state; reconcile and retry once the Gateway is healthy.
- OpenClaw crash or blocked run
  - read Workboard terminal state and write the reason back to ClickUp.
- Permanent failure
  - mark the task blocked or approval with the reason attached.

## Reporting Contract

On queue:

- no comment is posted today

On running:

- status to `in progress`
- comment: `OpenClaw started work on this task.`

On success:

- status to `approval`
- terminal comment based on observed Workboard status
- proof and artifact link enrichment is still planned

On failure:

- status to `blocked` or the agreed review fallback
- concise blocker/status summary
- next-step recommendation is still planned

## Security and Network Assumptions

- Bridge and OpenClaw run on the same host for v1.
- Gateway stays loopback-only or private behind Tailscale.
- ClickUp credentials stay server-side.
- Bridge does not expose Gateway control surfaces publicly.
- The first transport is local CLI, not public HTTP RPC.

## Observability

Track at minimum:

- event receive count
- dedupe hit count
- eligible task count
- card created count
- dispatch count
- running card count
- terminal card count
- synced-back count
- blocked card count
- sync lag
- dispatch and handoff failure count
- average processing time

## Implementation Notes

- Keep the first version boring.
- Reuse the existing local OpenClaw Gateway and Workboard plugin.
- Use the default OpenClaw agent for now.
- Prefer explicit ClickUp status transitions over hidden automation.
- Keep ClickUp write-back a first-class feature, not an afterthought.
- Consider WebSocket RPC only after the CLI-based path is stable.
