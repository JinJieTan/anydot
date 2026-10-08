import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { openDatabase, schemaVersion, type Database } from '@aitech/db'
import { IpcChannel, type AppInfo } from '../shared/ipc'
import { AgentHost } from './agent-host'

let db: Database
const agent = new AgentHost()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(dbPath: string): void {
  ipcMain.handle(IpcChannel.AppInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    db: { path: dbPath, schemaVersion: schemaVersion(db) },
  }))
  ipcMain.handle(IpcChannel.AgentPing, () => agent.ping())
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
    const dbPath = join(dataDir, 'aitech.db')
    db = openDatabase(dbPath)

    agent.start()
    registerIpc(dbPath)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    agent.stop()
    db?.close()
  })
}
