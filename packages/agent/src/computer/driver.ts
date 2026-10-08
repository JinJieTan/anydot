import type { KeyCombo } from './keys'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export type MouseButton = 'left' | 'right' | 'middle'

export interface DisplayInfo {
  /** Stable while the display stays connected (CGDirectDisplayID / device name). */
  id: string
  name: string
  /** Position and size in the global native coordinate space. */
  bounds: Point & Size
  main: boolean
  /** Position in the OS display list (macOS `screencapture -D` is index + 1). */
  index: number
}

/**
 * OS-level screen capture and input, in the platform's global native
 * coordinate space (points on macOS, physical pixels on Windows), where
 * every display has its own region.
 */
export interface NativeDriver {
  displays(): Promise<DisplayInfo[]>
  /** JPEG of one display, resized to exactly `size`. */
  capture(display: DisplayInfo, size: Size): Promise<Uint8Array>
  cursor(): Promise<Point>
  move(p: Point): Promise<void>
  click(p: Point, button: MouseButton, count: number): Promise<void>
  mouse(kind: 'down' | 'up', p: Point): Promise<void>
  drag(from: Point, to: Point): Promise<void>
  /** Positive dy scrolls down, positive dx scrolls right; in wheel clicks. */
  scroll(p: Point, dx: number, dy: number): Promise<void>
  type(text: string): Promise<void>
  key(combo: KeyCombo, holdMs?: number): Promise<void>
  dispose(): void
}
