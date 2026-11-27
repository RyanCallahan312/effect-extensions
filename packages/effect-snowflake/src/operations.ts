/** Stable operation labels emitted by the built-in Snowflake client and driver. */
export const SnowflakeOperation = Object.freeze({
  Closed: "closed",
  Connect: "connect",
  ConnectionClose: "connection.close",
  DatabaseClose: "database.close",
  DatabaseOpen: "database.open",
  DriverLoad: "driver.load",
  Execute: "execute",
  Options: "options",
  Query: "query",
  QueryRead: "query.read",
  ReaderClose: "reader.close",
  StatementBind: "statement.bind",
  StatementClose: "statement.close",
  StatementCreate: "statement.create",
  StatementSql: "statement.sql",
  StreamRead: "stream.read",
  TransactionAutoCommit: "transaction.autocommit",
  TransactionCommit: "transaction.commit",
  TransactionInvalidated: "transaction.invalidated",
  TransactionNested: "transaction.nested",
  TransactionRollback: "transaction.rollback",
} as const);

export type SnowflakeOperationLabel =
  (typeof SnowflakeOperation)[keyof typeof SnowflakeOperation];
