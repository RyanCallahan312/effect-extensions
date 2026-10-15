# Durable Workflows

Read this only for work that must survive suspension or process restart.
Use `effect/workflow`; verify every constructor, Layer, and
storage requirement against installed 4.0.5 source.

## Choose

- Define `Workflow.make` with a stable tag plus payload, success, and typed
  error schemas. Derive its idempotency key from stable business identity.
- Register an implementation with the returned workflow's `.toLayer` method.
- Put replayable durable steps in `Activity.make`; retry only classified
  transient typed failures.
- Use `DurableClock` and `DurableDeferred` for durable waiting and signaling.
- Use `Workflow.withCompensation` only at the supported top-level workflow
  scope, not in arbitrary nested activities.

## Rules

- Treat interruption as a normal lifecycle: callers can interrupt, poll, and
  resume executions. Make cleanup, compensation, and operator recovery paths
  deliberate.
- An activity can rerun after an external effect or database commit. Make every
  external write idempotent or reconcilable; activity replay is not exactly-once
  delivery.
- Change the workflow tag/revision when a durable activity graph, schema, or
  persisted policy is incompatible with existing executions. Recover stopped or
  interrupted work through an explicit restart path.
- Compose revision-sensitive policy before defining the workflow or activity;
  do not expose it as per-execution mutation.
- Keep workflow correctness checkpoints in durable workflow/activity state;
  operational projections are observability, not the recovery authority.

## Do not

- Do not use `WorkflowEngine.layerMemory` as production durability.
- Do not use random request IDs as an idempotency key or claim external effects
  are exactly once.
- Do not put deployment-specific sharding or message storage in workflow domain
  logic; read [clustering.md](./clustering.md) when cluster wiring is required.

Pinned starting points:

- `packages/tss-effect-serverfn/node_modules/effect/src/workflow/Workflow.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/workflow/Activity.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/workflow/WorkflowEngine.ts`
