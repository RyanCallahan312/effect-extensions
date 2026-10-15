# Specialized Protocol Modules

Read this only for Effect AI, RPC, HTTP API, or OpenAPI. This is a retrieval
router, not an API reference: verify each module against installed 4.0.5 source.

## Choose

| Need | Retrieve first |
| --- | --- |
| RPC protocol, client, server, transport | installed `effect/src/rpc/`; public import `effect/rpc` |
| HTTP API endpoint contracts | installed `effect/src/http-api/` and `ai-docs/src/51_http-server/`; public import `effect/http-api` |
| OpenAPI generation | installed `effect/src/http-api/OpenApi.ts`; verify separate generator packages only if installed |
| AI providers, tools, or model calls | installed `effect/ai-docs/src/71_ai/` and `src/ai/`; public import `effect/ai` |

## Rules

- Define Schema-backed input, success, and typed-error contracts before wiring a
  protocol. Decode unknown input at the transport edge once.
- Keep transport and provider Layers outside domain handlers. Map foreign
  failures to typed feature errors only at a deliberate boundary.
- For HTTP APIs, share schemas between runtime decoding and generated specs; test
  the resulting contract.
- For AI tools, schema both input and output, retain safe provider evidence for
  diagnosis, and redact credentials, prompts, and unbounded model output.

## Do not

- Do not copy examples between AI, RPC, HTTP API, and OpenAPI based on similarly
  named constructors.
- Do not invent imports, constructors, annotations, or Layer requirements from
  memory. Verify them against installed source at implementation time.
- Do not log secrets or raw unbounded protocol payloads by default.
