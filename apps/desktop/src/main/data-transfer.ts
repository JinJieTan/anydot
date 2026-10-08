import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { BlobStore } from './blobs'

/**
 * Backup format: a zip with data.json (rows, keys stripped) and blobs/<sha256>.
 * Import is additive and idempotent: rows are inserted by primary key and
 * existing ids are left untouched, so importing the same file twice is safe.
 */
const FORMAT = 'aitech-export'
const VERSION = 1

const TABLES = [
  'providers',
  'models',
  'projects',
  'conversations',
  'messages',
  'image_jobs',
] as const
type Table = (typeof TABLES)[number]

type Row = Record<string, SQLInputValue>

interface ExportData {
  format: typeof FORMAT
  version: number
  schemaVersion: number
  exportedAt: number
  tables: Record<Table, Row[]>
  blobs: { sha256: string; mime: string; size: number; created_at: number }[]
}

export async function exportData(db: DatabaseSync, blobs: BlobStore): Promise<Uint8Array> {
  const tables = {} as Record<Table, Row[]>
  for (const t of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t} WHERE deleted_at IS NULL`).all() as Row[]
    // API keys never leave the machine.
    tables[t] = t === 'providers' ? rows.map((r) => ({ ...r, key_ref: null })) : rows
  }
  const blobRows = db
    .prepare('SELECT sha256, mime, size, created_at FROM blobs')
    .all() as ExportData['blobs']
  const schemaVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version

  const data: ExportData = {
    format: FORMAT,
    version: VERSION,
    schemaVersion,
    exportedAt: Date.now(),
    tables,
    blobs: blobRows,
  }

  const files: Zippable = { 'data.json': strToU8(JSON.stringify(data)) }
  for (const b of blobRows) {
    try {
      // Images are already compressed; store them as-is.
      files[`blobs/${b.sha256}`] = [await blobs.read(b.sha256), { level: 0 }]
    } catch {
      // Missing file on disk: skip rather than fail the whole export.
    }
  }
  return zipSync(files, { level: 6 })
}

export interface ImportCounts {
  providers: number
  conversations: number
  messages: number
  imageJobs: number
}

export async function importData(
  db: DatabaseSync,
  blobs: BlobStore,
  zip: Uint8Array,
): Promise<ImportCounts> {
  const files = unzipSync(zip)
  const raw = files['data.json']
  if (!raw) throw new Error('不是有效的导出文件（缺少 data.json）')
  const data = JSON.parse(strFromU8(raw)) as ExportData
  if (data.format !== FORMAT) throw new Error('不是有效的导出文件')
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (data.schemaVersion > current) {
    throw new Error('该文件来自更新版本的应用，请先升级')
  }

  for (const b of data.blobs) {
    const bytes = files[`blobs/${b.sha256}`]
    if (bytes) await blobs.put(bytes, b.mime)
  }

  const counts: ImportCounts = { providers: 0, conversations: 0, messages: 0, imageJobs: 0 }
  // FK checks off for the import: an export only carries live rows, but a live
  // conversation may still point at a since-deleted model. The app tolerates
  // such dangling references (it falls back to the default model).
  // Must be set outside a transaction to take effect.
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    for (const t of TABLES) {
      const rows = data.tables[t] ?? []
      if (!rows.length) continue
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
      )
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => columns.has(c))
        const res = db
          .prepare(
            `INSERT OR IGNORE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          )
          .run(...cols.map((c) => row[c] ?? null))
        if (res.changes) {
          if (t === 'providers') counts.providers++
          else if (t === 'conversations') counts.conversations++
          else if (t === 'messages') counts.messages++
          else if (t === 'image_jobs') counts.imageJobs++
        }
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  return counts
}
