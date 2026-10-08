import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Store } from '@aitech/db'

/**
 * Content-addressed file store: blobs/ab/cd/<sha256>. Identical files are
 * stored once, and rows only reference the hash (see docs/PLAN.md §6).
 */
export class BlobStore {
  constructor(
    private readonly root: string,
    private readonly store: Store,
  ) {
    mkdirSync(root, { recursive: true })
  }

  pathOf(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid blob id')
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  }

  async put(data: Uint8Array, mime: string): Promise<string> {
    const sha256 = createHash('sha256').update(data).digest('hex')
    const path = this.pathOf(sha256)
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) {
      mkdirSync(dirname(path), { recursive: true })
      // Write then rename so a crash never leaves a truncated blob under its final name.
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, data)
      await rename(tmp, path)
    }
    this.store.addBlob(sha256, mime, data.byteLength)
    return sha256
  }

  async read(sha256: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathOf(sha256)))
  }

  mime(sha256: string): string {
    return this.store.getBlob(sha256)?.mime ?? 'application/octet-stream'
  }
}
