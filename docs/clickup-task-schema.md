# ClickUp Task Schema Proposal

## Purpose
Make ClickUp the source of truth for all client work while giving OpenClaw a clean, machine-readable path for dispatching, processing, and reporting tasks.

## Recommended Workspace Structure

- Space: `Clients`
- Folder per client
- List per project or engagement
- Tasks for work items
- Subtasks for decomposed steps when needed

## Suggested Status Flow

- `new`
- `triage`
- `ready for openclaw`
- `in progress`
- `blocked`
- `approval`
- `done`
- `closed`

## Status Meaning

- `new`
  - Task exists but has not been reviewed.
- `triage`
  - Human or automation is deciding whether it should be executed.
- `ready for openclaw`
  - Explicit signal that the task may be picked up by OpenClaw.
- `in progress`
  - OpenClaw has claimed the task and is actively working it.
- `blocked`
  - Work cannot continue without external input or dependency resolution.
- `approval`
  - Work is complete, but a human should validate it first.
- `done`
  - Work is finished and accepted.
- `closed`
  - Task is archived or no longer actionable.

## Custom Fields

Recommended task fields:

- `automation_state`
  - Enum: `manual`, `candidate`, `claimed`, `running`, `blocked`, `done`
- `run_id`
  - Text value for the current OpenClaw execution run.
- `workboard_id`
  - Identifier for the active workboard queue item.
- `routing_key`
  - Optional routing hint used by Bridge when resolving project rules.
- `repo_url`
  - Link to the primary repository.
- `pr_url`
  - Link to the pull request, if one exists.
- `artifact_url`
  - Link to the main artifact, preview, or deployment.
- `docs_url`
  - Link to supporting docs, if any.
- `design_url`
  - Link to design assets, if any.
- `last_sync_at`
  - Timestamp of the latest successful sync.
- `last_error`
  - Short text summary of the latest failure.
- `priority`
  - ClickUp built-in priority field; Bridge maps it to its internal bucket.
- `triage_reason`
  - Short text explaining why a task was held or routed a certain way.
- `branch_name`
  - Optional branch reference for code-related tasks.
- `commit_url`
  - Optional commit URL for code-related tasks.

Bridge also carries a `source_system` metadata field in the Workboard payload, but that is not a ClickUp custom field.

## Labels

ClickUp labels are optional and do not drive Bridge pickup.

Recommended labels:

- `needs-human`
- `needs-review`
- `backend`
- `frontend`
- `docs`
- `ops`
- `bug`
- `feature`
- `maintenance`

## Task Template Fields

For each OpenClaw-ready task, encourage the following structure:

- Goal
- Context
- Acceptance criteria
- Constraints
- Links
- Notes

## OpenClaw Dispatch Rules

- Only tasks with status `ready for openclaw` may be dispatched automatically.
- One active Workboard card per task in Bridge-managed automation.
- Card creation and dispatch must be idempotent.
- Every successful handoff writes a `workboard_id`, and runtime sync writes `run_id` as soon as Bridge can resolve it from the claim or Workboard payload.
- Every finish or failure must write a terminal status comment back to ClickUp.

## Comments Strategy

- On running:
  - `OpenClaw started work on this task.`
- On major milestone:
  - short progress note with what changed
- On finish:
  - terminal status comment
  - links to PRs, commits, docs, or deployments once artifact enrichment is implemented
  - successful automation returns the task to `approval`
- On failure:
  - blocker or status summary
  - next step when enrichment is implemented

## Minimal MVP Fields

If you want the smallest useful setup, start with:

- `automation_state`
- `run_id`
- `last_sync_at`
- `last_error`
- `pr_url`

## Recommendation

Keep the ClickUp model boring and explicit:

- the status tells OpenClaw whether to act
- the custom fields carry machine state
- comments hold human-readable summaries
- labels drive routing and prioritization

## Bridge to Workboard Payload

Bridge should create Workboard cards with this minimum contract:

- `title`
  - stable, human-readable task title from ClickUp
- `notes`
  - rendered task snapshot including goal, context, acceptance criteria, constraints, and links
- `status`
  - `ready` by default, `todo` only when the task should be queued but not dispatched yet
- `priority`
  - normalized from ClickUp built-in `priority`
- `labels`
  - source and routing metadata only
- `idempotencyKey`
  - stable key derived from ClickUp task id and Bridge handoff rules
- optional `agentId`
  - omitted for now so the default OpenClaw agent is used
- optional `boardId`
  - used when Bridge routes cards into a dedicated board namespace
