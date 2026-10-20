import { it } from "@effect/vitest";
import { makeWithDriver } from "@rc312/effect-snowflake";
import { AdbcDriver } from "@rc312/effect-snowflake/adbc-driver";
import { Type, tableFromArrays } from "apache-arrow";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { describe, expect } from "vitest";

import { optionsFromEnv } from "../examples/options.ts";
import { queryExample, streamExample } from "../examples/scenarios.ts";
import { fixture, options } from "./fixture.ts";

const environment = {
  SNOWFLAKE_ACCOUNT: "org-account",
  SNOWFLAKE_DATABASE: "DB",
  SNOWFLAKE_SCHEMA: "PUBLIC",
  SNOWFLAKE_USERNAME: "user",
  SNOWFLAKE_WAREHOUSE: "WH",
};

describe("runnable example configuration", () => {
  it.effect("loads JWT defaults without inventing optional credentials", () =>
    Effect.gen(function* loadDefaults() {
      const config = yield* optionsFromEnv().pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(environment))
        )
      );

      expect(config).toMatchObject({
        account: "org-account",
        authenticator: "auth_jwt",
        database: "DB",
        driver: "snowflake",
        schema: "PUBLIC",
        username: "user",
        warehouse: "WH",
      });
      expect(config).not.toHaveProperty("password");
      expect(config).not.toHaveProperty("privateKey");
      expect(config).not.toHaveProperty("privateKeyPath");
    })
  );

  it.effect(
    "wraps configured secrets and honors native driver and role settings",
    () =>
      Effect.gen(function* loadCredentials() {
        const config = yield* optionsFromEnv().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ...environment,
                SNOWFLAKE_ADBC_DRIVER: "/driver.so",
                SNOWFLAKE_AUTHENTICATOR: "auth_oauth",
                SNOWFLAKE_PASSWORD: "password",
                SNOWFLAKE_PRIVATE_KEY: "pem",
                SNOWFLAKE_PRIVATE_KEY_PASS: "passphrase",
                SNOWFLAKE_PRIVATE_KEY_PATH: "/key.p8",
                SNOWFLAKE_ROLE: "ANALYST",
                SNOWFLAKE_TOKEN: "token",
              })
            )
          )
        );

        expect(config.driver).toBe("/driver.so");
        expect(config.role).toBe("ANALYST");
        expect(config.privateKeyPath).toBe("/key.p8");

        for (const value of [
          config.password,
          config.privateKey,
          config.privateKeyPass,
          config.token,
        ]) {
          expect(Redacted.isRedacted(value)).toBe(true);
          expect(String(value)).toContain("redacted");
        }
      })
  );

  it.effect(
    "rejects malformed authentication instead of silently using a default",
    () =>
      Effect.gen(function* rejectBadAuthenticator() {
        const error = yield* optionsFromEnv().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ...environment,
                SNOWFLAKE_AUTHENTICATOR: "SNOWFLAKE_JWT",
              })
            )
          ),
          Effect.flip
        );

        expect(String(error)).toContain("SNOWFLAKE_AUTHENTICATOR");
      })
  );

  it.effect(
    "reports missing required configuration before native loading",
    () =>
      Effect.gen(function* rejectMissingSettings() {
        const error = yield* optionsFromEnv().pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          Effect.flip
        );

        expect(String(error)).toContain("SNOWFLAKE_ACCOUNT");
      })
  );

  it.effect(
    "keeps example Arrow columns in SQL placeholder order and uses a typed null",
    () =>
      Effect.gen(function* bindExampleParameters() {
        const f = fixture();
        f.result = tableFromArrays({
          enabled: [true],
          id: ["9007199254740993"],
          label: ["hello ? -- Snowflake"],
          optional: [null],
        });

        const result = yield* Effect.scoped(
          Effect.gen(function* runExampleQuery() {
            const client = yield* makeWithDriver(options);

            return yield* queryExample(client);
          })
        ).pipe(
          Effect.provide(Layer.succeed(AdbcDriver, AdbcDriver.of(f.driver)))
        );

        expect(result).toEqual({
          enabled: true,
          id: "9007199254740993",
          label: "hello ? -- Snowflake",
          optional: null,
        });
        expect(f.bound?.schema.fields.map((field) => field.name)).toEqual([
          "enabled",
          "id",
          "label",
          "optional",
        ]);
        expect(f.bound?.getChild("id")?.get(0)).toBe(9_007_199_254_740_993n);
        expect(f.bound?.getChild("optional")?.type.typeId).toBe(Type.Utf8);
      })
  );

  it.effect(
    "counts batches and runs a follow-up query in the streaming example",
    () =>
      Effect.gen(function* runStreamExample() {
        const f = fixture();
        f.result = tableFromArrays({ status: ["ok"] });

        const result = yield* Effect.scoped(
          Effect.gen(function* streamExampleClient() {
            return yield* streamExample(yield* makeWithDriver(options));
          })
        ).pipe(
          Effect.provide(Layer.succeed(AdbcDriver, AdbcDriver.of(f.driver)))
        );

        expect(result).toEqual({
          firstBatchRows: 1,
          status: "ok",
          totalRows: 1,
        });
        expect(
          f.events.filter((event) => event === "statement.close")
        ).toHaveLength(3);
      })
  );
});
