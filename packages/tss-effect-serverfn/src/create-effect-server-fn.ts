import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createServerFn } from "@tanstack/react-start";
import type {
  Fetcher,
  FunctionMiddlewareWithTypes,
  Method,
  Register,
  ServerFnBuilder,
  ServerFnCtx,
  ServerFnOptions,
  ServerFnStrict,
  ServerFnStrictOutput,
} from "@tanstack/react-start";
import type { ValidateSerializableInput } from "@tanstack/router-core";
import type { Effect, Schema } from "effect";

import type { ExecutionCapability, RequestServices } from "./execution.ts";

/**
 * Type-only bridge from an Effect Schema to Start's validator inference.
 * Clients supply encoded input; handlers receive decoded data. Runtime decoding
 * is supplied by the compiler bridge, not a Standard Schema adapter.
 */
type NativeValidator<Input> = Input extends Schema.Constraint
  ? StandardSchemaV1<Input["Encoded"], Input["Type"]>
  : undefined;

type HandlerContext<MethodType, Middlewares, Input> = ServerFnCtx<
  Register,
  MethodType,
  Middlewares,
  NativeValidator<Input>
>;

type DecodingServices<Input> = Input extends Schema.Constraint
  ? Input["DecodingServices"]
  : never;

type AppendMiddlewares<
  Current,
  Next extends NativeMiddlewares,
> = Current extends readonly unknown[] ? readonly [...Current, ...Next] : Next;

type SerializableOutput<A, Strict extends ServerFnStrict> =
  ServerFnStrictOutput<Strict> extends false
    ? A
    : A extends Response
      ? A
      : ValidateSerializableInput<Register, A>;

type NativeBuilder<
  M extends Method,
  Strict extends ServerFnStrict,
> = ServerFnBuilder<Register, M, Strict>;

type NativeMiddlewares = Parameters<
  NativeBuilder<Method, ServerFnStrict>["middleware"]
>[0];

/**
 * Enable handlers only when middleware supplies a runtime and all decoding
 * services. The returned Effect must also satisfy service and wire-output checks.
 */
type Handler<
  M extends Method,
  Middlewares,
  Input,
  Strict extends ServerFnStrict,
> =
  HandlerContext<M, Middlewares, Input>["context"] extends ExecutionCapability<
    infer Services
  >
    ? [Exclude<DecodingServices<Input>, Services | RequestServices>] extends [
        never,
      ]
      ? <A, E>(
          handler: (
            context: HandlerContext<M, Middlewares, Input>
          ) => Effect.Effect<A, E, Services | RequestServices> &
            Effect.Effect<SerializableOutput<A, Strict>, unknown, unknown>
        ) => Fetcher<Middlewares, NativeValidator<Input>, A>
      : never
    : never;

type SerializableInput<
  Input extends Schema.Constraint,
  M extends Method,
  Strict extends ServerFnStrict,
> = Strict extends false | { input: false }
  ? unknown
  : [M, Input["Encoded"]] extends ["POST", FormData]
    ? unknown
    : Schema.ConstraintCodec<
        unknown,
        ValidateSerializableInput<Register, Input["Encoded"]>,
        unknown,
        unknown
      >;

/**
 * Start's server-function builder with raw Effect Schemas and Effect handlers.
 *
 * Native method, middleware-context, and serialization inference are preserved.
 * Configured builders remain callable until a validator is attached, following
 * Start's builder contract.
 *
 * @template M - HTTP method used by the server function.
 * @template Middlewares - Accumulated native middleware and its context types.
 * @template Input - The attached Effect Schema, or `undefined` before validation.
 * @template Strict - Start's input/output serialization-check policy.
 * @template Callable - Whether this builder can configure another endpoint.
 */
export type EffectServerFnBuilder<
  M extends Method = "GET",
  Middlewares = undefined,
  Input = undefined,
  Strict extends ServerFnStrict = true,
  Callable extends boolean = true,
> = Omit<
  NativeBuilder<M, Strict>,
  "handler" | "validator" | "middleware" | "~types"
> & {
  readonly "~types": FunctionMiddlewareWithTypes<
    Register,
    Middlewares,
    NativeValidator<Input>,
    undefined,
    undefined,
    undefined,
    undefined
  >["~types"] & {
    readonly method: M;
    readonly strict: Strict;
    readonly response: undefined;
  };
  /**
   * Return an Effect using decoded data and native middleware context.
   * The generated client function returns a Promise; remote rejections do not
   * carry the Effect error channel as a TypeScript rejection type.
   */
  readonly handler: Handler<M, Middlewares, Input, Strict>;
  /** Decode raw input in the handler's application runtime and request Scope. */
  readonly validator: <NextInput extends Schema.Constraint>(
    schema: NextInput & SerializableInput<NextInput, M, Strict>
  ) => EffectServerFnBuilder<M, Middlewares, NextInput, Strict, false>;
  /** Append native middleware, retaining its inferred context and execution services. */
  readonly middleware: <const Next extends NativeMiddlewares>(
    middlewares: Next
  ) => EffectServerFnBuilder<
    M,
    AppendMiddlewares<Middlewares, Next>,
    Input,
    Strict,
    Callable
  >;
} & (Callable extends true
    ? <
        NextMethod extends Method = M,
        NextStrict extends ServerFnStrict = Strict,
      >(
        options?: ServerFnOptions<NextMethod, NextStrict>
      ) => EffectServerFnBuilder<NextMethod, Middlewares, Input, NextStrict>
    : unknown);

/** Factory signature for an Effect-aware native Start server-function builder. */
export type CreateEffectServerFn = <
  M extends Method = "GET",
  Strict extends ServerFnStrict = true,
>(
  options?: ServerFnOptions<M, Strict>
) => EffectServerFnBuilder<M, undefined, undefined, Strict>;

/**
 * Define a Start server function using an Effect Schema and an Effect handler.
 *
 * Requires `effectServerFns()` from `@rc312/tss-effect-serverfn/vite`, installed before
 * `tanstackStart()`, and execution middleware from `createEffectMiddleware`.
 * This value retains the native `createServerFn` identity; the plugin adapts
 * validators and handlers before Start performs extraction and RPC generation.
 *
 * @param options - Native Start options, including HTTP method and strictness.
 * @returns A builder whose completed handler exposes Start's Promise client.
 *
 * @example
 * Using the shared factory configured with execution middleware:
 * ```ts
 * import { Effect, Schema } from "effect";
 * import { createEffectServerFn } from "./effect-server-fn";
 *
 * export const greet = createEffectServerFn({ method: "GET" })
 *   .validator(Schema.Struct({ name: Schema.NonEmptyString }))
 *   .handler(({ data }) => Effect.succeed(`Hello, ${data.name}!`));
 * ```
 */
export const createEffectServerFn: CreateEffectServerFn =
  // SAFETY: The compiler lowers raw schemas and Effect callbacks before TanStack consumes them.
  createServerFn as typeof createServerFn & CreateEffectServerFn;
