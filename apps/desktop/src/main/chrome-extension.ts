import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import { strToU8, zipSync } from 'fflate'
import { extensionIdFromKey } from './chrome-bridge'
import { HELPERS } from './page-helpers'

const SOURCES = import.meta.glob('../../chrome-extension/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** The extension's files, by name; helpers.js is the same page code the built-in browser uses. */
const FILES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(SOURCES).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text]),
  ),
  'helpers.js': HELPERS,
}

const MANIFEST = JSON.parse(FILES['manifest.json'] ?? '{}') as { version: string; key: string }

export const EXTENSION_VERSION = MANIFEST.version
/** The unpacked extension's fixed ID (from the manifest key). */
export const EXTENSION_ID = extensionIdFromKey(MANIFEST.key)
/** Chrome Web Store ID once published; the store assigns its own. */
const STORE_ID: string | null = null
export const ALLOWED_EXTENSION_IDS = [EXTENSION_ID, ...(STORE_ID ? [STORE_ID] : [])]

export const extensionDir = () => join(app.getPath('userData'), 'chrome-extension')

async function writeExtension(dir: string) {
  await mkdir(dir, { recursive: true })
  for (const [name, text] of Object.entries(FILES)) await writeFile(join(dir, name), text)
}

/**
 * Keep an installed copy current after an app update. Chrome loads unpacked
 * extensions from this folder; the extension reloads itself when it connects.
 */
export async function refreshInstalledExtension(): Promise<void> {
  if (existsSync(join(extensionDir(), 'manifest.json'))) await writeExtension(extensionDir())
}

/** Write the extension folder, show it in Finder/Explorer and open Chrome's extensions page. */
export async function prepareInstall(): Promise<{ dir: string; chromeOpened: boolean }> {
  const dir = extensionDir()
  await writeExtension(dir)
  clipboard.writeText('chrome://extensions')
  shell.showItemInFolder(join(dir, 'manifest.json'))
  const chromeOpened = await openInChrome('chrome://extensions')
  return { dir, chromeOpened }
}

/** Save the extension as a zip, for installing on another machine or sharing. */
export async function exportExtensionZip(): Promise<{ path: string } | null> {
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    defaultPath: join(app.getPath('downloads'), `aitech-chrome-extension-${EXTENSION_VERSION}.zip`),
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(FILES).map(([name, text]) => [
        `aitech-chrome-extension/${name}`,
        strToU8(text),
      ]),
    ),
  )
  await writeFile(res.filePath, zip)
  shell.showItemInFolder(res.filePath)
  return { path: res.filePath }
}

function chromeOnWindows(): string | null {
  const roots = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA'],
  ]
  for (const root of roots) {
    const exe = root && join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (exe && existsSync(exe)) return exe
  }
  return null
}

/** Open a URL in Google Chrome specifically (chrome:// pages can't go through the default browser). */
function openInChrome(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Google Chrome', url], (err) => resolve(!err))
      return
    }
    const exe = process.platform === 'win32' ? chromeOnWindows() : 'google-chrome'
    if (!exe) return resolve(false)
    const child = spawn(exe, [url], { detached: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
