import { describe, expect, it } from 'vitest'
import { Computer, type DisplayInfo, type NativeDriver } from './computer'
import { computerDisplayTool } from './tools'
import { macKey, parseCombo, winKeys } from './computer/keys'
import { dropOldImages } from './loop'
import type { ModelMessage } from '@aitech/core'

describe('key combos', () => {
  it('parses modifiers and aliases', () => {
    expect(parseCombo('ctrl+shift+T')).toEqual({ mods: ['ctrl', 'shift'], key: 't' })
    expect(parseCombo('super+Return')).toEqual({ mods: ['cmd'], key: 'return' })
    expect(parseCombo('Escape')).toEqual({ mods: [], key: 'escape' })
    expect(() => parseCombo('a+b')).toThrow()
  })

  it('maps to macOS key codes and flags', () => {
    expect(macKey(parseCombo('cmd+c'))).toEqual({ code: 8, flags: 1 << 20 })
    expect(macKey(parseCombo('Return'))).toEqual({ code: 36, flags: 0 })
    expect(() => macKey(parseCombo('nope'))).toThrow(/unsupported/)
  })

  it('maps to Windows virtual keys, cmd meaning ctrl', () => {
    expect(winKeys(parseCombo('cmd+c'))).toEqual([0x11, 0x43])
    expect(winKeys(parseCombo('alt+F4'))).toEqual([0x12, 0x73])
    expect(winKeys(parseCombo('super'))).toEqual([0x5b])
  })
})

// A Retina main display and an external one to its right, sitting higher (negative y).
const DISPLAYS: DisplayInfo[] = [
  {
    id: '1',
    name: 'Built-in',
    bounds: { x: 0, y: 0, width: 2560, height: 1600 },
    main: true,
    index: 0,
  },
  {
    id: '2',
    name: 'External',
    bounds: { x: 2560, y: -200, width: 1920, height: 1080 },
    main: false,
    index: 1,
  },
]

function fakeDriver(calls: unknown[]): NativeDriver {
  const log =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  return {
    displays: async () => DISPLAYS,
    capture: async () => new Uint8Array([1]),
    cursor: async () => ({ x: 100, y: 50 }),
    move: log('move'),
    click: log('click'),
    mouse: log('mouse'),
    drag: log('drag'),
    scroll: log('scroll'),
    type: log('type'),
    key: log('key'),
    dispose() {},
  }
}

describe('Computer', () => {
  it('scales the display to fit 1280×800 and maps coordinates back', async () => {
    const calls: unknown[] = []
    const pc = new Computer(fakeDriver(calls))
    expect(await pc.display()).toEqual({ width: 1280, height: 800 })
    await pc.click([640, 400], 'left', 2)
    expect(calls).toEqual([['click', { x: 1280, y: 800 }, 'left', 2]])
    expect(await pc.cursor()).toEqual([50, 25])
    await expect(pc.move([2000, 10])).rejects.toThrow(/outside the screen/)
  })

  it('works on another display with its own origin and scale', async () => {
    const calls: unknown[] = []
    const pc = new Computer(fakeDriver(calls))
    await pc.useDisplay('2')
    expect(await pc.display()).toEqual({ width: 1280, height: 720 })
    await pc.click([640, 360], 'left', 1)
    expect(calls).toEqual([['click', { x: 2560 + 960, y: -200 + 540 }, 'left', 1]])
    // The fake cursor (100, 50) is on the main display.
    expect(await pc.cursor()).toBeNull()
    await expect(pc.useDisplay('9', true)).rejects.toThrow(/no display "9"/)
  })

  it('lets the model list and switch displays', async () => {
    const pc = new Computer(fakeDriver([]))
    const ctx = {
      cwd: '/',
      signal: new AbortController().signal,
      platform: process.platform,
      env: {},
      readFiles: new Map(),
      computer: pc,
    }
    const list = await computerDisplayTool.run({ action: 'list' }, ctx)
    expect(list.output).toContain('id=1: Built-in, 2560×1600, main (current)')
    expect(list.output).toContain('id=2: External, 1920×1080')
    const sw = await computerDisplayTool.run({ action: 'switch', display_id: '2' }, ctx)
    expect(sw.output).toBe('Now working on External (1280×720).')
    expect(sw.images).toHaveLength(1)
  })

  it('presses space-separated combos in order', async () => {
    const calls: unknown[] = []
    await new Computer(fakeDriver(calls)).key('ctrl+a Delete')
    expect(calls).toEqual([
      ['key', { mods: ['ctrl'], key: 'a' }, undefined],
      ['key', { mods: [], key: 'delete' }, undefined],
    ])
  })
})

describe('dropOldImages', () => {
  const shot = (id: string): ModelMessage => ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'computer',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: id },
            { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'AA==' } },
          ],
        },
      },
    ],
  })

  it('keeps only the newest screenshots in the run history', () => {
    const history = [shot('a'), shot('b'), shot('c')]
    dropOldImages(history, 2)
    const out = history.map((m) => (m.content[0] as { output: unknown }).output)
    expect(out[0]).toEqual({ type: 'text', value: 'a\n[screenshot omitted to save context]' })
    expect(out[1]).toMatchObject({ type: 'content' })
    expect(out[2]).toMatchObject({ type: 'content' })
  })

  it('waits for some slack before rewriting history', () => {
    const history = [shot('a'), shot('b'), shot('c')]
    dropOldImages(history, 2, 1)
    expect(
      history.every(
        (m) => (m.content[0] as { output: { type: string } }).output.type === 'content',
      ),
    ).toBe(true)
  })
})

// Drives the real screen and mouse, which hosted CI runners don't have an interactive desktop for.
describe.runIf(process.platform === 'win32' && !process.env.CI)('Windows driver', () => {
  it('lists displays, captures one and moves the mouse', async () => {
    const { nativeDriver } = await import('./computer')
    const driver = nativeDriver('win32')!
    try {
      const displays = await driver.displays()
      expect(displays.length).toBeGreaterThan(0)
      const main = displays.find((d) => d.main) ?? displays[0]!
      expect(main.bounds.width).toBeGreaterThan(0)
      const jpeg = await driver.capture(main, { width: 320, height: 200 })
      expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8])
      await driver.move({ x: main.bounds.x + 10, y: main.bounds.y + 10 })
      const at = await driver.cursor()
      expect(at).toEqual({ x: main.bounds.x + 10, y: main.bounds.y + 10 })
    } finally {
      driver.dispose()
    }
  }, 60_000)
})
