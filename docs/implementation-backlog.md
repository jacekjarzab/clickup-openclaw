# OpenClaw + ClickUp Integration Backlog

## Phase 0: Foundations

- Confirm ClickUp workspace structure
- Lock the automation-eligible task filter already agreed for Bridge
- Define the ClickUp statuses Bridge may consume and write back
- Confirm the target human-review status in ClickUp
- Verify the local OpenClaw Gateway and Workboard plugin runtime on the Bridge host
- Keep the private bridge path behind Tailscale or loopback-only access

## Phase 1: ClickUp Ingestion and Normalization

- Receive ClickUp webhook events
- Poll ClickUp as a fallback reconciliation path
- Normalize eligible tasks into Bridge job records
- Store idempotency keys for every event
- Ignore non-automation tasks without side effects
- Write back sync timestamps and last error values

## Phase 2: Bridge to Workboard Handoff

- Create an OpenClaw adapter in Bridge using the local `openclaw workboard` CLI
- Create Workboard cards only for automation-eligible ClickUp tasks
- Use a stable idempotency key derived from the ClickUp task id
- Persist the ClickUp task id to Workboard card id mapping
- Attach normalized task context to the card title, notes, labels, and priority
- Trigger `openclaw workboard dispatch` after eligible card creation or later eligible syncs for already-mapped cards
- Implemented: automatic handoff and dispatch now run during ingest and list sync for eligible tasks
- Implemented: Bridge creates a card once and reuses the stored Workboard mapping on later syncs

## Phase 3: OpenClaw Execution Lifecycle

- Let the default OpenClaw agent process Workboard cards
- Treat Workboard status, blocking, and completion as execution truth
- Read Workboard card state and linked run data from Bridge
- Detect terminal states: `review`, `done`, `blocked`
- Capture execution metadata from Workboard terminal payloads
  - Extract summary text from `summary`, `execution.summary`, `proof.note`, or `notes`
  - Preserve proof, artifact, and comment context when the Workboard response includes it
  - Keep the parsed terminal context available to Bridge write-back and logs
- Capture blocker context for `blocked` runs
  - Prefer a human-readable blocker reason over raw status text
  - Fall back to a generic blocked message when the Workboard payload is sparse
- Re-read Workboard state before retrying Bridge actions
  - Treat Gateway restarts, stale cards, and lost process state as reread conditions
  - Never assume cached status is newer than a fresh `openclaw workboard show`
- Add tests for terminal payload extraction and reread behavior
  - Cover summary, proof, artifact, and blocker extraction
  - Cover status comment selection for `review`, `done`, and `blocked`
  - Cover the stale-card / restart-safe retry path

## Phase 4: ClickUp Write-Back

- Post a start comment to the ClickUp task when Bridge observes Workboard execution start
- Move the task to ClickUp `in progress` when Workboard enters `running`
- Move the task to ClickUp `human-review` when OpenClaw finishes successfully
- Post completion summaries with proof and useful artifact links
- Post blocked or failure summaries with concise next-step context
- Prevent duplicate comments or duplicate terminal updates

## Phase 5: Status Mapping and Contract Hardening

- Finalize the Bridge to Workboard card payload contract
- Finalize the Workboard to ClickUp status mapping table
- Define what Bridge writes into ClickUp custom fields such as `run_id`, `workboard_id`, and sync metadata
- Define how retries behave for duplicate webhook delivery, CLI failure, and temporary Gateway unavailability
- Define which terminal outcomes require human review versus blocked status

## Phase 6: Reliability

- Add retry policy for transient ClickUp, Gateway, or CLI failures
- Add dead-letter handling for repeated handoff failures
- Add detection for stale Workboard cards and interrupted runs
- Add visibility into dispatch failures, queue stalls, and sync lag
- Add restart-safe reconciliation so Bridge can resume after crashes without duplicate card creation

## Phase 7: Operator Controls

- Add manual re-dispatch for eligible cards
- Implemented: force-sync path from Workboard back to ClickUp exists via `POST /openclaw/:taskId/sync`
- Add a requeue path for tasks returned from review or failure
- Add a mark-blocked path with reason text
- Add a force-human-review path when OpenClaw output should be inspected without further automation

## Phase 8: Quality and Scale

- Support multiple ClickUp lists, folders, or projects with the same Bridge rules
- Support per-project routing labels and metadata on Workboard cards
- Implemented: dashboards exist for queue health and completion rates, including sync lag metrics
- Add reporting for card lifecycle throughput and blocked-task categories
- Evaluate a phase-2 WebSocket RPC transport to replace or supplement CLI polling

## Recommended First Build Order

1. ClickUp read sync and task eligibility filter
2. Bridge job normalization and idempotency store
3. OpenClaw CLI adapter and Workboard card creation
4. Dispatch and watcher loop
5. ClickUp write-back to `in progress` and `human-review`
6. Failure handling and restart-safe reconciliation
7. Artifact, proof, and summary enrichment
8. Operator controls and dashboards

## Success Criteria

- Only automation-eligible ClickUp tasks are handed to OpenClaw.
- One eligible ClickUp task maps to one active Workboard card.
- Bridge can dispatch work into the existing local OpenClaw Gateway.
- OpenClaw can finish a task and Bridge moves it to `human-review`.
- Blocked, failed, and interrupted runs are visible in ClickUp.
- The system can recover after Bridge or Gateway restarts without duplicate task execution.
