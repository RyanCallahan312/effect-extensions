import type { SnowflakeOptions } from "@rc312/effect-snowflake";
import { Config, Effect, Option, Redacted } from "effect";

/** Shared environment recipe for the runnable examples and live E2E suite. */
export const optionsFromEnv = Effect.fn("Snowflake.Example.options")(
  function* loadOptions() {
    const settings = yield* Config.all({
      account: Config.NonEmptyString("SNOWFLAKE_ACCOUNT"),
      authenticator: Config.Literals(
        [
          "auth_snowflake",
          "auth_jwt",
          "auth_oauth",
          "auth_ext_browser",
          "auth_okta",
          "auth_mfa",
          "auth_pat",
          "auth_wif",
        ],
        "SNOWFLAKE_AUTHENTICATOR"
      ).pipe(Config.withDefault("auth_jwt")),
      database: Config.NonEmptyString("SNOWFLAKE_DATABASE"),
      driver: Config.NonEmptyString("SNOWFLAKE_ADBC_DRIVER").pipe(
        Config.withDefault("snowflake")
      ),
      schema: Config.NonEmptyString("SNOWFLAKE_SCHEMA"),
      username: Config.NonEmptyString("SNOWFLAKE_USERNAME"),
      warehouse: Config.NonEmptyString("SNOWFLAKE_WAREHOUSE"),
    });

    const optional = yield* Config.all({
      password: Config.option(Config.Redacted("SNOWFLAKE_PASSWORD")),
      privateKey: Config.option(Config.Redacted("SNOWFLAKE_PRIVATE_KEY")),
      privateKeyPass: Config.option(
        Config.Redacted("SNOWFLAKE_PRIVATE_KEY_PASS")
      ),
      privateKeyPath: Config.option(
        Config.NonEmptyString("SNOWFLAKE_PRIVATE_KEY_PATH")
      ),
      role: Config.option(Config.NonEmptyString("SNOWFLAKE_ROLE")),
      token: Config.option(Config.Redacted("SNOWFLAKE_TOKEN")),
    });

    const options: SnowflakeOptions = {
      ...settings,
      databaseOptions: {
        "adbc.snowflake.sql.client_option.client_timeout": Redacted.make("30s"),
        "adbc.snowflake.sql.client_option.login_timeout": Redacted.make("30s"),
        "adbc.snowflake.sql.client_option.request_timeout":
          Redacted.make("60s"),
      },
    };

    if (Option.isSome(optional.password)) {
      Object.assign(options, { password: optional.password.value });
    }

    if (Option.isSome(optional.privateKey)) {
      Object.assign(options, { privateKey: optional.privateKey.value });
    }

    if (Option.isSome(optional.privateKeyPass)) {
      Object.assign(options, { privateKeyPass: optional.privateKeyPass.value });
    }

    if (Option.isSome(optional.privateKeyPath)) {
      Object.assign(options, { privateKeyPath: optional.privateKeyPath.value });
    }

    if (Option.isSome(optional.role)) {
      Object.assign(options, { role: optional.role.value });
    }

    if (Option.isSome(optional.token)) {
      Object.assign(options, { token: optional.token.value });
    }

    return options;
  }
);
