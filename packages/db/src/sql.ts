/**
 * The slice of a synchronous SQLite API the store needs. `node:sqlite`'s
 * DatabaseSync satisfies it as-is; the web app wraps SQLite WASM to match.
 */
export type SqlValue = null | number | bigint | string | Uint8Array

export interface SqlStatement {
  all(...params: SqlValue[]): unknown[]
  get(...params: SqlValue[]): unknown
  run(...params: SqlValue[]): { changes: number | bigint }
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  exec(sql: string): void
}
