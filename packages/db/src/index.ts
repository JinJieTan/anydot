import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'

export type Database = DatabaseSync

/** Open (or create) the app database and bring its schema up to date. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function schemaVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/** Apply pending migrations, each in its own transaction. */
export function migrate(db: Database): number {
  const current = schemaVersion(db)
  if (current > migrations.length) {
    throw new Error(
      `Database schema v${current} is newer than this app supports (v${migrations.length}). Please update the app.`,
    )
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(migrations[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return migrations.length
}

export { migrations }
export { Store, newestLeafFrom, pathToLeaf } from './store'
export type {
  ConversationParams,
  ConversationRow,
  ImageJobParams,
  ImageJobRow,
  ImageJobStatus,
  MessageRow,
  ModelRow,
  PermissionMode,
  ProjectRow,
  ProviderRow,
} from './store'
