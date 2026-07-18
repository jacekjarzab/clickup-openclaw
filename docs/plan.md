# ClickUp + OpenClaw Integration Plan

## Goal
Use ClickUp as the single source of truth for clients, projects, and tasks, while OpenClaw picks up tasks, processes them in a controlled workboard, and reports results back into ClickUp.

## Target Workflow
- ClickUp manages clients, projects, tasks, and statuses.
- OpenClaw connects to ClickUp and claims eligible tasks.
- Tasks are processed in a controlled manner with leases, heartbeats, and retries.
- OpenClaw writes results back to the source ClickUp task:
  - status updates
  - summary comments
  - links to PRs, repos, commits, docs, or deployments
  - error reports for crashes, timeouts, and blocked work

## Proposed Architecture
- ClickUp sync layer
  - Watches ClickUp for new or changed tasks.
  - Normalizes tasks into OpenClaw jobs.
  - Writes back status, comments, and metadata.
- OpenClaw dispatcher
  - Claims tasks and starts bounded execution runs.
  - Tracks queued, claimed, in progress, blocked, done, and failed states.
- Workboard / execution engine
  - Holds active jobs with ownership, retry count, lease timeout, and heartbeat.
  - Prevents double-processing.
- Reporter
  - Posts concise summaries and evidence back to ClickUp.
  - Logs failures with a standard error format.
- Local bridge
  - Runs inside the private network or Tailscale.
  - Handles auth, event sync, retries, and idempotency.

## Task Lifecycle
- `new` or `ready`
- `claimed`
- `in progress`
- `blocked`
- `review` if human approval is needed
- `done`
- `failed`

## ClickUp Data Model
Recommended custom fields and metadata:
- `automation_state`
- `run_id`
- `workboard_id`
- `repo_url`
- `pr_url`
- `last_sync_at`
- `last_error`

## OpenClaw Data Model
Recommended internal state:
- claim owner
- task payload snapshot
- execution history
- retry count
- heartbeat timestamps
- artifact links
- error traces
- human handoff reason when blocked

## Reporting Back to ClickUp
On start:
- comment: `Claimed by OpenClaw, starting work`
- status: `in progress`

During work:
- optional progress comments at milestones

On finish:
- summary comment
- links to PRs, commits, docs, or deployments
- status: `done` or `review`

On failure:
- error summary
- next-step note
- status: `blocked` or `failed`

## Error Handling
- Gateway crashes
  - detect missed heartbeats
  - mark the run interrupted
  - requeue only if safe
- Timeouts
  - expire the lease
  - make the task reclaimable
  - log timeout cause in ClickUp
- Duplicate events
  - use idempotency keys per task event
- Partial success
  - keep the useful output
  - mark only unresolved parts as blocked
- External failures
  - retry transient API/network issues before failing the task

## MVP Scope
- One-way ingestion from ClickUp
- Manual or semi-automatic task claim
- Status sync back to ClickUp
- Completion comments with summaries and links
- Basic error reporting
- No advanced AI orchestration yet

## Phase 2
- Auto-pick tasks by label or status
- Priority queues
- Better client/project mapping
- PR and commit enrichment
- Human approval gates for risky actions
- Metrics for throughput and failures

## Phase 3
- Task decomposition into multi-step jobs
- Smarter triage rules
- Auto-escalation for long-blocked work
- Workflow templates per client/project type

## Early Decisions
- Use ClickUp webhooks, polling, or both?
- Which ClickUp status means `ready for OpenClaw`?
- Should OpenClaw claim tasks automatically or only when assigned?
- Should progress comments happen on every step or only on start/end/block?
- Which artifact links matter most?
- What is the retry and escalation policy?

## Recommendation
Start with a boring, reliable v1:
- ClickUp status is the source of truth.
- Run a local Tailscale bridge.
- Process one task claim at a time per worker.
- Enforce strict idempotency.
- Post a summary comment and status update on completion.
- Post a failure comment on exceptions.

