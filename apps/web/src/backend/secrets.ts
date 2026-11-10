import { base64ToBytes, bytesToBase64 } from '@aitech/core'

/**
 * API keys at rest, the web counterpart of the desktop's keychain: AES-GCM
 * with a non-extractable key the browser keeps in IndexedDB. A copied
 * database file is useless without it. Code running on this origin can still
 * use the key, which is why model-generated pages run on an opaque origin.
 */
const DB_NAME = 'anydot-keys'
const STORE = 'keys'
const KEY_ID = 'provider-keys'

let cryptoKey: Promise<CryptoKey> | null = null
/** Keep the key in IndexedDB; off: it lives only as long as this tab, so saved keys are forgotten. */
let persist = true

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function openStore(): Promise<IDBDatabase | null> {
  try {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    return await request(open)
  } catch {
    // No IndexedDB (some private modes): keys last as long as this tab, like the data.
    return null
  }
}

async function loadKey(): Promise<CryptoKey> {
  const db = persist ? await openStore() : null
  const existing =
    db &&
    (await request<CryptoKey | undefined>(db.transaction(STORE).objectStore(STORE).get(KEY_ID)))
  if (existing) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  if (db) await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(key, KEY_ID))
  return key
}

function key(): Promise<CryptoKey> {
  cryptoKey ??= loadKey()
  return cryptoKey
}

/**
 * The "forget keys when the page closes" setting. Turning it on deletes the
 * stored key (this tab keeps it in memory, so keys work until it closes);
 * turning it off stores the current key again. Call before the first use.
 */
export async function setPersistKeys(on: boolean): Promise<void> {
  persist = on
  if (!cryptoKey) return
  const db = await openStore()
  if (!db) return
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
  if (on) await request(store.put(await cryptoKey, KEY_ID))
  else await request(store.delete(KEY_ID))
}

export async function encryptKey(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(),
    new TextEncoder().encode(plain),
  )
  const out = new Uint8Array(iv.length + sealed.byteLength)
  out.set(iv)
  out.set(new Uint8Array(sealed), iv.length)
  return `web:${bytesToBase64(out)}`
}

export async function decryptKey(ref: string | null): Promise<string | null> {
  if (!ref) return null
  const [kind, data] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]
  if (kind === 'plain') return new TextDecoder().decode(base64ToBytes(data))
  if (kind !== 'web') return null
  const bytes = base64ToBytes(data)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await key(),
      bytes.slice(12),
    )
    return new TextDecoder().decode(plain)
  } catch {
    // Encrypted with a key this browser no longer has: treat as unset.
    return null
  }
}
