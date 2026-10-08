import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron'
import { newId } from '@aitech/core'
import { openDatabase, Store } from '@aitech/db'
import { AgentHost } from './agent-host'
import { BlobStore } from './blobs'
import { ChatService } from './chat-service'
import { emit } from './events'
import { ImageService } from './image-service'
import { loadSettings, registerIpc } from './ipc'
import { McpService } from './mcp-service'
import { RemoteService } from './remote-service'

/** Serves local blobs to the renderer as aitech-blob://blob/<sha256>. */
const BLOB_SCHEME = 'aitech-blob'

// Separate data dir for development and automated tests.
if (process.env['AITECH_USER_DATA']) app.setPath('userData', process.env['AITECH_USER_DATA'])

protocol.registerSchemesAsPrivileged([
  { scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const agent = new AgentHost()
let store: Store | null = null
let chat: ChatService | null = null
let images: ImageService | null = null
let remote: RemoteService | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'aitech',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

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
  const db = openDatabase(dbPath)
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
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
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
        return new Response(data, {
          headers: {
            'Content-Type': blobs.mime(sha),
            'Cache-Control': 'max-age=31536000, immutable',
          },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    })

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
      },
    )
    images = new ImageService(s, blobs, (job) => emit('image', job))
    remote = new RemoteService(
      s,
      chat,
      blobs,
      (status) => emit('remote', status),
      (req) => emit('remote-pair', req),
    )
    registerIpc({ store: s, blobs, chat, images, remote, mcp, dbPath: opened.dbPath })
    createWindow()
    void remote.restart()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    chat?.stopAll()
    images?.stopAll()
    remote?.stop()
    agent.stop()
    store?.db.close()
  })
}
