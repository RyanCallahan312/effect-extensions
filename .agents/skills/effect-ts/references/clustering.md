# Clustering and Entities

Read this only for distributed entities, sharding, or cluster-backed workflows.
Use `effect/cluster`; inspect installed 4.0.5 source before implementation.

## Choose

- Define Schema-backed RPC payload, success, and typed-error contracts first.
- Define an addressable entity with `Entity.make`, then register handlers with
  the returned entity's `.toLayer` method.
- Use an entity client for requests addressed by entity id. Handlers are
  sequential by default; opt into concurrent execution only when state and
  ordering make it safe.
- Use `TestRunner.layer` for in-memory cluster tests.

## Rules

- Treat entity type, entity id, and RPC schemas as durable routing contracts.
- Keep entity-domain handlers independent of transport and storage. Compose
  socket/HTTP transport, Sharding, and message storage in deployment Layers.
- Choose persistence, deduplication, retry, and external-effect idempotency as
  separate policies. Persisted messaging does not make an external side effect
  exactly once.
- Choose local, SQL, or caller-provided storage from deployment needs; SQL is
  not an inherent cluster requirement.

## Do not

- Do not put transport sockets, storage clients, or deployment credentials in
  entity behavior.
- Do not assume volatile messages survive failure, or that persisted messages
  eliminate duplicate delivery and recovery work.
- Do not fork entity handlers merely to improve throughput without defining
  ordering, mailbox, and concurrent-state safety.

Pinned starting points:

- `packages/tss-effect-serverfn/node_modules/effect/src/cluster/Entity.ts`
- `packages/tss-effect-serverfn/node_modules/effect/src/cluster/TestRunner.ts`
- A version-compatible platform transport package, only when installed.
