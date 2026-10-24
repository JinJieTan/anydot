import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { backupBeforeMigrate, migrate, migrations, openDatabase, schemaVersion } from './index'

const tables = (db: DatabaseSync) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string
    }[]
  ).map((r) => r.name)

describe('migrate', () => {
  it('creates the schema on a fresh database', () => {
    const db = openDatabase(':memory:')
    expect(schemaVersion(db)).toBe(migrations.length)
    expect(tables(db)).toEqual(
      expect.arrayContaining(['providers', 'models', 'conversations', 'messages', 'blobs']),
    )
  })

  it('is idempotent', () => {
    const db = openDatabase(':memory:')
    expect(() => migrate(db)).not.toThrow()
    expect(schemaVersion(db)).toBe(migrations.length)
  })

  it('refuses a database from a newer app version', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    expect(() => migrate(db)).toThrow(/newer than this app supports/)
  })

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:')
    const insert = db.prepare(
      `INSERT INTO messages (id, conversation_id, role, parts_json, created_at, updated_at, device_id)
       VALUES ('m1', 'missing', 'user', '[]', 0, 0, 'd')`,
    )
    expect(() => insert.run()).toThrow(/FOREIGN KEY/)
  })
})

describe('backups before migration', () => {
  const oldDatabase = (dir: string) => {
    const path = join(dir, 'aitech.db')
    const raw = new DatabaseSync(path)
    for (const m of migrations.slice(0, -1)) raw.exec(m)
    raw.exec(`PRAGMA user_version = ${migrations.length - 1}`)
    raw.exec("INSERT INTO settings (key, value_json, updated_at) VALUES ('k', '1', 1)")
    raw.close()
    return path
  }

  // Several real SQLite files on disk: slow on Windows CI runners.
  it('copies an outdated database before migrating it, keeping the newest three', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitech-db-'))
    try {
      const path = oldDatabase(dir)
      const backups: string[] = []
      const db = openDatabase(path, { onBackup: (f) => backups.push(f) })
      expect(schemaVersion(db)).toBe(migrations.length)
      db.close()
      expect(backups).toHaveLength(1)
      const copy = new DatabaseSync(backups[0]!)
      expect(schemaVersion(copy)).toBe(migrations.length - 1)
      expect(copy.prepare('SELECT value_json FROM settings WHERE key = ?').get('k')).toEqual({
        value_json: '1',
      })
      copy.close()

      // Already current: no new backup.
      openDatabase(path, { onBackup: (f) => backups.push(f) }).close()
      expect(backups).toHaveLength(1)

      // Older backups are pruned.
      const raw = new DatabaseSync(join(dir, 'x.db'))
      raw.exec(migrations[0]!)
      raw.exec('PRAGMA user_version = 1')
      for (let i = 0; i < 5; i++) backupBeforeMigrate(raw, join(dir, 'x.db'), new Date(1e12 + i))
      raw.close()
      expect(readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('x-')).length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('makes no backup of a new or in-memory database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitech-db-'))
    try {
      const backups: string[] = []
      openDatabase(join(dir, 'new.db'), { onBackup: (f) => backups.push(f) }).close()
      expect(backups).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
