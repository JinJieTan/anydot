import { schemaVersion, type SqlDatabase, type Store } from '@aitech/db/browser'
import { exportData, importData } from '../../../desktop/src/main/data-transfer'
import type { ImageService } from '../../../desktop/src/main/image-service'
import { loadSettings, providerHandlers, SETTINGS_KEY } from '../../../desktop/src/shared/handlers'
import type { EventName, Events, RemoteStatusDTO } from '../../../desktop/src/shared/ipc'
import type { HandlerMap, StorageMode, WorkerRpc } from '../protocol'
import type { WebBlobs } from './blobs'
import type { WebChatService } from './chat'

/** Feedback goes to the official relay, as from the desktop app. */
const FEEDBACK_URL = 'https://anydot.app/ctl/feedback'

export interface BackendDeps {
  db: SqlDatabase
  store: Store
  blobs: WebBlobs
  chat: WebChatService
  images: ImageService
  storage: StorageMode
  version: string
  encryptKey: (key: string) => Promise<string>
  decryptKey: (ref: string | null) => Promise<string | null>
  /** Keep (true) or stop keeping the key that encrypts API keys. */
  persistKeys: (on: boolean) => Promise<void>
  emit: <K extends EventName>(name: K, payload: Events[K]) => void
  close: () => void
}

const NO_REMOTE: RemoteStatusDTO = {
  enabled: false,
  relayUrl: null,
  state: 'disabled',
  hasToken: false,
  providerId: null,
  deviceId: '',
  deviceName: '',
  devices: [],
  pairing: null,
  activeDevices: [],
}

/** Everything the worker answers: the 'worker' and 'stub' methods of WEB_SUPPORT, plus internals. */
export function createHandlers(deps: BackendDeps): HandlerMap<WorkerRpc> {
  const { db, store, blobs, chat, images, emit } = deps
  const unsupported = {
    state: 'unsupported',
    current: deps.version,
    version: null,
    progress: null,
    error: null,
  } as const

  return {
    'app.info': () => ({
      version: deps.version,
      platform: 'web',
      versions: { electron: '', chrome: navigator.userAgent, node: '' },
      db: {
        path: deps.storage === 'opfs' ? '浏览器存储（OPFS）' : '内存（关闭页面后丢失）',
        schemaVersion: schemaVersion(db),
      },
      keyStorage: 'browser',
      logs: '',
    }),
    'app.logError': ({ message, stack, source }) =>
      console.error(`[renderer:${source}]`, message, stack ?? ''),
    'feedback.send': async ({ message, contact }) => {
      const text = message.trim()
      if (!text) throw new Error('请写下反馈内容')
      let res: Response
      try {
        res = await fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            contact: contact?.trim() ?? '',
            version: deps.version,
            platform: `web ${navigator.userAgent}`,
          }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error('发送失败，请检查网络后重试')
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `发送失败（${res.status}）`)
      }
    },
    'updates.status': () => unsupported,
    'updates.check': () => unsupported,

    'settings.get': () => loadSettings(store),
    'settings.set': async (patch) => {
      const next = { ...loadSettings(store), ...patch }
      if (patch.webForgetKeys !== undefined) await deps.persistKeys(!patch.webForgetKeys)
      store.setSetting(SETTINGS_KEY, next)
      return next
    },
    'settings.suggestedShortcut': () => '',

    ...providerHandlers({
      store,
      encryptKey: deps.encryptKey,
      decryptKey: deps.decryptKey,
      invalidate: (scope) => emit('invalidate', { scope }),
    }),

    'conversations.list': (opts) => store.listConversations({ search: opts?.search }),
    'conversations.get': (id) => {
      const conversation = store.getConversation(id)
      return conversation ? { conversation, messages: store.listMessages(id) } : null
    },
    'conversations.create': (input) => {
      if (input?.projectId) throw new Error('网页版没有项目，请使用桌面端')
      const s = loadSettings(store)
      return store.createConversation({
        projectId: null,
        modelId: input?.modelId ?? s.defaultModelId,
        thinking: s.defaultThinking,
      })
    },
    'conversations.update': (id, patch) => store.updateConversation(id, patch),
    'conversations.delete': (id) => {
      chat.stop(id)
      store.deleteConversation(id)
    },

    'chat.send': ({ conversationId, text, attachments }) =>
      chat.send(conversationId, text, attachments),
    'chat.regenerate': ({ conversationId, userMessageId }) =>
      chat.regenerate(conversationId, userMessageId),
    'chat.edit': ({ conversationId, userMessageId, text, attachments }) =>
      chat.edit(conversationId, userMessageId, text, attachments),
    'chat.stop': (conversationId) => chat.stop(conversationId),
    'chat.switchBranch': ({ conversationId, messageId }) =>
      chat.switchBranch(conversationId, messageId),
    'chat.running': () => chat.runningConversations(),
    'chat.commands': () => [],
    'chat.files': () => [],
    'chat.approvals': () => [],

    'projects.list': () => [],
    'schedules.list': () => [],
    'remote.status': () => NO_REMOTE,
    'mcp.list': () => ({ servers: [], status: [] }),
    'skills.list': () => ({ roots: [], items: [] }),
    'chromeExt.status': () => ({
      listening: false,
      port: null,
      connected: false,
      extensionVersion: null,
      userAgent: null,
      expectedVersion: '',
    }),
    'computer.permissions': () => ({
      supported: false,
      accessibility: false,
      screen: 'unknown',
    }),
    'computer.displays': () => [],

    'blobs.put': async ({ data, mime, name }) => {
      if (data.byteLength > 50 * 1024 * 1024) throw new Error('文件过大（上限 50MB）')
      const type = mime || 'application/octet-stream'
      return { blob: await blobs.put(data, type), mime: type, name }
    },

    'images.list': () => store.listImageJobs(),
    'images.generate': (input) => images.generate(input),
    'images.delete': (id) => images.delete(id),

    '__blob.read': async (sha256) => ({ data: await blobs.read(sha256), mime: blobs.mime(sha256) }),
    '__data.export': () => exportData(db, blobs),
    '__data.import': async (zip) => {
      const counts = await importData(db, blobs, zip)
      emit('invalidate', { scope: 'all' })
      return counts
    },
    __close: () => {
      chat.stopAll()
      images.stopAll()
      deps.close()
    },
  }
}
