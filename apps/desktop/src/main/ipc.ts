import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from 'electron'
import { inferCapabilities, listModels, normalizeBaseUrl } from '@aitech/core'
import { schemaVersion, type ProviderRow, type Store } from '@aitech/db'
import {
  DEFAULT_SETTINGS,
  RPC_METHODS,
  type ProviderDTO,
  type ProviderInput,
  type Rpc,
  type RpcMethod,
  type Settings,
} from '../shared/ipc'
import type { BlobStore } from './blobs'
import type { ChatService } from './chat-service'
import { exportData, importData } from './data-transfer'
import type { AgentHost } from './agent-host'
import type { ArtifactServer } from './artifacts'
import type { Logger } from './logger'
import type { Scheduler } from './scheduler'
import type { AgentBrowser } from './browser'
import type { ChromeBridge } from './chrome-bridge'
import { exportExtensionZip, prepareInstall } from './chrome-extension'
import { computerPermissions, requestComputerPermission } from './computer-permissions'
import { openPreview } from './preview'
import { emit } from './events'
import { SUGGESTED_SHORTCUT } from './shell-integration'
import { addWorktree, changes, currentBranch, fileDiff, isRepo, removeWorktree } from './git'
import type { ImageService } from './image-service'
import type { McpService } from './mcp-service'
import type { RemoteService } from './remote-service'
import type { Updater } from './updater'
import { decryptKey, encryptKey, keyHint, keyStorageKind } from './secrets'

interface Deps {
  store: Store
  blobs: BlobStore
  chat: ChatService
  images: ImageService
  remote: RemoteService
  mcp: McpService
  browser: AgentBrowser
  chromeExt: ChromeBridge
  agent: AgentHost
  artifacts: ArtifactServer
  scheduler: Scheduler
  updater: Updater
  /** Applies tray / shortcut settings; returns an error when the shortcut can't be used. */
  applyShell: (s: Settings) => string | null
  logger: Logger
  dbPath: string
}

/** Files the artifact panel may open. */
const ARTIFACT_EXTS = new Set(['.html', '.htm', '.svg', '.md', '.markdown', '.mmd'])
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

const SETTINGS_KEY = 'app.settings'

/** Feedback always goes to the official relay, whichever relay the user pairs through. */
const FEEDBACK_URL = 'https://anydot.app/ctl/feedback'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function loadSettings(store: Store): Settings {
  return { ...DEFAULT_SETTINGS, ...store.getSetting<Partial<Settings>>(SETTINGS_KEY, {}) }
}

function toDTO(p: ProviderRow): ProviderDTO {
  const key = safeDecrypt(p.keyRef)
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    type: p.type,
    enabled: p.enabled,
    hasKey: !!key,
    keyHint: keyHint(key),
  }
}

function safeDecrypt(ref: string | null): string | null {
  try {
    return decryptKey(ref)
  } catch {
    // Keychain entry unreadable (e.g. data copied from another machine).
    return null
  }
}

function validateBaseUrl(url: string): string {
  const trimmed = url.trim()
  let normalized: string
  try {
    normalized = normalizeBaseUrl(trimmed)
  } catch {
    throw new Error('Base URL 格式不正确，例如 https://api.example.com')
  }
  if (!/^https?:\/\//.test(normalized)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  return trimmed.replace(/\/+$/, '')
}

function typedHandle<K extends RpcMethod>(
  method: K,
  fn: (...args: Parameters<Rpc[K]>) => ReturnType<Rpc[K]> | Promise<ReturnType<Rpc[K]>>,
) {
  ipcMain.handle(method, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...(args as Parameters<Rpc[K]>)) }
    } catch (err) {
      // Errors are returned, not thrown, so the renderer gets a clean message
      // instead of Electron's "Error invoking remote method ..." wrapper.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function registerIpc({
  store,
  blobs,
  chat,
  images,
  remote,
  mcp,
  browser,
  chromeExt,
  agent,
  artifacts,
  scheduler,
  updater,
  applyShell,
  logger,
  dbPath,
}: Deps): void {
  const getSettings = () => loadSettings(store)

  const handlers: { [K in RpcMethod]: (...args: Parameters<Rpc[K]>) => unknown } = {
    'app.info': () => ({
      version: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      db: { path: dbPath, schemaVersion: schemaVersion(store.db) },
      keyStorage: keyStorageKind(),
      logs: logger.dir,
    }),
    'app.logError': ({ message, stack, source }) =>
      logger.write('error', `renderer:${source}`, [`${message}\n${stack ?? ''}`.trimEnd()]),
    'app.revealLogs': async () => {
      await shell.openPath(logger.dir)
    },

    'updates.status': () => updater.get(),
    'updates.check': () => updater.check(),
    'updates.install': () => updater.install(),
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
            version: app.getVersion(),
            platform: `${process.platform} ${process.arch}`,
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

    'settings.get': getSettings,
    'settings.suggestedShortcut': () => SUGGESTED_SHORTCUT,
    'settings.set': async (patch) => {
      const prev = getSettings()
      const next = { ...prev, ...patch }
      if (patch.globalShortcut !== undefined || patch.trayIcon !== undefined) {
        const error = applyShell(next)
        if (error) {
          applyShell(prev)
          throw new Error(error)
        }
      }
      store.setSetting(SETTINGS_KEY, next)
      nativeTheme.themeSource = next.theme
      await chromeExt.setEnabled(next.browserTool && next.browserBackend === 'chrome')
      return next
    },

    'providers.list': () => store.listProviders().map(toDTO),
    'providers.create': (input: ProviderInput) => {
      const name = input.name.trim()
      if (!name) throw new Error('请填写名称')
      const key = input.apiKey?.trim()
      if (!key) throw new Error('请填写 API Key')
      const p = store.createProvider({
        name,
        baseUrl: validateBaseUrl(input.baseUrl),
        type: input.type,
        keyRef: encryptKey(key),
      })
      emit('invalidate', { scope: 'providers' })
      return toDTO(p)
    },
    'providers.update': (id, input) => {
      const patch: Parameters<Store['updateProvider']>[1] = {}
      if (input.name !== undefined) {
        if (!input.name.trim()) throw new Error('请填写名称')
        patch.name = input.name.trim()
      }
      if (input.baseUrl !== undefined) patch.baseUrl = validateBaseUrl(input.baseUrl)
      if (input.type !== undefined) patch.type = input.type
      if (input.enabled !== undefined) patch.enabled = input.enabled
      if (input.apiKey?.trim()) patch.keyRef = encryptKey(input.apiKey.trim())
      const p = store.updateProvider(id, patch)
      emit('invalidate', { scope: 'providers' })
      return toDTO(p)
    },
    'providers.delete': (id) => {
      store.deleteProvider(id)
      emit('invalidate', { scope: 'providers' })
    },
    'providers.test': async (target) => {
      const saved = target.id ? store.getProvider(target.id) : undefined
      const baseUrl = target.baseUrl ?? saved?.baseUrl
      const apiKey = target.apiKey?.trim() || safeDecrypt(saved?.keyRef ?? null)
      if (!baseUrl) return { ok: false, error: '请填写 Base URL' }
      if (!apiKey) return { ok: false, error: '请填写 API Key' }
      try {
        const models = await listModels(validateBaseUrl(baseUrl), apiKey)
        return { ok: true, models: models.length }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    'providers.syncModels': async (id) => {
      const p = store.getProvider(id)
      if (!p) throw new Error('服务商不存在')
      const key = safeDecrypt(p.keyRef)
      if (!key) throw new Error('服务商未配置 Key')
      const remote = await listModels(p.baseUrl, key)
      const caps = remote.map((m) => ({ id: m.id, capabilities: inferCapabilities(m.id, p.type) }))
      const { added } = store.syncModels(id, caps)
      emit('invalidate', { scope: 'models' })
      return { added, total: store.listModels(id).length }
    },

    'models.list': (providerId) => store.listModels(providerId),
    'models.available': () => store.listAvailableModels(),
    'models.add': ({ providerId, modelId, protocol }) => {
      const id = modelId.trim()
      if (!id) throw new Error('请填写模型 ID')
      const p = store.getProvider(providerId)
      if (!p) throw new Error('服务商不存在')
      store.syncModels(providerId, [{ id, capabilities: inferCapabilities(id, p.type) }])
      const row = store.listModels(providerId).find((m) => m.modelId === id)!
      const updated = protocol !== undefined ? store.updateModel(row.id, { protocol }) : row
      emit('invalidate', { scope: 'models' })
      return updated
    },
    'models.update': (id, patch) => {
      const m = store.updateModel(id, patch)
      emit('invalidate', { scope: 'models' })
      return m
    },
    'models.delete': (id) => {
      store.deleteModel(id)
      emit('invalidate', { scope: 'models' })
    },

    'projects.list': () => store.listProjects(),
    'conversations.setWorktree': async (id, enabled) => {
      const conv = store.getConversation(id)
      const project = conv?.projectId ? store.getProject(conv.projectId) : undefined
      if (!conv || !project) throw new Error('只有项目任务可以使用 worktree')
      if (conv.activeLeafId) throw new Error('任务开始后不能再切换 worktree')
      if (!!conv.worktreePath === enabled) return conv
      if (!enabled) {
        // Nothing ran there yet, so its branch goes too.
        await removeWorktree(
          project.rootPath,
          conv.worktreePath!,
          conv.worktreeBranch ? { deleteBranch: conv.worktreeBranch } : undefined,
        )
        return store.updateConversation(id, { worktreePath: null, worktreeBranch: null })
      }
      if (!(await isRepo(project.rootPath))) throw new Error('项目文件夹不是 git 仓库')
      const short = id.slice(-8)
      const slug =
        basename(project.rootPath)
          .replace(/[^\w.-]+/g, '-')
          .slice(0, 40) || 'project'
      const path = join(app.getPath('userData'), 'worktrees', `${slug}-${short}`)
      const branch = `anydot/${short}`
      await mkdir(dirname(path), { recursive: true })
      await addWorktree(project.rootPath, path, branch)
      return store.updateConversation(id, { worktreePath: path, worktreeBranch: branch })
    },
    'git.changes': async (conversationId) => {
      const folder = chat.folderOf(conversationId)
      if (!(await isRepo(folder))) return { repo: false, branch: null, folder, files: [] }
      return {
        repo: true,
        branch: await currentBranch(folder),
        folder,
        files: await changes(folder),
      }
    },
    'git.diff': ({ conversationId, path }) => fileDiff(chat.folderOf(conversationId), path),
    'schedules.list': () => scheduler.list(),
    'schedules.create': (input) => scheduler.create(input),
    'schedules.update': (id, patch) => scheduler.update(id, patch),
    'schedules.delete': (id) => scheduler.delete(id),
    'schedules.runNow': (id) => scheduler.runNow(id),
    'projects.create': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = {
        title: '选择项目文件夹',
        properties: ['openDirectory' as const, 'createDirectory' as const],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const dir = res.filePaths[0]
      if (res.canceled || !dir) return null
      const existing = store.listProjects().find((p) => p.rootPath === dir)
      if (existing) return existing
      const project = store.createProject({ name: basename(dir) || dir, rootPath: dir })
      emit('invalidate', { scope: 'projects' })
      return project
    },
    'projects.update': (id, patch) => {
      const p = store.updateProject(id, patch)
      if (patch.permissionMode) chat.projectModeChanged(id)
      emit('invalidate', { scope: 'projects' })
      return p
    },
    'projects.delete': (id) => {
      for (const c of store.listConversations({ projectId: id })) chat.stop(c.id)
      store.deleteProject(id)
      emit('invalidate', { scope: 'all' })
    },
    'projects.reveal': async (id) => {
      const p = store.getProject(id)
      if (!p) throw new Error('项目不存在')
      if (!(await stat(p.rootPath).catch(() => null)))
        throw new Error(`文件夹不存在：${p.rootPath}`)
      await shell.openPath(p.rootPath)
    },

    'conversations.list': (opts) => store.listConversations({ search: opts?.search }),
    'conversations.get': (id) => {
      const conversation = store.getConversation(id)
      return conversation ? { conversation, messages: store.listMessages(id) } : null
    },
    'conversations.create': async (input) => {
      const s = getSettings()
      const project = input?.projectId ? store.getProject(input.projectId) : undefined
      if (input?.projectId && !project) throw new Error('项目不存在')
      if (project && !(await stat(project.rootPath).catch(() => null))) {
        throw new Error(`项目文件夹不存在：${project.rootPath}`)
      }
      return store.createConversation({
        projectId: project?.id ?? null,
        modelId: input?.modelId ?? project?.defaultModelId ?? s.defaultModelId,
        thinking: s.defaultThinking,
      })
    },
    'conversations.update': (id, patch) => store.updateConversation(id, patch),
    'conversations.delete': async (id) => {
      const conv = store.getConversation(id)
      const plain = !conv?.projectId
      chat.stop(id)
      chat.clearJobs(id)
      store.deleteConversation(id)
      // The branch stays; a worktree with uncommitted changes is left alone.
      const root = conv?.projectId && store.getProject(conv.projectId)?.rootPath
      if (conv?.worktreePath && root)
        await removeWorktree(root, conv.worktreePath).catch((err: Error) =>
          console.warn('[git] worktree kept:', err.message),
        )
      if (plain) await rm(chat.workspaceDir(id), { recursive: true, force: true })
    },
    'conversations.revealWorkspace': async (id) => {
      const conv = store.getConversation(id)
      if (!conv) throw new Error('对话不存在')
      if (conv.projectId) throw new Error('项目对话没有单独的工作文件夹')
      const dir = chat.workspaceDir(id)
      await mkdir(dir, { recursive: true })
      await shell.openPath(dir)
    },

    'chat.send': ({ conversationId, text, attachments }) =>
      chat.send(conversationId, text, attachments),
    'chat.regenerate': ({ conversationId, userMessageId }) =>
      chat.regenerate(conversationId, userMessageId),
    'chat.edit': ({ conversationId, userMessageId, text, attachments }) =>
      chat.edit(conversationId, userMessageId, text, attachments),
    'chat.stop': (conversationId) => chat.stop(conversationId),
    'chat.commands': (conversationId) => chat.commands(conversationId),
    'chat.files': ({ conversationId, query }) => chat.findFiles(conversationId, query),
    'chat.switchBranch': ({ conversationId, messageId }) =>
      chat.switchBranch(conversationId, messageId),
    'chat.running': () => chat.runningConversations(),
    'chat.approve': ({ conversationId, toolCallId, decision, answers }) =>
      chat.approve(conversationId, toolCallId, decision, answers),
    'chat.approvals': () => chat.pendingApprovals(),
    'chat.rewindFiles': ({ conversationId, messageId, dryRun }) =>
      chat.rewindFiles(conversationId, messageId, !!dryRun),

    'remote.status': () => remote.status(),
    'remote.configure': (input) => remote.configure(input),
    'remote.detect': () => remote.detect(),
    'remote.pair': () => remote.createPairing(),
    'remote.pairCancel': () => remote.cancelPairing(),
    'remote.pairRespond': ({ requestId, accept }) => remote.respondPair(requestId, accept),
    'remote.revoke': (deviceId) => remote.revoke(deviceId),

    'mcp.list': () => mcp.list(),
    'mcp.save': (server) => mcp.upsert(server),
    'mcp.delete': (id) => mcp.remove(id),

    'preview.html': (html) => openPreview(html),
    'artifact.url': (html) => artifacts.put(html),
    'artifact.readFile': async ({ conversationId, path: p }) => {
      const path = resolve(chat.folderOf(conversationId), p)
      if (!ARTIFACT_EXTS.has(extname(path).toLowerCase())) throw new Error('不支持预览这种文件')
      if ((await stat(path)).size > MAX_ARTIFACT_BYTES) throw new Error('文件过大，无法预览')
      return { path, content: await readFile(path, 'utf8') }
    },

    'browser.show': () => browser.show(),
    'chromeExt.status': () => chromeExt.status(),
    'chromeExt.install': () => prepareInstall(),
    'chromeExt.exportZip': () => exportExtensionZip(),
    'computer.permissions': () => computerPermissions(),
    'computer.displays': () => agent.displays(),
    'computer.requestPermission': (kind) => requestComputerPermission(kind),

    'blobs.put': async ({ data, mime, name }) => {
      if (data.byteLength > 50 * 1024 * 1024) throw new Error('文件过大（上限 50MB）')
      const blob = await blobs.put(data, mime || 'application/octet-stream')
      return { blob, mime: mime || 'application/octet-stream', name }
    },
    'blobs.saveAs': async ({ sha256, suggestedName }) => {
      const win = BrowserWindow.getFocusedWindow()
      const ext = MIME_EXT[blobs.mime(sha256)]
      const name = ext ? suggestedName.replace(/\.[a-z0-9]+$/i, '') + `.${ext}` : suggestedName
      const opts = { defaultPath: name }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return false
      await copyFile(blobs.pathOf(sha256), res.filePath)
      return true
    },
    'blobs.copyImage': async (sha256) => {
      const img = nativeImage.createFromPath(blobs.pathOf(sha256))
      if (img.isEmpty()) throw new Error('无法读取图片')
      const png = new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' })
      await clipboard.write([new ClipboardItem({ 'image/png': png })])
    },

    'images.list': () => store.listImageJobs(),
    'images.generate': (input) => images.generate(input),
    'images.delete': (id) => images.delete(id),

    'data.export': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const date = new Date().toISOString().slice(0, 10)
      const opts = {
        defaultPath: `anydot-backup-${date}.zip`,
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, await exportData(store.db, blobs))
      return { path: res.filePath }
    },
    'data.import': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = {
        properties: ['openFile' as const],
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const path = res.filePaths[0]
      if (res.canceled || !path) return null
      const counts = await importData(store.db, blobs, new Uint8Array(await readFile(path)))
      emit('invalidate', { scope: 'all' })
      return counts
    },
  }

  for (const method of RPC_METHODS) {
    typedHandle(method, handlers[method] as never)
  }
}
