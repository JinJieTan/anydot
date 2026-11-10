/// <reference lib="webworker" />
/**
 * The web app's backend, in the role the Electron main process plays on
 * desktop: owns the database, the blob files and every model call, and
 * answers the page's RPC calls. Started by the page once it holds the
 * database lock (see main.ts).
 */
import { newId } from '@aitech/core'
import { Store } from '@aitech/db/browser'
import { ImageService } from '../../../desktop/src/main/image-service'
import {
  DEFAULT_PROVIDER_URL,
  seedDefaultProvider,
} from '../../../desktop/src/shared/default-provider'
import { loadSettings } from '../../../desktop/src/shared/handlers'
import type { EventName, Events } from '../../../desktop/src/shared/ipc'
import type { FromWorker, ToWorker, WorkerMethod } from '../protocol'
import { WebBlobs } from './blobs'
import { WebChatService } from './chat'
import { createHandlers } from './handlers'
import { decryptKey, encryptKey, setPersistKeys } from './secrets'
import { openDatabase } from './sqlite'

declare const self: DedicatedWorkerGlobalScope
declare const __APP_VERSION__: string

const post = (msg: FromWorker) => self.postMessage(msg)
const emit = <K extends EventName>(name: K, payload: Events[K]) =>
  post({ type: 'event', name, payload })

async function start() {
  const opened = await openDatabase()
  const bootstrap = new Store(opened.db, 'bootstrap')
  let deviceId = bootstrap.getSetting<string | null>('deviceId', null)
  if (!deviceId) {
    deviceId = newId()
    bootstrap.setSetting('deviceId', deviceId)
  }
  const store = new Store(opened.db, deviceId)
  await setPersistKeys(!loadSettings(store).webForgetKeys)
  store.recoverStreaming()
  store.recoverImageJobs()

  const blobs = await WebBlobs.open(store, opened.storage === 'opfs')
  const chat = new WebChatService(
    store,
    blobs,
    () => loadSettings(store),
    decryptKey,
    (e) => emit('chat', e),
  )
  const images = new ImageService(store, blobs, (job) => emit('image', job), decryptKey)
  void images.resume()

  const handlers = createHandlers({
    db: opened.db,
    store,
    blobs,
    chat,
    images,
    storage: opened.storage,
    version: __APP_VERSION__,
    encryptKey,
    decryptKey,
    persistKeys: setPersistKeys,
    emit,
    close: opened.close,
  })

  self.onmessage = async (e: MessageEvent<ToWorker>) => {
    const { id, method, args } = e.data
    const fn = handlers[method as WorkerMethod] as ((...a: unknown[]) => unknown) | undefined
    try {
      if (!fn) throw new Error(`unknown method ${method}`)
      post({ type: 'result', id, ok: true, value: await fn(...args) })
    } catch (err) {
      post({
        type: 'result',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  post({ type: 'ready', storage: opened.storage, reason: opened.reason })

  // VITE_DEFAULT_LLM_URL points at a local relay in dev.
  const defaultUrl =
    (import.meta.env.VITE_DEFAULT_LLM_URL as string | undefined) ?? DEFAULT_PROVIDER_URL
  void seedDefaultProvider(store, encryptKey, defaultUrl)
    .then((added) => added && emit('invalidate', { scope: 'all' }))
    .catch((err: unknown) => console.warn('default provider:', err))
}

start().catch((err: unknown) =>
  post({ type: 'fatal', error: err instanceof Error ? err.message : String(err) }),
)
