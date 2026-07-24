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
- Include the terminal summary from OpenClaw
- Include proof text when available
- Include artifact links or artifact titles when available
- Keep the comment readable when the terminal payload is sparse
- Implemented: completion write-back now includes summary, proof, artifacts, comments, and sparse fallbacks
- Post blocked or failure summaries with concise next-step context
- Include a human-readable blocker reason
- Include the last useful execution summary or proof note when present
- Include a clear next step for the human
- Fall back to a short generic blocked message when the payload is sparse
- Implemented: blocked write-back now preserves the blocker reason, adds the useful summary when present, and keeps the next-step guidance
- Prevent duplicate comments or duplicate terminal updates
- Record the last synced terminal status on the Bridge job
- Reuse the last successful terminal sync when a restart happens mid-write
- Ensure a retry does not repost the same terminal comment after a partial failure
- Implemented: terminal write-back now treats the last synced terminal status as a restart-safe dedupe signal

## Phase 5: Status Mapping and Contract Hardening

- Finalize the Bridge to Workboard card payload contract
  - Freeze the required and optional fields in the schema
  - Add contract tests for missing, empty, and extra fields
- Finalize the Workboard to ClickUp status mapping table
  - Lock the status-to-status and status-to-automation-state mapping
  - Treat unsupported Workboard statuses as contract errors
- Define what Bridge writes into ClickUp custom fields such as `run_id`, `workboard_id`, and sync metadata
  - On `running`, write `run_id`, `workboard_id`, `automation_state`, and `last_sync_at`
  - On terminal sync, keep `run_id`, `workboard_id`, `automation_state`, and `last_sync_at` current
  - On blocked sync, persist a short `last_error` or blocker note
- Define how retries behave for duplicate webhook delivery, CLI failure, and temporary Gateway unavailability
  - Duplicate webhook delivery should reuse the existing idempotency key and existing job/card mapping
  - CLI failure should retry with backoff before escalating to a terminal failure state
  - Temporary Gateway unavailability should reread existing card state and never create a second card
  - Add tests for duplicate event, transient CLI failure, and gateway-recovery behavior
- Define which terminal outcomes require human review versus blocked status
  - `review` and `done` stay on `human-review`
  - Explicit dependency, access, or environment blockers map to `blocked`
  - Ambiguous terminal payloads default to `human-review`, not `blocked`
  - Add a decision matrix for `force-human-review` and `mark-blocked`

## Phase 6: Reliability

 - Add retry policy for transient ClickUp, Gateway, or CLI failures
  - Classify retriable errors for ClickUp API, OpenClaw CLI, and local Gateway outages
  - Apply bounded exponential backoff with a fixed max attempt count
  - Retry handoff, dispatch, and sync separately so one failure does not poison the whole job
  - Add tests for retryable network failure, non-retryable contract error, and exhausted retry budget
 - Add dead-letter handling for repeated handoff failures
  - Track retry count and last failure reason on the Bridge job
  - Mark jobs dead-lettered after the configured threshold
  - Preserve the failure context for operator review instead of dropping the job
  - Add tests for handoff failure, repeated dispatch failure, and dead-letter persistence
 - Add detection for stale Workboard cards and interrupted runs
  - Detect jobs stuck in `card_created`, `dispatched`, or `running` beyond their expected age
  - Detect cards with missing or stale `run_id`, `workboard_id`, or `last_sync_at`
  - Trigger reread and reconciliation before creating or dispatching anything new
  - Add tests for stale-card detection and interrupted-run recovery
- Add visibility into dispatch failures, queue stalls, and sync lag
- Add restart-safe reconciliation so Bridge can resume after crashes without duplicate card creation
  - Reload persisted Bridge state on startup
  - Re-read Workboard state for every mapped card before resuming dispatch or sync
  - Reuse the stored idempotency key and workboard mapping after a crash
  - Add tests for crash recovery, duplicate avoidance, and restart-safe sync replay

## Phase 7: Operator Controls

- Implemented: manual re-dispatch for eligible cards exists via `POST /openclaw/:taskId/redispatch`
  - Add an operator endpoint or CLI command that dispatches a single eligible `card_created`/`eligible` job without waiting for the normal watcher loop
  - Reject re-dispatch when the job is already `dispatched`, `running`, `synced_back`, or `dead_lettered`
  - Reuse the existing workboard card mapping and idempotency key instead of creating a new card
  - Add tests for successful re-dispatch, duplicate prevention, and invalid-state rejection
- Implemented: force-sync path from Workboard back to ClickUp exists via `POST /openclaw/:taskId/sync`
- Implemented: requeue path exists via `POST /openclaw/:taskId/requeue`
  - Allow an operator to move a `synced_back`, `blocked`, `failed`, or `dead_lettered` job back to the eligible queue
  - Clear terminal state, stale retry metadata, and dead-letter markers while preserving the historical event trail
  - Prevent requeue if the task is already active or missing required ClickUp/OpenClaw identifiers
  - Add tests for requeue from review, requeue from failure, and duplicate-queue prevention
- Implemented: mark-blocked path exists via `POST /openclaw/:taskId/block`
  - Accept a human reason string and record it on the job
  - Write the blocked outcome back to ClickUp with a clear operator-facing note
  - Stop automatic dispatch for the job until an operator explicitly requeues it
  - Add tests for blocked write-back, blocked comment content, and requeue-after-block behavior
- Implemented: force-human-review path exists via `POST /openclaw/:taskId/review`
  - Move a job into `synced_back` / human-review flow without marking it as blocked
  - Preserve the latest OpenClaw summary, proof, and artifact links in ClickUp
  - Ensure the job stays out of the automatic dispatch queue after the forced review handoff
  - Add tests for forced review write-back and queue exclusion

## Phase 8: Quality and Scale

- Implemented: a deterministic multi-project routing model now scores list, status, and label matches instead of relying on insertion order
- Define a multi-project routing model for ClickUp lists, folders, and projects
  - Decide how Bridge resolves routing when multiple scopes match one task
  - Keep the resolution deterministic and covered by tests
- Implemented: the same Bridge config can now route across multiple project trees with regression coverage
- Support multiple ClickUp lists, folders, or projects with the same Bridge rules
  - Prove one Bridge config can handle more than one project tree
  - Verify routing isolation between projects
- Implemented: project-specific routing links now flow into Workboard card metadata and task labels
- Support per-project routing labels and metadata on Workboard cards
  - Write project-specific labels, tags, or routing metadata during handoff
  - Confirm the metadata persists through rereads and sync loops
- Implemented: dashboards exist for queue health and completion rates, including sync lag metrics
- Implemented: reporting now includes routing throughput, queue wait, running duration, and blocked categories
- Add reporting for card lifecycle throughput and blocked-task categories
  - Track handoff-to-running, running-to-terminal, and queue wait times
  - Break blocked outcomes into actionable categories
- Evaluate a phase-2 WebSocket RPC transport to replace or supplement CLI polling
  - Compare latency, reconnect behavior, and operator overhead against the CLI path
  - Document the criteria that would justify adoption

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
