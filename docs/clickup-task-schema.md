# ClickUp Task Schema Proposal

## Purpose
Make ClickUp the source of truth for all client work while giving OpenClaw a clean, machine-readable path for claiming, processing, and reporting tasks.

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
- `human-review`
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
- `human-review`
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
- `source_system`
  - Enum for origin, such as `manual`, `clickup`, `openclaw`, `imported`.
- `repo_url`
  - Link to the primary repository.
- `pr_url`
  - Link to the pull request, if one exists.
- `artifact_url`
  - Link to the main artifact, preview, or deployment.
- `last_sync_at`
  - Timestamp of the latest successful sync.
- `last_error`
  - Short text summary of the latest failure.
- `priority_bucket`
  - Enum such as `low`, `normal`, `high`, `urgent`.
- `automation_allowed`
  - Checkbox or enum to explicitly permit OpenClaw execution.

## Labels

Recommended labels:

- `automation`
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

## OpenClaw Claim Rules

- Only tasks with `automation_allowed = true` or `status = ready for openclaw` may be claimed automatically.
- One active Workboard card per task in Bridge-managed automation.
- Card creation and dispatch must be idempotent.
- Every claim must write a `run_id` and `workboard_id`.
- Every finish or failure must write a summary comment back to ClickUp.

## Comments Strategy

- On claim:
  - `Claimed by OpenClaw, starting work.`
- On major milestone:
  - short progress note with what changed
- On finish:
  - concise summary
  - links to PRs, commits, docs, or deployments
  - successful automation returns the task to `human-review`
- On failure:
  - error class
  - short cause
  - next step

## Minimal MVP Fields

If you want the smallest useful setup, start with:

- `automation_allowed`
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
  - mapped from `priority_bucket`
- `labels`
  - source, project, work type, routing, and notable tags
- `idempotencyKey`
  - stable key derived from ClickUp task id and Bridge handoff rules
- optional `agentId`
  - omitted for now so the default OpenClaw agent is used
- optional `boardId`
  - used when Bridge routes cards into a dedicated board namespace
