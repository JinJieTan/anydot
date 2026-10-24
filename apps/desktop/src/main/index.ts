import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron'
import type { BrowserCommand } from '@aitech/agent'
import { newId } from '@aitech/core'
import { openDatabase, Store } from '@aitech/db'
import { AgentHost } from './agent-host'
import { ARTIFACT_SCHEME, ArtifactServer } from './artifacts'
import { BlobStore } from './blobs'
import { AgentBrowser } from './browser'
import { ChromeBridge } from './chrome-bridge'
import {
  ALLOWED_EXTENSION_IDS,
  EXTENSION_VERSION,
  refreshInstalledExtension,
} from './chrome-extension'
import { WebSearch } from './search'
import { ChatService } from './chat-service'
import { emit } from './events'
import { ImageService } from './image-service'
import { Logger } from './logger'
import { loadSettings, registerIpc } from './ipc'
import { McpService } from './mcp-service'
import { Notifier } from './notifier'
import { RemoteService } from './remote-service'
import { Scheduler } from './scheduler'
import { ShellIntegration } from './shell-integration'
import { Updater } from './updater'

/** Serves local blobs to the renderer as aitech-blob://blob/<sha256>. */
const BLOB_SCHEME = 'aitech-blob'

// Separate data dir for development and automated tests.
if (process.env['AITECH_USER_DATA']) app.setPath('userData', process.env['AITECH_USER_DATA'])
else {
  // The app was called aitech before AnyDot. Electron creates the new userData
  // folder before this runs, so look for our data rather than the folder, and
  // keep using the old folder when that's where the data is.
  const legacy = join(app.getPath('appData'), 'aitech')
  const current = app.getPath('userData')
  if (!existsSync(join(current, 'data')) && existsSync(join(legacy, 'data'))) {
    app.setPath('userData', legacy)
  }
}

// Logs live next to the data, so a support request needs just one folder.
app.setAppLogsPath(join(app.getPath('userData'), 'logs'))
const logger = new Logger(app.getPath('logs'))
logger.captureConsole()
console.info(`AnyDot ${app.getVersion()} starting (${process.platform} ${process.arch})`)

// An error in one handler shouldn't take the whole app (and the user's running tasks) down.
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err))
process.on('unhandledRejection', (reason) => console.error('[unhandled rejection]', reason))
app.on('render-process-gone', (_event, contents, details) =>
  console.error('[renderer gone]', details.reason, details.exitCode, contents.getURL()),
)
app.on('child-process-gone', (_event, details) =>
  console.error('[child process gone]', details.type, details.name ?? '', details.reason),
)

protocol.registerSchemesAsPrivileged([
  { scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } },
])

const artifacts = new ArtifactServer()
const updater = new Updater((status) => emit('update', status))

const agent = new AgentHost()
agent.onOutput = (stream, text) => {
  const out = text.trimEnd()
  if (!out) return
  ;(stream === 'stderr' ? process.stderr : process.stdout).write(`${text}`)
  logger.write(stream === 'stderr' ? 'error' : 'info', 'agent', [out])
}
const browser = new AgentBrowser()
const webSearch = new WebSearch()
const chromeExt = new ChromeBridge({
  allowedIds: ALLOWED_EXTENSION_IDS,
  appVersion: app.getVersion(),
  extensionVersion: EXTENSION_VERSION,
  onStatus: (s) => emit('chrome-ext', s),
})
agent.onHostCall = (method, params) => {
  if (method === 'browser') {
    const useChrome = store && loadSettings(store).browserBackend === 'chrome'
    return useChrome
      ? chromeExt.exec(params as BrowserCommand)
      : browser.exec(params as BrowserCommand)
  }
  if (method === 'search') {
    const { query, limit } = params as { query: string; limit: number }
    return webSearch.search(query, limit)
  }
  return Promise.reject(new Error(`unknown host method ${method}`))
}
let store: Store | null = null
let chat: ChatService | null = null
let images: ImageService | null = null
let remote: RemoteService | null = null
let scheduler: Scheduler | null = null
let mainWindow: BrowserWindow | null = null

/** Bring the main window forward (creating it if needed); resolves once its page has loaded. */
function showWindow(): Promise<BrowserWindow> {
  let win = mainWindow
  if (!win) {
    createWindow()
    win = mainWindow!
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  const w = win
  return w.webContents.isLoading()
    ? new Promise((resolve) => w.webContents.once('did-finish-load', () => resolve(w)))
    : Promise.resolve(w)
}

const shellIntegration = new ShellIntegration({
  show: () => void showWindow(),
  newChat: () => void showWindow().then(() => emit('app-command', { command: 'new-chat' })),
  settings: () => void showWindow().then(() => emit('app-command', { command: 'settings' })),
  isFocused: () => !!mainWindow?.isFocused() && mainWindow.isVisible(),
  hide: () => {
    if (process.platform === 'darwin') app.hide()
    else mainWindow?.minimize()
  },
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'AnyDot',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The agent's hidden windows shouldn't keep the app alive on their own.
    if (process.platform !== 'darwin') {
      browser.close()
      webSearch.close()
    }
  })

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function openStore(dataDir: string): { store: Store; dbPath: string } {
  const dbPath = join(dataDir, 'aitech.db')
  const db = openDatabase(dbPath, {
    onBackup: (file) => console.info(`[db] backed up before upgrading: ${file}`),
  })
  // Stable per-install id, stamped on every row for future sync.
  const bootstrap = new Store(db, 'bootstrap')
  let deviceId = bootstrap.getSetting<string | null>('deviceId', null)
  if (!deviceId) {
    deviceId = newId()
    bootstrap.setSetting('deviceId', deviceId)
  }
  return { store: new Store(db, deviceId), dbPath }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    // Packaged builds get the icon from the bundle; in dev the Dock would show Electron's.
    if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
    const dataDir = join(app.getPath('userData'), 'data')
    mkdirSync(dataDir, { recursive: true })
    const opened = openStore(dataDir)
    store = opened.store
    store.recoverStreaming()
    store.recoverImageJobs()
    nativeTheme.themeSource = loadSettings(store).theme

    const blobs = new BlobStore(join(dataDir, 'blobs'), store)
    const s = store
    protocol.handle(BLOB_SCHEME, async (req) => {
      const sha = new URL(req.url).pathname.replace(/^\//, '')
      try {
        const data = await readFile(blobs.pathOf(sha))
        const headers: Record<string, string> = {
          'Content-Type': blobs.mime(sha),
          'Cache-Control': 'max-age=31536000, immutable',
          'Accept-Ranges': 'bytes',
        }
        // Video seeking needs byte ranges.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
        if (range && (range[1] || range[2])) {
          const size = data.byteLength
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
          if (start >= size || start > end) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            })
          }
          return new Response(data.subarray(start, end + 1), {
            status: 206,
            headers: {
              ...headers,
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Content-Length': String(end - start + 1),
            },
          })
        }
        return new Response(data, { headers })
      } catch {
        return new Response('not found', { status: 404 })
      }
    })

    const notifier = new Notifier(
      s,
      () => loadSettings(s).notifications,
      () => mainWindow,
      (conversationId) => emit('open-conversation', { conversationId }),
    )
    artifacts.register()
    const mcp = new McpService(s, agent, (status) => emit('mcp', status))
    agent.start()
    chat = new ChatService(
      s,
      blobs,
      agent,
      () => loadSettings(s),
      (e) => {
        emit('chat', e)
        remote?.onChatEvent(e)
        notifier.onChatEvent(e)
      },
      join(app.getPath('userData'), 'workspaces'),
    )
    images = new ImageService(s, blobs, (job) => emit('image', job))
    images.resume()
    remote = new RemoteService(
      s,
      chat,
      blobs,
      (status) => emit('remote', status),
      (req) => emit('remote-pair', req),
    )
    scheduler = new Scheduler(
      s,
      chat,
      () => loadSettings(s),
      () => {
        emit('invalidate', { scope: 'schedules' })
        emit('invalidate', { scope: 'conversations' })
      },
    )
    registerIpc({
      store: s,
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
      applyShell: (settings) => shellIntegration.apply(settings),
      logger,
      dbPath: opened.dbPath,
    })
    void refreshInstalledExtension().catch(() => {})
    const settings = loadSettings(s)
    void chromeExt
      .setEnabled(settings.browserTool && settings.browserBackend === 'chrome')
      .catch((err: Error) => console.error('[chrome-ext]', err.message))
    createWindow()
    void remote.restart()
    scheduler.start()
    updater.start()
    const shellError = shellIntegration.apply(loadSettings(s))
    if (shellError) console.warn('[shortcut]', shellError)

    app.on('activate', () => {
      if (!mainWindow) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // With the tray icon on, keep running in the background (scheduled tasks, phone).
    if (process.platform !== 'darwin' && !(store && loadSettings(store).trayIcon)) app.quit()
  })

  // Quit in order: let running replies save their final state, then stop the
  // agent process (its exit would report more events), then close the store.
  let shutDown = false
  app.on('before-quit', (event) => {
    if (shutDown) return
    event.preventDefault()
    shutDown = true
    scheduler?.stop()
    updater.stop()
    shellIntegration.dispose()
    images?.stopAll()
    remote?.stop()
    void (chat?.shutdown() ?? Promise.resolve())
      .catch((err: unknown) => console.error('[quit]', err))
      .finally(() => {
        agent.stop()
        browser.close()
        chromeExt.stop()
        webSearch.close()
        store?.db.close()
        // Our cleanup is done: exit outright. A second app.quit() can be ignored while
        // Electron is still unwinding the quit we cancelled above, leaving the app
        // running with its database closed.
        app.exit(0)
      })
  })
}
