import type { ConnectOptions } from "@apache-arrow/adbc-driver-manager";
import { RecordBatchReader, tableFromArrays, tableToIPC } from "apache-arrow";
import type { Table } from "apache-arrow";
import { Context, Effect, Layer, Option, Scope } from "effect";

import { AdbcDriver } from "../src/adbc-driver.ts";
import type { Connection, Database, Statement } from "../src/adbc-driver.ts";

export const options = { account: "org-account", username: "user" };
export const secret = "secret SQL, bind, and credential data";

const createPause = () => {
  const entered = Promise.withResolvers<boolean>();
  const released = Promise.withResolvers<boolean>();

  return { entered, released };
};

export const fixture = () => {
  const events: string[] = [];
  const failures = new Set<string>();
  const rejections = new Set<string>();
  const pauses = new Map<string, ReturnType<typeof createPause>>();

  const settle = async (name: string) => {
    const pending = pauses.get(name);

    if (pending !== undefined) {
      pending.entered.resolve(true);
      await pending.released.promise;
    }

    if (rejections.has(name)) {
      throw new Error(secret);
    }
  };

  const started = Promise.withResolvers<boolean>();
  let queryGate: Promise<boolean> | undefined;
  let input: ConnectOptions | undefined;
  let bound: Table | undefined;
  let acquiringScope: Scope.Scope | undefined;

  let readerFactory:
    | (() => RecordBatchReader | Promise<RecordBatchReader>)
    | undefined;

  let result = tableFromArrays({
    id: new BigInt64Array([9_007_199_254_740_993n]),
    name: ["hello"],
  });

  const step = (name: string) => {
    events.push(name);

    if (failures.has(name)) {
      throw new Error(secret);
    }
  };

  const statement: Statement = {
    bind: (parameters) => {
      step("bind");
      bound = parameters;

      return settle("bind");
    },
    close: () => {
      step("statement.close");

      return settle("statement.close");
    },
    executeQuery: async () => {
      step("query");
      started.resolve(true);
      await queryGate;
      await settle("query");

      return readerFactory === undefined
        ? RecordBatchReader.from(tableToIPC(result))
        : readerFactory();
    },
    executeUpdate: () => {
      step("execute");

      return settle("execute").then(() => 3);
    },
    setSqlQuery: (sql) => {
      step(`sql:${sql}`);

      return settle("sql");
    },
  };

  const connection: Connection = {
    close: () => {
      step("connection.close");

      return settle("connection.close");
    },
    commit: () => {
      step("commit");

      return settle("commit");
    },
    createStatement: () => {
      step("statement.create");

      return settle("statement.create").then(() => ({ ...statement }));
    },
    rollback: () => {
      step("rollback");

      return settle("rollback");
    },
    setAutoCommit: (enabled) => step(`autocommit:${enabled}`),
  };

  const database: Database = {
    close: () => {
      step("database.close");

      return settle("database.close");
    },
    connect: () => {
      step("connect");

      return settle("connect").then(() => connection);
    },
  };

  const driver = {
    open: (config: ConnectOptions) =>
      Effect.gen(function* openFixtureDatabase() {
        step("open");
        input = config;
        acquiringScope = Option.getOrUndefined(
          Context.getOption(yield* Effect.context<never>(), Scope.Scope)
        );

        return database;
      }),
  };

  const layer = Layer.succeed(AdbcDriver, AdbcDriver.of(driver));

  return {
    get acquiringScope() {
      return acquiringScope;
    },
    get bound() {
      return bound;
    },
    driver,
    events,
    failures,
    get input() {
      return input;
    },
    layer,
    pause: (name: string) => {
      const gate = createPause();
      pauses.set(name, gate);

      return {
        entered: gate.entered.promise,
        release: () => gate.released.resolve(true),
      };
    },
    get queryGate() {
      return queryGate;
    },
    set queryGate(value: Promise<boolean> | undefined) {
      queryGate = value;
    },
    get readerFactory() {
      return readerFactory;
    },
    set readerFactory(
      value: (() => RecordBatchReader | Promise<RecordBatchReader>) | undefined
    ) {
      readerFactory = value;
    },
    rejections,
    get result() {
      return result;
    },
    set result(value: Table) {
      result = value;
    },
    started,
  };
};
