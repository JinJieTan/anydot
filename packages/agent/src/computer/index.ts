import type { ToolImage } from '@aitech/core'
import type { MouseButton, NativeDriver, Point, Size } from './driver'
import { parseCombo } from './keys'
import { macDriver } from './mac'
import { windowsDriver } from './windows'

export type { MouseButton, NativeDriver, Point, Size } from './driver'
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
 * The model sees the main display as a screenshot scaled to fit
 * MAX_WIDTH×MAX_HEIGHT and gives coordinates in that space; this class maps
 * them back to the platform's native coordinates.
 */
export class Computer {
  private geometry: Promise<{ native: Size; display: Size; scale: number }> | null = null

  constructor(private readonly driver: NativeDriver) {}

  /** Size of the screenshots the model sees. */
  async display(): Promise<Size> {
    return (await this.measure()).display
  }

  private measure() {
    this.geometry ??= this.driver.screenSize().then((native) => {
      const scale = Math.min(1, MAX_WIDTH / native.width, MAX_HEIGHT / native.height)
      return {
        native,
        scale,
        display: {
          width: Math.round(native.width * scale),
          height: Math.round(native.height * scale),
        },
      }
    })
    this.geometry.catch(() => (this.geometry = null))
    return this.geometry
  }

  private async toNative(p: [number, number]): Promise<Point> {
    const { scale, display } = await this.measure()
    const [x, y] = p
    if (!(x >= 0 && y >= 0 && x <= display.width && y <= display.height)) {
      throw new Error(
        `coordinate (${x}, ${y}) is outside the screen (${display.width}×${display.height})`,
      )
    }
    return { x: x / scale, y: y / scale }
  }

  async screenshot(): Promise<ToolImage> {
    const { display } = await this.measure()
    return { data: await this.driver.capture(display), mime: 'image/jpeg' }
  }

  async cursor(): Promise<[number, number]> {
    const { scale } = await this.measure()
    const p = await this.driver.cursor()
    return [Math.round(p.x * scale), Math.round(p.y * scale)]
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
