import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'
import { migrate, schemaVersion } from './schema'

export type Database = DatabaseSync

/** Pre-migration backups kept per database. */
const KEEP_BACKUPS = 3

/**
 * Open (or create) the app database and bring its schema up to date. Before
 * an existing database is migrated, a copy goes to `backups/` next to it.
 */
export function openDatabase(
  path: string,
  opts: { onBackup?: (file: string) => void } = {},
): Database {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') {
    const file = backupBeforeMigrate(db, path)
    if (file) opts.onBackup?.(file)
  }
  migrate(db)
  return db
}

/** Snapshot a database that is about to be migrated; returns the backup's path. */
export function backupBeforeMigrate(db: Database, path: string, now = new Date()): string | null {
  const version = schemaVersion(db)
  // Brand new, already current, or too new (migrate refuses those): nothing to protect.
  if (version === 0 || version >= migrations.length) return null
  const dir = join(dirname(path), 'backups')
  mkdirSync(dir, { recursive: true })
  const name = basename(path).replace(/\.db$/, '')
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${name}-v${version}-${stamp}.db`)
  // VACUUM INTO writes a consistent copy, WAL contents included.
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}-v`) && f.endsWith('.db'))
    .sort()
  for (const f of old.slice(0, -KEEP_BACKUPS)) rmSync(join(dir, f), { force: true })
  return file
}

export { migrations }
export { migrate, schemaVersion } from './schema'
export type { SqlDatabase, SqlStatement, SqlValue } from './sql'
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
  ScheduleInput,
  ScheduleRow,
  TrustedDeviceRow,
} from './store'
