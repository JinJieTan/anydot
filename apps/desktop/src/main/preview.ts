import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'

/**
 * Show model-generated HTML in its own window, isolated from the app: no
 * preload, a separate in-memory session, sandboxed renderer, and no
 * navigation away from the file. External links open in the browser.
 */
export function openPreview(html: string): void {
  const dir = join(app.getPath('temp'), 'aitech-previews')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${createHash('sha256').update(html).digest('hex').slice(0, 16)}.html`)
  writeFileSync(file, html, 'utf8')
  const url = pathToFileURL(file).toString()

  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    title: '预览',
    webPreferences: {
      partition: 'preview',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== url) {
      event.preventDefault()
      if (/^https?:\/\//.test(target)) void shell.openExternal(target)
    }
  })
  void win.loadURL(url)
}
