# ClickUp + OpenClaw Backlog Checklist

This is the living build checklist. Update it as we complete items and discover new work.

## Phase 0: Foundations

- [ ] Confirm ClickUp workspace structure
  - Space: `Clients`
  - Folder: one per client
  - List: one per project or engagement
  - Task: one work item
  - Subtask: only for decomposed steps
  - Confirm the status + field mapping before broad sync
- [x] Lock the automation-eligible task filter already agreed for Bridge
- [x] Define the ClickUp statuses Bridge may consume and write back
- [x] Confirm the target human-review status in ClickUp
- [x] Verify the local OpenClaw Gateway and Workboard plugin runtime on the Bridge host
- [x] Keep the private bridge path behind Tailscale or loopback-only access

## Phase 1: ClickUp Ingestion and Normalization

- [x] Receive ClickUp webhook events
  - Keep webhook delivery idempotent
  - Poll as reconciliation fallback
- [x] Poll ClickUp as a fallback reconciliation path
- [x] Normalize eligible tasks into Bridge job records
- [x] Store idempotency keys for every event
- [x] Ignore non-automation tasks without side effects
- [x] Write back sync timestamps and last error values

## Phase 2: Bridge to Workboard Handoff

- [x] Create an OpenClaw adapter in Bridge using the local `openclaw workboard` CLI
- [ ] Create Workboard cards only for automation-eligible ClickUp tasks
- [ ] Use a stable idempotency key derived from the ClickUp task id
- [ ] Persist the ClickUp task id to Workboard card id mapping
- [ ] Attach normalized task context to the card title, notes, labels, and priority
- [ ] Trigger `openclaw workboard dispatch` after eligible card creation or update

## Phase 3: OpenClaw Execution Lifecycle

- [x] Let the default OpenClaw agent process Workboard cards
- [ ] Treat Workboard claim, heartbeat, blocking, and completion as execution truth
- [ ] Read Workboard card state and linked run data from Bridge
- [ ] Detect terminal states: `review`, `done`, `blocked`
- [ ] Capture worker summary, proof, artifacts, comments, and blocker context
- [ ] Handle Gateway restarts or stale claims by re-reading Workboard state before retrying Bridge actions

## Phase 4: ClickUp Write-Back

- [ ] Post a start comment to the ClickUp task when Bridge observes Workboard execution start
- [ ] Move the task to ClickUp `in progress` when Workboard enters `running`
- [x] Move the task to ClickUp `human-review` when OpenClaw finishes successfully
- [ ] Post completion summaries with proof and useful artifact links
- [ ] Post blocked or failure summaries with concise next-step context
- [ ] Prevent duplicate comments or duplicate terminal updates

## Phase 5: Status Mapping and Contract Hardening

- [x] Finalize the Bridge to Workboard card payload contract
- [x] Finalize the Workboard to ClickUp status mapping table
- [ ] Define what Bridge writes into ClickUp custom fields such as `run_id`, `workboard_id`, and sync metadata
- [ ] Define how retries behave for duplicate webhook delivery, CLI failure, and temporary Gateway unavailability
- [ ] Define which terminal outcomes require human review versus blocked status

## Phase 6: Reliability

- [ ] Add retry policy for transient ClickUp, Gateway, or CLI failures
- [ ] Add dead-letter handling for repeated handoff failures
- [ ] Add detection for stale Workboard claims and interrupted runs
- [ ] Add visibility into dispatch failures, queue stalls, and sync lag
- [ ] Add restart-safe reconciliation so Bridge can resume after crashes without duplicate card creation

## Phase 7: Operator Controls

- [ ] Add manual re-dispatch for eligible cards
- [ ] Add a force-sync path from Workboard back to ClickUp
- [ ] Add a requeue path for tasks returned from review or failure
- [ ] Add a mark-blocked path with reason text
- [ ] Add a force-human-review path when OpenClaw output should be inspected without further automation

## Phase 8: Quality and Scale

- [ ] Support multiple ClickUp lists, folders, or projects with the same Bridge rules
- [ ] Support per-project routing labels and metadata on Workboard cards
- [ ] Add dashboards for queue health, sync lag, and completion rates
- [ ] Add reporting for throughput and blocked-task categories
- [ ] Evaluate a phase-2 WebSocket RPC transport to replace or supplement CLI polling

## Replaced or Removed Work

- [x] Remove the old Phase 11 always-on worker runtime concept
  - OpenClaw Gateway is already the always-on runtime
  - Bridge should connect to the existing local Gateway, not invent a new daemon
- [x] Remove Bridge-owned claim and lease logic from the plan
  - Workboard owns claims, heartbeats, blocking, and completion
- [x] Remove the custom worker-runner architecture from the plan
  - The default OpenClaw agent is the worker path for now

## Immediate Next Steps

- [x] Draft the Bridge to Workboard card payload contract
- [x] Draft the Workboard to ClickUp status mapping table
- [x] Implement the local `openclaw workboard` CLI adapter in Bridge
- [ ] Implement card creation plus idempotent mapping storage
- [ ] Implement dispatch plus watcher loop
