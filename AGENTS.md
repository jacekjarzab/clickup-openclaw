# AGENTS.md

## Repo Shape
- Use `npm` workspaces, not pnpm/yarn: root scripts fan out across `apps/*` and `packages/*`.
- Main runtime is `apps/bridge/src/index.ts`; it starts Fastify and wires the bridge service layer.
- `packages/shared` is the contract layer. Keep status enums, schemas, and mappings there instead of duplicating them in app code.
- `packages/state` owns in-memory and file-backed persistence. It clones records on read/write, so preserve that behavior when changing state.
- `packages/clickup-client` is the ClickUp REST wrapper with retry logic and task-field mapping.
- `packages/observability` is intentionally tiny: logging helpers only.

## Commands
- Root `npm run dev` runs only `@clickup-openclaw/bridge`.
- Root `npm run build`, `npm run lint`, and `npm run typecheck` all run across every workspace.
- `lint` is just TypeScript `--noEmit`; there is no separate linter configured in `package.json`.
- There is no root `test` script; use workspace `build`/`typecheck` for verification unless a package adds its own tests.

## Runtime / Contract Rules
- The bridge is designed to run locally beside OpenClaw and shells out to `openclaw workboard ...`.
- Do not change the ClickUp status contract casually: `review` and `done` map back to ClickUp `approval`, and successful OpenClaw completion should not move tasks straight to `done` in v1.
- Keep `ready for openclaw` as the automation gate in bridge logic.
- Preserve the local-only/private assumptions in `docs/architecture.md` and `docs/openclaw-bridge-spec.md` unless the repo is explicitly being re-architected.

## TypeScript / Module Notes
- The repo uses strict NodeNext TypeScript (`tsconfig.base.json`), so keep `.js` extensions in relative imports between TS files.
- Shared path aliases are defined in `tsconfig.base.json`; prefer them for workspace imports.

## OpenCode Notes
- `.opencode/opencode.json` loads the graphify plugin from `.opencode/plugins/graphify.js`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
