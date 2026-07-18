# OpenClaw Bridge Technical Spec

## Purpose

Define the private bridge that connects ClickUp events to OpenClaw execution while keeping the system safe, idempotent, and observable.

## Scope

- Ingest ClickUp events
- Poll ClickUp as fallback
- Normalize tasks into jobs
- Dispatch work to OpenClaw workers
- Report results back to ClickUp
- Handle retries, failures, and stale leases

## Core Services

- Bridge API
  - private ingress
  - webhook receiver
  - auth and verification
- Sync Service
  - event normalization
  - task reconciliation
  - ClickUp write-back
- Workboard Service
  - job queue
  - leases
  - ownership tracking
- Worker Runner
  - bounded execution
  - heartbeat emission
  - artifact reporting
- Reporter
  - ClickUp status updates
  - comments
  - link aggregation
- State Store
  - job snapshots
  - idempotency keys
  - retry counters
  - execution history

## Data Flow

1. ClickUp emits a webhook or the poller detects a change.
2. Bridge API receives the event.
3. Sync Service deduplicates it.
4. Sync Service maps the task to an internal job.
5. Workboard Service decides whether the job is eligible.
6. Worker Runner leases the job.
7. Worker Runner performs the work.
8. Worker Runner emits heartbeats and progress.
9. Reporter posts the final outcome to ClickUp.
10. State Store keeps the audit trail.

## Job States

- `received`
- `normalized`
- `eligible`
- `leased`
- `running`
- `blocked`
- `succeeded`
- `failed`
- `reclaimed`

## Lease Rules

- Every lease has a start time and expiry.
- Heartbeats must renew the lease before expiry.
- Expired leases become reclaimable.
- Only one active lease may exist per job.
- Reclaims must be logged.

## Idempotency Rules

- Every ClickUp event gets a stable idempotency key.
- Every claim attempt gets a unique run identifier.
- Duplicate events must not create duplicate jobs.
- Duplicate write-backs must not duplicate comments.

## Failure Handling

- Webhook failure
  - fallback polling covers the gap.
- Worker crash
  - lease expires and the job is reclaimed.
- API timeout
  - retry transiently with backoff.
- Permanent failure
  - mark the task blocked or failed and write the reason to ClickUp.

## Reporting Contract

On start:

- status to `in progress`
- comment: `Claimed by OpenClaw, starting work.`

On progress:

- optional milestone comment

On success:

- status to `done` or `review`
- summary comment
- links to PRs, commits, docs, or deployments

On failure:

- status to `blocked` or `failed`
- concise error summary
- next-step recommendation

## Security and Network Assumptions

- Bridge runs inside the private network or Tailscale.
- ClickUp credentials stay server-side.
- Workers should not need direct public internet exposure beyond required APIs.
- All inbound events should be authenticated and verified.

## Observability

Track at minimum:

- event receive count
- dedupe hit count
- claimed job count
- completed job count
- blocked job count
- lease expirations
- worker crashes
- API errors
- average processing time

## Implementation Notes

- Keep the first version boring.
- Prefer one worker per job.
- Prefer explicit statuses over hidden automation.
- Prefer polling as a fallback, even if webhooks are enabled.
- Keep ClickUp write-back a first-class feature, not an afterthought.

