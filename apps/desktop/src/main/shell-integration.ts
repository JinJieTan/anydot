import { globalShortcut, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import type { Settings } from '../shared/ipc'

/**
 * The shortcut the settings page suggests (it's off until the user turns it on:
 * Option+Space is often taken by launchers). Avoids Alt+Space, the window menu, on Windows.
 */
export const SUGGESTED_SHORTCUT = process.platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space'

/**
 * A four-point sparkle drawn in code (no image assets): an astroid,
 * |x|^½ + |y|^½ ≤ 1, antialiased by supersampling. On macOS it's a template
 * image, so the menu bar tints it for light and dark.
 */
function sparkle(size: number, rgb: [number, number, number]): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const n = 4
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          const u = ((x + (sx + 0.5) / n) / size) * 2 - 1
          const v = ((y + (sy + 0.5) / n) / size) * 2 - 1
          if (Math.sqrt(Math.abs(u) / 0.92) + Math.sqrt(Math.abs(v) / 0.92) <= 1) hits++
        }
      const i = (y * size + x) * 4
      // BGRA
      buf[i] = rgb[2]
      buf[i + 1] = rgb[1]
      buf[i + 2] = rgb[0]
      buf[i + 3] = Math.round((hits / (n * n)) * 255)
    }
  return buf
}

function trayImage(): NativeImage {
  const mac = process.platform === 'darwin'
  const color: [number, number, number] = mac ? [0, 0, 0] : [217, 119, 87]
  const image = nativeImage.createEmpty()
  for (const scale of [1, 2]) {
    const size = 16 * scale
    image.addRepresentation({
      scaleFactor: scale,
      width: size,
      height: size,
      buffer: sparkle(size, color),
    })
  }
  if (mac) image.setTemplateImage(true)
  return image
}

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
])
const KEY =
  /^([a-z0-9]|f([1-9]|1\d|2[0-4])|space|tab|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|esc|escape|plus|[`\-=[\]\\;',./])$/i

/** Electron's register() accepts some malformed accelerators silently, so check them first. */
export function isValidAccelerator(acc: string): boolean {
  const parts = acc.split('+')
  const key = parts.pop() ?? ''
  if (!KEY.test(key)) return false
  const mods = parts.map((p) => p.toLowerCase())
  // A global shortcut without a modifier would swallow that key everywhere (F-keys excepted).
  if (!mods.length && !/^f\d+$/i.test(key)) return false
  return mods.every((m) => MODIFIERS.has(m)) && new Set(mods).size === mods.length
}

export interface ShellActions {
  /** Bring the main window forward and start a new chat. */
  newChat: () => void
  show: () => void
  settings: () => void
  /** The main window is focused and visible (the shortcut then hides it). */
  isFocused: () => boolean
  hide: () => void
}

/** Tray icon and the global shortcut, kept in sync with settings. */
export class ShellIntegration {
  private tray: Tray | null = null
  private shortcut: string | null = null

  constructor(private readonly actions: ShellActions) {}

  /** Apply settings; returns an error message when the shortcut couldn't be registered. */
  apply(s: Settings): string | null {
    this.applyTray(s.trayIcon)
    return this.applyShortcut(s.globalShortcut)
  }

  private applyTray(on: boolean) {
    if (!on) {
      this.tray?.destroy()
      this.tray = null
      return
    }
    if (this.tray) return
    const tray = new Tray(trayImage())
    tray.setToolTip('aitech')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '新对话', click: () => this.actions.newChat() },
        { label: '打开 aitech', click: () => this.actions.show() },
        { label: '设置…', click: () => this.actions.settings() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ]),
    )
    // Windows / Linux: a left click opens the window (macOS shows the menu).
    if (process.platform !== 'darwin') tray.on('click', () => this.actions.show())
    this.tray = tray
  }

  private applyShortcut(accelerator: string): string | null {
    const next = accelerator.trim() || null
    if (next === this.shortcut) return null
    if (this.shortcut) globalShortcut.unregister(this.shortcut)
    this.shortcut = null
    if (!next) return null
    if (!isValidAccelerator(next)) return `无效的快捷键：${next}`
    try {
      const ok = globalShortcut.register(next, () =>
        this.actions.isFocused() ? this.actions.hide() : this.actions.newChat(),
      )
      if (!ok) return `快捷键 ${next} 已被其他应用占用`
      this.shortcut = next
      return null
    } catch {
      return `无效的快捷键：${next}`
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll()
    this.tray?.destroy()
    this.tray = null
  }
}
