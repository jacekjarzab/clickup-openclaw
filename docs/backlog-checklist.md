# ClickUp + OpenClaw Backlog Checklist

This is the living build checklist. Update it as we complete items and discover new work.

## Phase 0: Foundations

- [ ] Confirm ClickUp workspace structure
- [x] Define task statuses OpenClaw may consume
- [x] Define custom fields used for automation
- [x] Decide on webhooks, polling, or both
- [x] Set up private bridge path behind Tailscale

## Phase 1: Sync Layer

- [ ] Read ClickUp tasks from a list or folder
- [x] Normalize tasks into internal job records
- [x] Store idempotency keys for every event
- [x] Detect status changes that should create or update jobs
- [x] Write back sync timestamps and last error values

## Phase 2: Claim and Lease

- [x] Build a workboard queue
- [x] Add task claiming with a lease timeout
- [x] Prevent duplicate claims
- [x] Add heartbeat updates from workers
- [x] Reclaim stale tasks when a lease expires

## Phase 3: Execution Wrapper

- [x] Launch bounded worker runs
- [x] Pass task payload snapshots into the worker
- [x] Track retry counts
- [x] Capture logs and structured progress events
- [x] Support graceful cancellation and failure reporting

## Phase 4: Reporting

- [x] Post a start comment to the ClickUp task
- [x] Post milestone comments during execution
- [x] Post a completion summary
- [x] Post error summaries for failures and blocked work
- [x] Update ClickUp status and custom fields on every terminal outcome

## Phase 5: Artifact Linking

- [x] Capture repo URLs
- [x] Capture PR URLs
- [x] Capture deployment or preview URLs
- [x] Capture docs or design links
- [x] Include all useful links in the final ClickUp comment

## Phase 6: Reliability

- [x] Add retry policy for transient API failures
- [x] Add dead-letter handling for repeated failures
- [x] Add heartbeat monitoring
- [x] Add alerting for crashes and queue stalls
- [x] Add visibility into throughput and latency

## Phase 7: Operator Controls

- [x] Add manual claim and release
- [x] Add pause and resume controls
- [x] Add a force-review path
- [x] Add a requeue path
- [x] Add a mark-blocked path with reason text

## Phase 8: Quality and Scale

- [x] Support multiple workers
- [x] Support multiple projects or clients
- [x] Add per-project routing rules
- [ ] Add task templates by work type
- [ ] Add dashboards for queue health and completion rates

## Immediate Next Steps

- [x] Scaffold the bridge app with a real HTTP server
- [x] Add ClickUp API client basics
- [x] Add the first webhook endpoint
- [x] Add state schema for workboard jobs
- [x] Add an end-to-end claim/report flow
