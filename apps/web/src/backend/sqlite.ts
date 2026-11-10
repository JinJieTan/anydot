import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm'
import { migrate, type SqlDatabase, type SqlValue } from '@aitech/db/browser'
import type { StorageMode } from '../protocol'

export interface OpenedDatabase {
  db: SqlDatabase
  storage: StorageMode
  /** Why the database is in memory. */
  reason?: string
  /** Close the database and release its OPFS files (another tab takes over). */
  close: () => void
}

const DB_FILE = '/anydot.db'

/**
 * Open the app database. The "opfs-sahpool" VFS keeps it in the origin
 * private file system without needing cross-origin isolation (COOP/COEP),
 * which would block the providers' images and videos. It holds the files
 * exclusively, so only one tab can have it open; the page takes a Web Lock
 * before starting this worker. Without OPFS the database lives in memory.
 */
export async function openDatabase(): Promise<OpenedDatabase> {
  const sqlite3 = await sqlite3InitModule()
  let opened: { raw: Database; storage: StorageMode; reason?: string; release?: () => void }
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'anydot' })
    opened = {
      raw: new pool.OpfsSAHPoolDb(DB_FILE),
      storage: 'opfs',
      release: () => pool.pauseVfs(),
    }
  } catch (err) {
    opened = {
      raw: new sqlite3.oo1.DB(':memory:'),
      storage: 'memory',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  const db = wrap(opened.raw)
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return {
    db,
    storage: opened.storage,
    reason: opened.reason,
    close: () => {
      opened.raw.close()
      opened.release?.()
    },
  }
}

/** The oo1 API shaped like node:sqlite's DatabaseSync, as far as the store uses it. */
export function wrap(raw: Database): SqlDatabase {
  const bind = (params: SqlValue[]) => (params.length ? params : undefined)
  const rows = (sql: string, params: SqlValue[]) =>
    raw.exec({ sql, bind: bind(params), rowMode: 'object', returnValue: 'resultRows' })
  return {
    exec: (sql) => void raw.exec(sql),
    prepare: (sql) => ({
      all: (...params) => rows(sql, params),
      get: (...params) => rows(sql, params)[0],
      run: (...params) => {
        raw.exec({ sql, bind: bind(params) })
        return { changes: raw.changes() }
      },
    }),
  }
}
