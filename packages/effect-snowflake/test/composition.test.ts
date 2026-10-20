import { it } from "@effect/vitest";
import { tableFromArrays } from "apache-arrow";
import type { Table } from "apache-arrow";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Fiber,
  flow,
  pipe,
  Layer,
  Stream,
} from "effect";
import { describe, expect, expectTypeOf } from "vitest";

import type { AdbcDriver } from "../src/adbc-driver.ts";
import * as Snowflake from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

interface ReaderService {
  readonly read: Effect.Effect<Table, Snowflake.SnowflakeError>;
}

const Reader = Context.Service<ReaderService>("Snowflake.Test.Reader");

interface WriterService {
  readonly write: (
    id: number
  ) => Effect.Effect<number, Snowflake.SnowflakeError>;
}

const Writer = Context.Service<WriterService>("Snowflake.Test.Writer");

interface TenantService {
  readonly id: number;
}

const Tenant = Context.Service<TenantService>("Snowflake.Test.Tenant");

const readerLayer = Layer.effect(
  Reader,
  pipe(
    Snowflake.Snowflake,
    Effect.map((client) => Reader.of({ read: client.query("select captured") }))
  )
);

const writerLayer = Layer.effect(
  Writer,
  pipe(
    Snowflake.Snowflake,
    Effect.map((client) =>
      Writer.of({
        write: (id) =>
          client.execute("insert captured", tableFromArrays({ id: [id] })),
      })
    )
  )
);

describe("Snowflake service composition", () => {
  it.effect(
    "builds lazily and shares one scoped client across service accessors",
    () =>
      Effect.gen(function* provideClient() {
        const f = fixture();
        const live = Snowflake.layer(options).pipe(Layer.provide(f.layer));
        expect(f.events).toEqual([]);

        const retained = yield* Effect.gen(function* useInjectedClient() {
          expect((yield* Snowflake.query("select")).numRows).toBe(1);
          expect(yield* Snowflake.execute("insert")).toBe(3);

          const batches = yield* Snowflake.stream("stream").pipe(
            Stream.runCollect
          );

          expect(batches).toHaveLength(1);

          return yield* Snowflake.Snowflake;
        }).pipe(Effect.provide(live));

        expect(f.events.filter((event) => event === "open")).toHaveLength(1);
        expect(f.events.slice(-2)).toEqual([
          "connection.close",
          "database.close",
        ]);
        expect(
          (yield* retained.query("closed").pipe(Effect.flip)).operation
        ).toBe("closed");
      })
  );

  it.effect(
    "memoizes one client layer across independently built repositories",
    () =>
      Effect.gen(function* shareClientLayer() {
        const f = fixture();
        const live = Snowflake.layer(options).pipe(Layer.provide(f.layer));

        const repositories = Layer.mergeAll(
          readerLayer.pipe(Layer.provide(live)),
          writerLayer.pipe(Layer.provide(live))
        );

        yield* Effect.gen(function* useRepositories() {
          const reader = yield* Reader;
          const writer = yield* Writer;
          expect((yield* reader.read).numRows).toBe(1);
          expect(yield* writer.write(1)).toBe(3);
        }).pipe(Effect.provide(repositories));
        expect(f.events.filter((event) => event === "connect")).toHaveLength(1);
        expect(
          f.events.filter((event) => event === "connection.close")
        ).toHaveLength(1);
      })
  );

  it.effect(
    "loads wrapped Config at layer build using the provided ConfigProvider",
    () =>
      Effect.gen(function* configureLayer() {
        const f = fixture();

        const live = Snowflake.layerConfig({
          account: Config.String("ACCOUNT"),
          username: Config.String("USER"),
        }).pipe(Layer.provide(f.layer));

        yield* Snowflake.execute("insert").pipe(
          Effect.provide(
            live.pipe(
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    ACCOUNT: "configured",
                    USER: "configured-user",
                  })
                )
              )
            )
          )
        );
        expect(f.input?.databaseOptions).toMatchObject({
          "adbc.snowflake.sql.account": "configured",
          username: "configured-user",
        });
      })
  );

  it.effect("fails missing Config before opening the native database", () =>
    Effect.gen(function* rejectMissingConfiguration() {
      const f = fixture();

      const live = Snowflake.layerConfig({
        account: Config.String("ACCOUNT"),
      }).pipe(Layer.provide(f.layer));

      const error = yield* Snowflake.query("select").pipe(
        Effect.provide(
          live.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
          )
        ),
        Effect.flip
      );

      expect(String(error)).toContain("ACCOUNT");
      expect(f.events).toEqual([]);
    })
  );

  it.effect("layerFrom retains application acquisition dependencies", () =>
    Effect.gen(function* composeAcquisition() {
      const f = fixture();

      const acquire = pipe(
        Tenant,
        Effect.flatMap(({ id }) =>
          Snowflake.makeWithDriver({ account: `tenant-${id}` })
        )
      );

      const live = Snowflake.layerFrom(acquire).pipe(
        Layer.provide(f.layer),
        Layer.provide(Layer.succeed(Tenant, Tenant.of({ id: 42 })))
      );

      yield* Snowflake.execute("insert").pipe(Effect.provide(live));
      expect(f.input?.databaseOptions?.["adbc.snowflake.sql.account"]).toBe(
        "tenant-42"
      );
    })
  );

  it.effect(
    "composes a transactional workflow with flow and preserves its required services",
    () =>
      Effect.gen(function* composeTransaction() {
        const f = fixture();

        const insertAndRead = flow(
          (id: number) =>
            Snowflake.execute("insert", tableFromArrays({ id: [id] })),
          Effect.andThen(Snowflake.query("select")),
          Effect.map((table) => table.numRows),
          Snowflake.withTransaction
        );

        const result = yield* Effect.gen(function* getTenantAndRun() {
          const tenant = yield* Tenant;

          return yield* insertAndRead(tenant.id);
        }).pipe(
          Effect.provideService(Tenant, Tenant.of({ id: 1 })),
          Effect.provide(Snowflake.layer(options).pipe(Layer.provide(f.layer)))
        );

        expect(result).toBe(1);
        expect(f.events).toContain("commit");
        expect(f.events).not.toContain("rollback");
      })
  );

  it.effect(
    "runs captured repository operations on the active transaction session",
    () =>
      Effect.gen(function* transactCapturedRepositories() {
        const f = fixture();
        const live = Snowflake.layer(options).pipe(Layer.provide(f.layer));

        const repositories = Layer.mergeAll(readerLayer, writerLayer).pipe(
          Layer.provideMerge(live)
        );

        yield* Effect.gen(function* useCapturedRepositories() {
          const reader = yield* Reader;
          const writer = yield* Writer;
          yield* writer
            .write(1)
            .pipe(Effect.andThen(reader.read), Snowflake.withTransaction);
        }).pipe(Effect.provide(repositories));
        expect(f.events.indexOf("autocommit:false")).toBeLessThan(
          f.events.indexOf("sql:insert captured")
        );
        expect(f.events.indexOf("sql:select captured")).toBeLessThan(
          f.events.indexOf("commit")
        );
      })
  );

  it.effect("allows a captured client inside its callback transaction", () =>
    Effect.gen(function* transactCapturedClient() {
      const f = fixture();
      yield* Effect.scoped(
        Effect.gen(function* useCapturedClient() {
          const client = yield* Snowflake.makeWithDriver(options);
          yield* client.transaction(() =>
            client
              .query("captured")
              .pipe(Effect.andThen(client.execute("insert")))
          );
          expect(f.events).toContain("commit");
        })
      ).pipe(Effect.provide(f.layer));
    })
  );

  it.effect("rolls back a composed typed failure without replacing it", () =>
    Effect.gen(function* rollbackComposition() {
      const f = fixture();

      const program = Snowflake.execute("insert").pipe(
        Effect.andThen(Effect.fail("business" as const)),
        Snowflake.withTransaction
      );

      expect(
        yield* program.pipe(
          Effect.provide(Snowflake.layer(options).pipe(Layer.provide(f.layer))),
          Effect.flip
        )
      ).toBe("business");
      expect(f.events).toContain("rollback");
      expect(f.events).not.toContain("commit");
    })
  );

  it.effect("fails nested composable transactions promptly", () =>
    Effect.gen(function* rejectNestedTransaction() {
      const f = fixture();

      const error = yield* Snowflake.execute("nested").pipe(
        Snowflake.withTransaction,
        Snowflake.withTransaction,
        Effect.provide(Snowflake.layer(options).pipe(Layer.provide(f.layer))),
        Effect.flip
      );

      expect(error.operation).toBe("transaction.nested");
      expect(f.events).not.toContain("sql:nested");
      expect(f.events).toContain("rollback");
    })
  );

  it.effect(
    "expires an escaped transaction effect and restores normal client routing",
    () =>
      Effect.gen(function* expireTransactionEffect() {
        const f = fixture();
        yield* Effect.scoped(
          Effect.gen(function* captureExpiredSession() {
            const client = yield* Snowflake.makeWithDriver(options);

            const escaped = yield* client.transaction((session) =>
              Effect.succeed(session.query("escaped"))
            );

            expect((yield* escaped.pipe(Effect.flip)).operation).toBe("closed");
            expect(yield* client.execute("normal")).toBe(3);
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "does not route a different client into the active transaction",
    () =>
      Effect.gen(function* isolateClientSessions() {
        const first = fixture();
        const second = fixture();
        yield* Effect.scoped(
          Effect.gen(function* useTwoClients() {
            const a = yield* Snowflake.makeWithDriver(options).pipe(
              Effect.provide(first.layer)
            );

            const b = yield* Snowflake.makeWithDriver(options).pipe(
              Effect.provide(second.layer)
            );

            yield* a.transaction(() => b.execute("other-client"));
            expect(first.events).not.toContain("sql:other-client");
            expect(second.events).toContain("sql:other-client");
          })
        );
      })
  );

  it.effect(
    "keeps transaction context local to its fiber while outside work waits",
    () =>
      Effect.gen(function* isolateConcurrentWork() {
        const f = fixture();
        const gate = f.pause("query");
        yield* Effect.scoped(
          Effect.gen(function* queueOutsideTransaction() {
            const client = yield* Snowflake.makeWithDriver(options);

            const tx = yield* client
              .query("inside")
              .pipe(client.withTransaction, Effect.forkChild);

            yield* Effect.promise(() => gate.entered);

            const outside = yield* client
              .execute("outside")
              .pipe(Effect.forkChild);

            yield* Effect.yieldNow;
            expect(f.events).not.toContain("sql:outside");
            gate.release();
            yield* Fiber.join(tx);
            yield* Fiber.join(outside);
            expect(f.events.indexOf("commit")).toBeLessThan(
              f.events.indexOf("sql:outside")
            );
          })
        ).pipe(Effect.provide(f.layer));
      })
  );

  it.effect(
    "resolves a prebuilt stream through the active transaction session",
    () =>
      Effect.gen(function* transactStream() {
        const f = fixture();
        const batches = Snowflake.stream("stream inside");
        yield* batches.pipe(
          Stream.runDrain,
          Snowflake.withTransaction,
          Effect.provide(Snowflake.layer(options).pipe(Layer.provide(f.layer)))
        );
        expect(f.events).toContain("commit");
        expect(f.events.indexOf("statement.close")).toBeLessThan(
          f.events.indexOf("commit")
        );
      })
  );

  it("keeps service, error, and layer requirements in the inferred types", () => {
    expectTypeOf(Snowflake.query("select")).toEqualTypeOf<
      Effect.Effect<Table, Snowflake.SnowflakeError, Snowflake.Snowflake>
    >();
    expectTypeOf(Snowflake.layer(options)).toEqualTypeOf<
      Layer.Layer<Snowflake.Snowflake, Snowflake.SnowflakeError, AdbcDriver>
    >();

    const composed = Effect.gen(function* typedWorkflow() {
      const tenant = yield* Tenant;
      yield* Snowflake.execute("insert", tableFromArrays({ id: [tenant.id] }));

      return tenant;
    }).pipe(Snowflake.withTransaction);

    expectTypeOf(composed).toEqualTypeOf<
      Effect.Effect<
        { readonly id: number },
        Snowflake.SnowflakeError,
        TenantService | Snowflake.Snowflake
      >
    >();
  });
});
