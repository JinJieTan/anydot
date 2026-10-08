import type { ToolImage } from '@aitech/core'
import type { DisplayInfo, MouseButton, NativeDriver, Point, Size } from './driver'
import { parseCombo } from './keys'
import { macDriver } from './mac'
import { windowsDriver } from './windows'

export type { DisplayInfo, MouseButton, NativeDriver, Point, Size } from './driver'
export { parseCombo } from './keys'

/** Screenshots are scaled down to fit this box, which is what models are trained on. */
const MAX_WIDTH = 1280
const MAX_HEIGHT = 800

export function nativeDriver(platform: NodeJS.Platform): NativeDriver | null {
  if (platform === 'darwin') return macDriver()
  if (platform === 'win32') return windowsDriver()
  return null
}

/**
 * The model works on one display at a time (the main one unless chosen
 * otherwise). It sees that display as a screenshot scaled to fit
 * MAX_WIDTH×MAX_HEIGHT and gives coordinates in that space; this class maps
 * them to the platform's global native coordinates.
 */
export class Computer {
  private geometry: Promise<{ display: DisplayInfo; size: Size; scale: number }> | null = null
  /** Chosen display id; null means the main display. */
  private chosen: string | null = null

  constructor(private readonly driver: NativeDriver) {}

  displays(): Promise<DisplayInfo[]> {
    return this.driver.displays()
  }

  /**
   * Work on another display from now on (null: the main one). Unknown ids
   * fall back to the main display unless `strict`.
   */
  async useDisplay(id: string | null, strict = false): Promise<DisplayInfo> {
    if (strict && id !== null) {
      const all = await this.driver.displays()
      if (!all.some((d) => d.id === id))
        throw new Error(`no display "${id}"; available: ${all.map((d) => d.id).join(', ')}`)
    }
    this.chosen = id
    this.geometry = null
    return (await this.measure()).display
  }

  /** Size of the screenshots the model sees. */
  async display(): Promise<Size> {
    return (await this.measure()).size
  }

  async current(): Promise<DisplayInfo> {
    return (await this.measure()).display
  }

  private measure() {
    this.geometry ??= this.driver.displays().then((all) => {
      const display = all.find((d) => d.id === this.chosen) ?? all.find((d) => d.main) ?? all[0]
      if (!display) throw new Error('no display found')
      const { width, height } = display.bounds
      const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height)
      return {
        display,
        scale,
        size: { width: Math.round(width * scale), height: Math.round(height * scale) },
      }
    })
    this.geometry.catch(() => (this.geometry = null))
    return this.geometry
  }

  private async toNative(p: [number, number]): Promise<Point> {
    const { scale, size, display } = await this.measure()
    const [x, y] = p
    if (!(x >= 0 && y >= 0 && x <= size.width && y <= size.height)) {
      throw new Error(
        `coordinate (${x}, ${y}) is outside the screen (${size.width}×${size.height})`,
      )
    }
    return { x: display.bounds.x + x / scale, y: display.bounds.y + y / scale }
  }

  async screenshot(): Promise<ToolImage> {
    const { display, size } = await this.measure()
    return { data: await this.driver.capture(display, size), mime: 'image/jpeg' }
  }

  /** Cursor position on the current display, or null when it is on another one. */
  async cursor(): Promise<[number, number] | null> {
    const { scale, display } = await this.measure()
    const p = await this.driver.cursor()
    const b = display.bounds
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) return null
    return [Math.round((p.x - b.x) * scale), Math.round((p.y - b.y) * scale)]
  }

  async move(p: [number, number]) {
    await this.driver.move(await this.toNative(p))
  }

  async click(p: [number, number] | undefined, button: MouseButton, count: number) {
    const at = p ? await this.toNative(p) : await this.driver.cursor()
    await this.driver.click(at, button, count)
  }

  async mouse(kind: 'down' | 'up', p: [number, number] | undefined) {
    const at = p ? await this.toNative(p) : await this.driver.cursor()
    await this.driver.mouse(kind, at)
  }

  async drag(from: [number, number] | undefined, to: [number, number]) {
    const start = from ? await this.toNative(from) : await this.driver.cursor()
    await this.driver.drag(start, await this.toNative(to))
  }

  async scroll(p: [number, number] | undefined, direction: string, amount: number) {
    const at = p ? await this.toNative(p) : await this.driver.cursor()
    const n = Math.max(1, Math.min(30, Math.round(amount)))
    const [dx, dy] =
      direction === 'up'
        ? [0, -n]
        : direction === 'left'
          ? [-n, 0]
          : direction === 'right'
            ? [n, 0]
            : [0, n]
    await this.driver.scroll(at, dx, dy)
  }

  async type(text: string) {
    await this.driver.type(text)
  }

  /** Space-separated combos are pressed one after another, e.g. "ctrl+a Delete". */
  async key(keys: string, repeat = 1, holdMs?: number) {
    const combos = keys.split(/\s+/).filter(Boolean).map(parseCombo)
    for (let i = 0; i < Math.max(1, Math.min(50, repeat)); i++)
      for (const c of combos) await this.driver.key(c, holdMs)
  }

  dispose() {
    this.driver.dispose()
  }
}
