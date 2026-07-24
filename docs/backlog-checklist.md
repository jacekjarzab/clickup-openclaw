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
- [x] Automatically hand off only automation-eligible ClickUp tasks into Workboard card creation
- [x] Use a stable idempotency key derived from the ClickUp task id
- [x] Persist the ClickUp task id to Workboard card id mapping
- [x] Attach normalized task context to the card title, notes, labels, and priority
- [x] Automatically trigger `openclaw workboard dispatch` after eligible card creation or later eligible syncs for already-mapped cards

## Phase 3: OpenClaw Execution Lifecycle

- [x] Let the default OpenClaw agent process Workboard cards
- [x] Treat Workboard status, blocking, and completion as execution truth
- [x] Read Workboard card state and linked run data from Bridge
- [x] Detect terminal states: `review`, `done`, `blocked`
- [x] Capture execution metadata from Workboard terminal payloads
  - Extract summary text from `summary`, `execution.summary`, `proof.note`, or `notes`
  - Preserve proof, artifact, and comment context when the Workboard response includes it
  - Keep the parsed terminal context available to Bridge write-back and logs
- [x] Capture blocker context for `blocked` runs
  - Prefer a human-readable blocker reason over raw status text
  - Fall back to a generic blocked message when the Workboard payload is sparse
- [x] Re-read Workboard state before retrying Bridge actions
  - Treat Gateway restarts, stale cards, and lost process state as reread conditions
  - Never assume cached status is newer than a fresh `openclaw workboard show`
- [x] Add tests for terminal payload extraction and reread behavior
  - Cover summary, proof, artifact, and blocker extraction
  - Cover status comment selection for `review`, `done`, and `blocked`
  - Cover the stale-card / restart-safe retry path

## Phase 4: ClickUp Write-Back

- [x] Post a start comment to the ClickUp task when Bridge observes Workboard execution start
- [x] Move the task to ClickUp `in progress` when Workboard enters `running`
- [x] Move the task to ClickUp `human-review` when OpenClaw finishes successfully
- [x] Post completion summaries with proof and useful artifact links
  - Include the terminal summary from OpenClaw
  - Include proof text when available
  - Include artifact links or artifact titles when available
  - Keep the comment readable when the terminal payload is sparse
- [x] Post blocked or failure summaries with concise next-step context
  - Include a human-readable blocker reason
  - Include the last useful execution summary or proof note when present
  - Include a clear next step for the human
  - Fall back to a short generic blocked message when the payload is sparse
- [x] Prevent duplicate comments or duplicate terminal updates
  - Record the last synced terminal status on the Bridge job
  - Reuse the last successful terminal sync when a restart happens mid-write
  - Ensure a retry does not repost the same terminal comment after a partial failure

## Phase 5: Status Mapping and Contract Hardening

- [x] Finalize the Bridge to Workboard card payload contract
- [x] Freeze the required and optional fields in the payload schema
  - Required: `title`, `notes`, `status`, `priority`, `labels`, `idempotencyKey`
  - Metadata: `sourceSystem`, `clickupTaskId`, `clickupStatus`, `projectKey`, `workType`, `routingKey`, `automationAllowed`, `approvalRequired`, `priorityBucket`, `tags`, `repoUrl`, `prUrl`, `artifactUrl`, `docsUrl`, `designUrl`
  - Add schema tests for missing, empty, and extra fields
- [x] Finalize the Workboard to ClickUp status mapping table
- [x] Lock the status-to-status and status-to-automation-state mapping
  - `triage`, `backlog`, `todo`, `scheduled`, `ready` -> `ready for openclaw` + `candidate`
  - `running` -> `in progress` + `running`
  - `review` and `done` -> `human-review` + `done`
  - `blocked` -> `blocked` + `blocked`
  - Treat unsupported statuses as contract errors
- [x] Define what Bridge writes into ClickUp custom fields such as `run_id`, `workboard_id`, and sync metadata
  - On `running`, write `run_id`, `workboard_id`, `automation_state`, and `last_sync_at`
  - On terminal sync, keep `run_id`, `workboard_id`, `automation_state`, and `last_sync_at` current
  - On blocked sync, persist a short `last_error` or blocker note
  - Overwrite values idempotently instead of appending duplicates
- [x] Define how retries behave for duplicate webhook delivery, CLI failure, and temporary Gateway unavailability
  - Duplicate webhook delivery should reuse the existing idempotency key and existing job/card mapping
  - CLI failure should retry with backoff before escalating to a terminal failure state
  - Temporary Gateway unavailability should reread existing card state and never create a second card
  - Add tests for duplicate event, transient CLI failure, and gateway-recovery behavior
- [x] Define which terminal outcomes require human review versus blocked status
  - `review` and `done` stay on `human-review`
  - Explicit dependency, access, or environment blockers map to `blocked`
  - Ambiguous terminal payloads default to `human-review`, not `blocked`
  - Add a decision matrix for `force-human-review` and `mark-blocked`

## Phase 6: Reliability

 - [x] Add retry policy for transient ClickUp, Gateway, or CLI failures
  - Classify retriable errors for ClickUp API, OpenClaw CLI, and local Gateway outages
  - Apply bounded exponential backoff with a fixed max attempt count
  - Retry handoff, dispatch, and sync separately so one failure does not poison the whole job
  - Add tests for retryable network failure, non-retryable contract error, and exhausted retry budget
 - [x] Add dead-letter handling for repeated handoff failures
  - Track retry count and last failure reason on the Bridge job
  - Mark jobs dead-lettered after the configured threshold
  - Preserve the failure context for operator review instead of dropping the job
  - Add tests for handoff failure, repeated dispatch failure, and dead-letter persistence
 - [x] Add detection for stale Workboard cards and interrupted runs
  - Detect jobs stuck in `card_created`, `dispatched`, or `running` beyond their expected age
  - Detect cards with missing or stale `run_id`, `workboard_id`, or `last_sync_at`
  - Trigger reread and reconciliation before creating or dispatching anything new
  - Add tests for stale-card detection and interrupted-run recovery
- [x] Add visibility into dispatch failures, queue stalls, and sync lag
  - Keep the queue and dashboard counters in sync with retry and dead-letter outcomes
 - [x] Add restart-safe reconciliation so Bridge can resume after crashes without duplicate card creation
  - Reload persisted Bridge state on startup
  - Re-read Workboard state for every mapped card before resuming dispatch or sync
  - Reuse the stored idempotency key and workboard mapping after a crash
  - Add tests for crash recovery, duplicate avoidance, and restart-safe sync replay

## Phase 7: Operator Controls

- [x] Add manual re-dispatch for eligible cards
  - Add an operator endpoint or CLI command that dispatches a single eligible `card_created`/`eligible` job without waiting for the normal watcher loop
  - Reject re-dispatch when the job is already `dispatched`, `running`, `synced_back`, or `dead_lettered`
  - Reuse the existing workboard card mapping and idempotency key instead of creating a new card
  - Add tests for successful re-dispatch, duplicate prevention, and invalid-state rejection
- [x] Add a force-sync path from Workboard back to ClickUp
  - Implemented via `POST /openclaw/:taskId/sync`
  - Keep the path able to reread the current card state and push comments/status back to ClickUp
- [x] Add a requeue path for tasks returned from review or failure
  - Allow an operator to move a `synced_back`, `blocked`, `failed`, or `dead_lettered` job back to the eligible queue
  - Clear terminal state, stale retry metadata, and dead-letter markers while preserving the historical event trail
  - Prevent requeue if the task is already active or missing required ClickUp/OpenClaw identifiers
  - Add tests for requeue from review, requeue from failure, and duplicate-queue prevention
- [x] Add a mark-blocked path with reason text
  - Accept a human reason string and record it on the job
  - Write the blocked outcome back to ClickUp with a clear operator-facing note
  - Stop automatic dispatch for the job until an operator explicitly requeues it
  - Add tests for blocked write-back, blocked comment content, and requeue-after-block behavior
- [x] Add a force-human-review path when OpenClaw output should be inspected without further automation
  - Move a job into `synced_back` / human-review flow without marking it as blocked
  - Preserve the latest OpenClaw summary, proof, and artifact links in ClickUp
  - Ensure the job stays out of the automatic dispatch queue after the forced review handoff
  - Add tests for forced review write-back and queue exclusion

## Phase 8: Quality and Scale

- [x] Define a multi-project routing model for ClickUp lists, folders, and projects
  - Decide how Bridge resolves routing when multiple project scopes match one task
  - Keep the routing rules deterministic and testable
- [x] Support multiple ClickUp lists, folders, or projects with the same Bridge rules
  - Prove the same Bridge config can handle more than one project tree
  - Add regression tests for cross-project isolation
- [x] Support per-project routing labels and metadata on Workboard cards
  - Write project-specific labels, tags, or routing metadata during handoff
  - Confirm the metadata survives rereads and sync loops
- [x] Add dashboards for queue health, sync lag, and completion rates
- [x] Add reporting for card lifecycle throughput and blocked-task categories
  - Track handoff-to-running, running-to-terminal, and queue wait times
  - Break blocked outcomes into useful categories, not just a single bucket
- [ ] Evaluate a phase-2 WebSocket RPC transport to replace or supplement CLI polling
  - Compare latency, reconnect behavior, and operational complexity against the CLI path
  - Define what would justify adopting it as an optional transport

## Replaced or Removed Work

- [x] Remove the old Phase 11 always-on worker runtime concept
  - OpenClaw Gateway is already the always-on runtime
  - Bridge should connect to the existing local Gateway, not invent a new daemon
- [x] Remove Bridge-owned claim and lease logic from the plan
  - Workboard owns queueing, blocking, completion, and synced-back state
- [x] Remove the custom worker-runner architecture from the plan
  - The default OpenClaw agent is the execution path for now
- [x] Remove the old Bridge worker and reporter apps from the repo
  - ClickUp write-back now happens in Bridge
  - OpenClaw is the execution runtime, not the deleted local execution app
- [x] Remove the old public Bridge execution endpoints
  - Bridge no longer exposes fake claim, lease, heartbeat, complete, or execution event routes
- [x] Remove the old internal Bridge claim/lease package and stale tests
  - The repo now keeps only the OpenClaw-backed execution path

## Immediate Next Steps

- [x] Draft the Bridge to Workboard card payload contract
- [x] Draft the Workboard to ClickUp status mapping table
- [x] Implement the local `openclaw workboard` CLI adapter in Bridge
- [x] Implement card creation plus idempotent mapping storage
- [x] Implement dispatch plus watcher loop
- [x] Implement automatic handoff and dispatch for eligible ingest/sync events
