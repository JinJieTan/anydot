import { describe, expect, it } from 'vitest'
import { Computer, type NativeDriver } from './computer'
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

function fakeDriver(calls: unknown[]): NativeDriver {
  const log =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  return {
    screenSize: async () => ({ width: 2560, height: 1600 }),
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
