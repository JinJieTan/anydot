/**
 * Key names as models send them (xdotool style, e.g. "ctrl+shift+t", "Return",
 * "cmd+c"), mapped to platform key codes.
 */

export type Modifier = 'ctrl' | 'shift' | 'alt' | 'cmd'

const MODIFIERS: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  control_l: 'ctrl',
  control_r: 'ctrl',
  shift: 'shift',
  shift_l: 'shift',
  shift_r: 'shift',
  alt: 'alt',
  alt_l: 'alt',
  alt_r: 'alt',
  option: 'alt',
  opt: 'alt',
  cmd: 'cmd',
  command: 'cmd',
  super: 'cmd',
  super_l: 'cmd',
  super_r: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  windows: 'cmd',
}

/** Aliases → canonical key name. */
const ALIASES: Record<string, string> = {
  enter: 'return',
  kp_enter: 'return',
  esc: 'escape',
  backspace: 'backspace',
  back_space: 'backspace',
  del: 'delete',
  pageup: 'page_up',
  prior: 'page_up',
  pagedown: 'page_down',
  next: 'page_down',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  spacebar: 'space',
  ' ': 'space',
  minus: '-',
  equal: '=',
  plus: '=',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  apostrophe: "'",
  quoteright: "'",
  grave: '`',
  bracketleft: '[',
  bracketright: ']',
}

export interface KeyCombo {
  mods: Modifier[]
  /** Canonical key name, or null for a bare modifier press. */
  key: string | null
}

export function parseCombo(input: string): KeyCombo {
  const parts = input
    .trim()
    .split(/\s*\+\s*/)
    .filter(Boolean)
  if (!parts.length) throw new Error('empty key')
  const mods: Modifier[] = []
  let key: string | null = null
  for (const raw of parts) {
    const lower = raw.toLowerCase()
    const mod = MODIFIERS[lower]
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod)
      continue
    }
    if (key) throw new Error(`only one non-modifier key per combo: "${input}"`)
    key = raw.length === 1 ? raw.toLowerCase() : (ALIASES[lower] ?? lower)
  }
  return { mods, key }
}

// ── macOS virtual key codes (Carbon kVK_*) ───────────────────

// prettier-ignore
const MAC_KEYS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14,
  r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24,
  '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34,
  p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46,
  '.': 47, '`': 50,
  return: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117,
  home: 115, end: 119, page_up: 116, page_down: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111,
  // Bare modifiers
  cmd: 55, shift: 56, alt: 58, ctrl: 59, caps_lock: 57,
}

/** CGEventFlags */
const MAC_FLAGS: Record<Modifier, number> = {
  shift: 1 << 17,
  ctrl: 1 << 18,
  alt: 1 << 19,
  cmd: 1 << 20,
}

export function macKey(combo: KeyCombo): { code: number; flags: number } {
  const name = combo.key ?? combo.mods.at(-1)!
  const code = MAC_KEYS[name]
  if (code === undefined) throw new Error(`unsupported key "${name}"`)
  const flags = combo.mods.reduce((f, m) => f | MAC_FLAGS[m], 0)
  return { code, flags }
}

// ── Windows virtual-key codes ────────────────────────────────

// prettier-ignore
const WIN_KEYS: Record<string, number> = {
  return: 0x0d, tab: 0x09, space: 0x20, backspace: 0x08, escape: 0x1b, delete: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, page_up: 0x21, page_down: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  ctrl: 0x11, shift: 0x10, alt: 0x12, cmd: 0x5b, caps_lock: 0x14,
}
for (let i = 1; i <= 12; i++) WIN_KEYS[`f${i}`] = 0x6f + i

const WIN_MODS: Record<Modifier, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12, cmd: 0x5b }

/** Virtual keys to press in order (modifiers first) and release in reverse. */
export function winKeys(combo: KeyCombo): number[] {
  // Models trained on macOS often say "cmd+c"; on Windows that means Ctrl.
  const mods = combo.mods.map((m) => (m === 'cmd' && combo.key ? WIN_MODS.ctrl : WIN_MODS[m]))
  if (!combo.key) return [...new Set(mods)]
  const k = combo.key
  const code = /^[a-z0-9]$/.test(k) ? k.toUpperCase().charCodeAt(0) : WIN_KEYS[k]
  if (code === undefined) throw new Error(`unsupported key "${k}"`)
  return [...new Set(mods), code]
}
