import { migrations } from './migrations'
import type { SqlDatabase } from './sql'

export function schemaVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/** Apply pending migrations, each in its own transaction. */
export function migrate(db: SqlDatabase): number {
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
