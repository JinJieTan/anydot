import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate, migrations, openDatabase, schemaVersion } from './index'

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
