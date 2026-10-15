# Advanced Schema

Use this for codecs, recursion, variants, serialized contracts, or derivation.
Target installed Effect 4.0.5. Verify unfamiliar APIs in
`packages/tss-effect-serverfn/node_modules/effect/src/Schema.ts` and
`packages/tss-effect-serverfn/node_modules/effect/src/SchemaTransformation.ts`.

## Model Records First

Default records to `Schema.Struct(...)`; derive the TypeScript type from it.
Use `Schema.Opaque` only when a plain-object record needs nominal identity.
Use `Schema.Class` only when prototype methods, custom construction, `Equal`, or
inheritance provide concrete value. Do not introduce classes merely to name data.

Apply constraints before `Schema.brand(...)`: a brand is nominal typing, not
runtime validation. Decode unknown input once with
`Schema.decodeUnknownEffect`; encode typed boundary output with
`Schema.encodeEffect`.

## Codecs and Recursion

Represent different encoded and domain forms with `Schema.decodeTo` and a
`SchemaTransformation`:

- Use `SchemaTransformation.transform` for pure, infallible conversion.
- Use `SchemaTransformation.transformEffect` when conversion can fail or needs
  services; return `SchemaIssue.Issue` for conversion failures.
- Keep both directions lawful; test decode and encode, not only assignability.
- Use `Schema.suspend` to defer recursion. Keep the recursive contract small and
  test malformed deep input as well as finite valid values.

Do not distribute ad-hoc parsers and formatters around a canonical codec.

## Variants and Errors

Use `Data.TaggedEnum` for internal control-flow algebras. It supplies
constructors and exhaustive `$match` without creating a wire contract. Use
`Schema.TaggedStruct` for an ordinary schema-owned `_tag` member and
`Schema.TaggedUnion` when a union crosses persistence, HTTP, RPC, workflow, or
another serialized boundary.

Do not inspect `_tag` directly in runtime application code. This includes
comparisons, ternaries, `switch`, optional reads, destructuring, collection
membership such as `states.has(value._tag)`, and copying the discriminator into
persistence or diagnostics. Use the API belonging to the tagged value:

| Need | Preferred API |
|---|---|
| Check one internal `Data.TaggedEnum` variant | `Constructors.$is("Tag")(value)` |
| Exhaustively branch over `Data.TaggedEnum` | `Constructors.$match(value, cases)` |
| Check one or several `Schema.TaggedUnion` variants | `Union.isAnyOf(["Tag", ...])(value)` |
| Exhaustively branch over `Schema.TaggedUnion` | `Union.match(value, cases)` |
| Branch incrementally or group several tags | `Match.value(value)` with `Match.tag(...)` and `Match.exhaustive` |
| Validate unknown input as one schema variant | `Union.guards.Tag(value)` |
| Handle typed Effect failures | `Effect.catchTag` / `Effect.catchTags` |
| Inspect `Cause`, `Option`, `Either`, `Exit`, or `Result` | Their `is*`, `match`, and extraction helpers |

Prefer `isAnyOf` over full schema guards for values that have already been
decoded: `guards.Tag` validates the complete variant, while `isAnyOf` performs
the intended discriminator membership check and narrows the type. Define tag
lists with `as const satisfies ReadonlyArray<keyof typeof Union.cases>` so policy
tables reject misspelled or removed variants.

When a state name must cross a boundary, define one exhaustive projection with
the generated matcher rather than reading `_tag` at each call site. When
transitioning between variants, explicitly project shared fields rather than
removing `_tag` with object destructuring. These choices make additions to a
closed union visible to TypeScript instead of silently flowing through an
`else`, default branch, or string set.

Direct `_tag` syntax remains appropriate only where it defines the algebra or
its type, such as `Schema.TaggedStruct`, `Data.TaggedEnum`, and type-level
`Extract<Union, { _tag: "Tag" }>` declarations. It is not a runtime branching
or state-access API.

Use `Data.TaggedError` for local, non-serialized errors. Use
`Schema.TaggedError` for errors that cross HTTP, RPC, workflow,
persistence, or another serialized boundary. Give boundary errors stable,
domain-specific tags and schema fields; map infrastructure failures at the
adapter boundary.

## Evolution and Derivation

Treat encoded persisted and remote schemas as compatibility contracts. Make
versions and migrations explicit; never silently widen a schema and assume old
producers or stored values remain compatible.

Add annotations only when a consumer needs identifiers, descriptions, examples,
or protocol metadata (for example JSON Schema, OpenAPI, RPC, or diagnostics).
Do not inspect `SchemaAST` for ordinary modeling. Before AST or derived-spec work,
inspect the installed source and the relevant derivation module. A valid Effect
Schema is not necessarily losslessly representable in every derived format.
