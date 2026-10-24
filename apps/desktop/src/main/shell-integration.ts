import { globalShortcut, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import type { Settings } from '../shared/ipc'

/**
 * The shortcut the settings page suggests (it's off until the user turns it on:
 * Option+Space is often taken by launchers). Avoids Alt+Space, the window menu, on Windows.
 */
export const SUGGESTED_SHORTCUT = process.platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space'

/**
 * The D stroke of brand/logo-mark.svg flattened to a polyline, in that file's
 * 180-unit box: the top bar, the bowl (two cubics), the bottom bar and the stem.
 */
const D_STROKE: [number, number][] = (() => {
  const pts: [number, number][] = [
    [84, 42],
    [90, 42],
  ]
  const cubic = (...p: [number, number][]) => {
    for (let i = 1; i <= 16; i++) {
      const t = i / 16
      const s = 1 - t
      const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]
      pts.push(
        [0, 1].map((k) => p.reduce((sum, q, j) => sum + q[k]! * w[j]!, 0)) as [number, number],
      )
    }
  }
  cubic([90, 42], [121, 42], [140, 64], [140, 90])
  cubic([140, 90], [140, 116], [121, 138], [90, 138])
  pts.push([62, 138], [58, 136], [56, 132], [56, 64])
  return pts
})()

function nearStroke(u: number, v: number, radius: number): boolean {
  for (let i = 1; i < D_STROKE.length; i++) {
    const [ax, ay] = D_STROKE[i - 1]!
    const [bx, by] = D_STROKE[i]!
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)))
    if (Math.hypot(u - ax - t * dx, v - ay - t * dy) <= radius) return true
  }
  return false
}

/**
 * The AnyDot mark (an open D with a dot inside) drawn in code (no image
 * assets), antialiased by supersampling. On macOS it's a template image, so
 * the menu bar tints it for light and dark.
 */
function dotMark(size: number, rgb: [number, number, number]): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const n = 4
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          // The mark spans x 47–149, y 33–147 of its box; fit that to the icon.
          const u = 98 + ((x + (sx + 0.5) / n) / size - 0.5) * 118
          const v = 90 + ((y + (sy + 0.5) / n) / size - 0.5) * 118
          if (Math.hypot(u - 98, v - 90) <= 16 || nearStroke(u, v, 8.5)) hits++
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
      buffer: dotMark(size, color),
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
    tray.setToolTip('AnyDot')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '新对话', click: () => this.actions.newChat() },
        { label: '打开 AnyDot', click: () => this.actions.show() },
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
