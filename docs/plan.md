# ClickUp + OpenClaw Integration Plan

## Goal
Use ClickUp as the single source of truth while Bridge routes only automation-eligible tasks into the existing local OpenClaw Gateway. OpenClaw Workboard owns execution and runtime visibility, and Bridge writes terminal outcomes back to ClickUp for human review.

## Target Workflow
- ClickUp manages tasks, statuses, and human-visible history.
- Bridge watches ClickUp for automation-eligible tasks only.
- Bridge creates a matching OpenClaw Workboard card once and then reuses the stored card mapping.
- Bridge triggers OpenClaw Workboard dispatch through the local host runtime.
- The default OpenClaw agent picks up and processes the card.
- Bridge watches Workboard state and writes the outcome back to ClickUp:
  - status updates
  - status-based comments
  - blocker or failure context
  - proof and useful links once enrichment is added

## Proposed Architecture
- ClickUp sync layer
  - Watches ClickUp for new or changed tasks.
  - Filters out tasks that should not be automated.
  - Normalizes eligible tasks into Bridge job records.
- Bridge orchestrator
  - Owns idempotency, task-to-card mapping, and dispatch decisions.
  - Creates Workboard cards through the local `openclaw workboard` CLI and reuses stored mappings on later syncs.
  - Polls or reconciles Workboard state and pushes results back to ClickUp.
- OpenClaw Workboard
  - Owns queue state, runtime status, proof, and completion metadata.
  - Provides the live operator UI in OpenClaw Control UI.
- Local bridge host
  - Runs on the same machine as the local OpenClaw Gateway.
  - Talks to OpenClaw over loopback or same-host CLI.

## Task Lifecycle
- ClickUp `ready for automation`
- Bridge `normalized`
- Workboard `todo` or `ready`
- Workboard `running`
- Workboard `blocked`
- Workboard `review` or `done`
- ClickUp `human-review`

## ClickUp Data Model
Recommended custom fields and metadata:
- `automation_state`
- `run_id`
- `workboard_id`
- `repo_url`
- `pr_url`
- `last_sync_at`
- `last_error`

## Workspace Shape
Use a boring, explicit hierarchy:
- Space: `Clients`
- Folder: one per client
- List: one per project or engagement
- Task: one work item
- Subtask: only for decomposed steps

That gives Bridge a stable place to sync from without inventing extra structure.

## Workboard Contract
Bridge should write:
- stable card title
- normalized task snapshot in notes
- labels for project and source metadata only
- priority mapped from ClickUp
- idempotency key derived from ClickUp task id

Bridge should read back:
- card status
- execution summary
- proof and artifacts
- blocker reason

## Reporting Back to ClickUp
On handoff:
- no comment is posted today

On running:
- comment: `OpenClaw started work on this task`
- status: `in progress`

During work:
- optional progress comments only when they add value or expose a blocker

On finish:
- terminal comment based on observed Workboard status
- proof and link enrichment remains planned
- status: `human-review`

On failure or blocked work:
- concise blocker/status summary
- next-step note remains planned
- status: `blocked` or the agreed fallback review status

## Error Handling
- Gateway restart or temporary unavailability
  - Bridge retries the local OpenClaw command path and reconciles existing Workboard state before creating anything new.
- Duplicate ClickUp events
  - Bridge uses idempotency keys and stored card mappings.
- Dispatch failure
  - Bridge records the failure, retries safely, and does not create duplicate cards.
- Partial success
  - keep the useful output
  - move unresolved work to human review or blocked with context
- External failures
  - retry transient API or CLI issues before failing the handoff

## MVP Scope
- One-way ingestion from ClickUp for automation-eligible tasks
- Local CLI-based Bridge to Workboard integration
- Workboard dispatch through the existing local OpenClaw Gateway
- Status sync back to ClickUp
- Status-based comments back to ClickUp
- Basic error reporting and reconciliation

## Phase 2
- Replace or supplement CLI polling with a WebSocket RPC client
- Add lower-latency event-driven Workboard sync
- Add richer per-project routing rules
- Add human approval gates for risky actions
- Add metrics for card lifecycle throughput, failures, and sync lag

## Early Decisions
- The default OpenClaw agent handles Bridge work for now.
- Only the existing automation-eligible ClickUp tasks are handed off.
- Completed OpenClaw work returns to ClickUp as `human-review`.
- Progress comments should stay lightweight unless there is a blocker.

## Recommendation
Start with a boring, reliable v1:
- Keep ClickUp as the source of truth.
- Keep Bridge as the orchestrator and mapping layer.
- Reuse the existing local OpenClaw Gateway and Workboard plugin.
- Use the local `openclaw workboard` CLI as the first transport.
- Move successful runs to `human-review`, not straight to done.
