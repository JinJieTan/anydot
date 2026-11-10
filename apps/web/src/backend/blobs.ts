import type { Store } from '@aitech/db/browser'
import type { BlobFiles } from '../../../desktop/src/main/data-transfer'
import type { MediaBlobs } from '../../../desktop/src/main/image-service'

/**
 * Content-addressed files, like the desktop's blobs/ folder: OPFS blobs/<sha256>,
 * or a Map when there is no OPFS. Rows only reference the hash; the mime type
 * lives in the blobs table.
 */
export class WebBlobs implements MediaBlobs, BlobFiles {
  private memory = new Map<string, Uint8Array>()

  private constructor(
    private readonly dir: FileSystemDirectoryHandle | null,
    private readonly store: Store,
  ) {}

  static async open(store: Store, persistent: boolean): Promise<WebBlobs> {
    const dir = persistent
      ? await navigator.storage
          .getDirectory()
          .then((root) => root.getDirectoryHandle('blobs', { create: true }))
          .catch(() => null)
      : null
    return new WebBlobs(dir, store)
  }

  async put(data: Uint8Array, mime: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    if (this.dir) {
      const handle = await this.dir.getFileHandle(sha256, { create: true })
      // A size mismatch is a write cut short (tab closed mid-write): write it again.
      if ((await handle.getFile()).size !== data.byteLength) {
        const access = await handle.createSyncAccessHandle()
        try {
          access.truncate(0)
          access.write(data, { at: 0 })
          access.flush()
        } finally {
          access.close()
        }
      }
    } else {
      this.memory.set(sha256, data)
    }
    this.store.addBlob(sha256, mime, data.byteLength)
    return sha256
  }

  async read(sha256: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid blob id')
    if (!this.dir) {
      const data = this.memory.get(sha256)
      if (!data) throw new Error('文件不存在')
      return data
    }
    const file = await (await this.dir.getFileHandle(sha256)).getFile()
    return new Uint8Array(await file.arrayBuffer())
  }

  mime(sha256: string): string {
    return this.store.getBlob(sha256)?.mime ?? 'application/octet-stream'
  }
}
