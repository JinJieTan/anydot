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

/**
 * OS-level screen capture and input, in the platform's native coordinate
 * space (points on macOS, physical pixels on Windows).
 */
export interface NativeDriver {
  /** Size of the main display. */
  screenSize(): Promise<Size>
  /** JPEG of the main display, resized to exactly `size`. */
  capture(size: Size): Promise<Uint8Array>
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
