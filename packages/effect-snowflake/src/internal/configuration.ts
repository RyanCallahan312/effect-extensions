import type { ConnectOptions } from "@apache-arrow/adbc-driver-manager";
import { Redacted } from "effect";

import type { SnowflakeOptions } from "../models.ts";

export const configuration = (options: SnowflakeOptions): ConnectOptions => {
  const databaseOptions = Object.fromEntries(
    Object.entries(options.databaseOptions ?? {}).map(([key, value]) => [
      key,
      Redacted.value(value),
    ])
  );

  const values = [
    ["adbc.snowflake.sql.account", options.account],
    ["username", options.username],
    ["adbc.snowflake.sql.db", options.database],
    ["adbc.snowflake.sql.schema", options.schema],
    ["adbc.snowflake.sql.warehouse", options.warehouse],
    ["adbc.snowflake.sql.role", options.role],
    ["adbc.snowflake.sql.auth_type", options.authenticator],
    [
      "adbc.snowflake.sql.client_option.jwt_private_key",
      options.privateKeyPath,
    ],
  ] as const;

  for (const [key, value] of values) {
    if (value !== undefined) {
      databaseOptions[key] = value;
    }
  }

  const secrets = [
    ["password", options.password],
    ["adbc.snowflake.sql.client_option.auth_token", options.token],
    [
      "adbc.snowflake.sql.client_option.jwt_private_key_pkcs8_value",
      options.privateKey,
    ],
    [
      "adbc.snowflake.sql.client_option.jwt_private_key_pkcs8_password",
      options.privateKeyPass,
    ],
  ] as const;

  for (const [key, value] of secrets) {
    if (value !== undefined) {
      databaseOptions[key] = Redacted.value(value);
    }
  }

  const config: ConnectOptions = {
    databaseOptions,
    driver: options.driver ?? "snowflake",
  };

  if (options.manifestSearchPaths !== undefined) {
    config.manifestSearchPaths = [...options.manifestSearchPaths];
  }

  return config;
};
