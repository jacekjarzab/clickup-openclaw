# Graph Report - .  (2026-07-24)

## Corpus Check
- Corpus is ~21,600 words - fits in a single context window. You may not need a graph.

## Summary
- 77 nodes · 62 edges · 47 communities (6 shown, 41 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Bridge Orchestration
- Automation and Review
- Status Mapping
- CLI Adapter
- Task Contract
- State Store
- BridgeConfig
- buildOpenClawNotes
- OpenClawWorkboardAdapterOptions
- OpenClawWorkboardCardSummary
- OpenClawWorkboardDispatchResult
- renderBridgeMetadataBlock
- normalizeRepoUrl
- resolveRepoUrl
- buildOpenClawStatusComment
- extractOpenClawTerminalContext
- createClickUpClient
- createClickUpClient
- createLogger
- Logger
- AutomationState
- BridgeJobState
- ClaimRecord
- ClickUpWebhookEvent
- IdempotencyRecord
- getWorkboardToClickUpStatusMapping
- isBlockedWorkboardStatus
- isHumanReviewWorkboardStatus
- workboardCardPrioritySchema
- OpenClawTerminalContext
- OpenClawTerminalWorkboardCardStatus
- OpenClawWorkboardCardStatus
- PriorityBucket
- WorkboardCardCreate
- WorkboardCardPriority
- WorkboardState
- WorkboardToClickUpStatusMapping
- WorkerEvent
- WorkerLogEvent
- WorkerLogLevel
- WorkerProgressEvent
- WorkerProgressState
- ClickUpWriteBackState
- JobPatch
- JobRecord
- FileBackedStateStore
- InMemoryStateStore

## God Nodes (most connected - your core abstractions)
1. `Integration Plan` - 10 edges
2. `Architecture` - 9 edges
3. `Bridge Technical Spec` - 9 edges
4. `Project Overview` - 8 edges
5. `Backlog Checklist` - 6 edges
6. `Task Schema Proposal` - 6 edges
7. `Bridge Orchestrator` - 6 edges
8. `Observability Layer` - 6 edges
9. `ClickUp Status Mapping` - 5 edges
10. `Local CLI Adapter` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Bridge Orchestrator` --references--> `loadConfig`  [INFERRED]
  docs/plan.md → apps/bridge/src/config.ts
- `Automation-Eligible Tasks` --references--> `createBridgeServices`  [INFERRED]
  docs/openclaw-bridge-spec.md → apps/bridge/src/services.ts
- `Local CLI Adapter` --implements--> `OpenClawCommandRunner`  [EXTRACTED]
  docs/architecture.md → apps/bridge/src/openclaw-workboard.ts
- `Local CLI Adapter` --implements--> `OpenClawWorkboardAdapter`  [EXTRACTED]
  docs/architecture.md → apps/bridge/src/openclaw-workboard.ts
- `OpenClaw Workboard Runtime` --references--> `OpenClawWorkboardAdapter`  [EXTRACTED]
  docs/architecture.md → apps/bridge/src/openclaw-workboard.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **ClickUp Bridge Runtime Loop** — clickup_system_of_record, bridge_orchestration_layer, openclaw_workboard_runtime [INFERRED 0.85]
- **Task Handoff Contract** — automation_eligible_tasks, idempotent_handoff, clickup_status_mapping, task_metadata_contract [INFERRED 0.85]

## Communities (47 total, 41 thin omitted)

### Community 0 - "Bridge Orchestration"
Cohesion: 0.38
Nodes (10): loadConfig, createBridgeServices, Bridge Orchestrator, ClickUp Source of Truth, Architecture, Integration Plan, OpenClaw Workboard Runtime, Project Overview (+2 more)

### Community 1 - "Automation and Review"
Cohesion: 0.33
Nodes (9): Automation-Eligible Tasks, Backlog Checklist, Task Schema Proposal, Bridge Technical Spec, Idempotent Handoff, Observability Layer, createLogger, ClickUpAutomationStatus (+1 more)

### Community 2 - "Status Mapping"
Cohesion: 0.40
Nodes (6): ClickUp Status Mapping, Human Review Loop, getWorkboardToClickUpStatusMapping, isBlockedWorkboardStatus, isHumanReviewWorkboardStatus, workboardCardPrioritySchema

### Community 3 - "CLI Adapter"
Cohesion: 0.50
Nodes (4): OpenClawCommandRunner, OpenClawWorkboardAdapter, Local CLI Adapter, Boring MVP

### Community 4 - "Task Contract"
Cohesion: 0.50
Nodes (4): BridgeToWorkboardCard, ClickUpTask, WorkboardCardMetadata, Task Metadata Contract

### Community 5 - "State Store"
Cohesion: 1.00
Nodes (3): Bridge State Store, FileBackedStateStore, InMemoryStateStore

## Knowledge Gaps
- **53 isolated node(s):** `BridgeConfig`, `loadConfig`, `OpenClawCommandRunner`, `OpenClawWorkboardDispatchResult`, `OpenClawWorkboardCardSummary` (+48 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **41 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Bridge Technical Spec` connect `Automation and Review` to `Bridge Orchestration`, `Status Mapping`, `CLI Adapter`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `Task Schema Proposal` connect `Automation and Review` to `Bridge Orchestration`, `Status Mapping`, `Task Contract`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `Architecture` connect `Bridge Orchestration` to `Automation and Review`, `CLI Adapter`, `State Store`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **What connects `BridgeConfig`, `loadConfig`, `OpenClawCommandRunner` to the rest of the system?**
  _53 weakly-connected nodes found - possible documentation gaps or missing edges._