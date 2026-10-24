import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DisplayInfo, NativeDriver, Point } from './driver'
import { macKey } from './keys'

const run = promisify(execFile)

/**
 * Input via CoreGraphics events from JavaScript for Automation. Ships with
 * macOS, so there is nothing to install; the app needs the Accessibility
 * permission (and Screen Recording for screenshots).
 */
const SCRIPT = String.raw`
ObjC.import('CoreGraphics')
ObjC.import('AppKit')
function run(argv) {
  const a = JSON.parse(argv[0])
  const post = (e) => $.CGEventPost(0, e)
  const P = (x, y) => $.CGPointMake(x, y)
  const BTN = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }
  const mouse = (type, x, y, button, clicks) => {
    const e = $.CGEventCreateMouseEvent(null, type, P(x, y), button)
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks)
    post(e)
  }
  const key = (code, flags, down) => {
    const e = $.CGEventCreateKeyboardEvent(null, code, down)
    $.CGEventSetFlags(e, flags)
    post(e)
  }
  switch (a.op) {
    case 'displays': {
      // NSScreen.screens starts with the main display, like screencapture -D 1.
      const screens = $.NSScreen.screens
      const out = []
      for (let i = 0; i < screens.count; i++) {
        const s = screens.objectAtIndex(i)
        const id = ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber'))
        const b = $.CGDisplayBounds(id)
        out.push({
          id: String(id),
          name: ObjC.unwrap(s.localizedName) || 'Display ' + (i + 1),
          bounds: { x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height },
          main: id === $.CGMainDisplayID(),
          index: i,
        })
      }
      return JSON.stringify(out)
    }
    case 'cursor': {
      const p = $.CGEventGetLocation($.CGEventCreate(null))
      return JSON.stringify({ x: p.x, y: p.y })
    }
    case 'move':
      mouse(5, a.x, a.y, 0)
      return '{}'
    case 'click': {
      const [down, up, button] = BTN[a.button]
      mouse(5, a.x, a.y, 0)
      for (let i = 1; i <= a.count; i++) {
        mouse(down, a.x, a.y, button, i)
        mouse(up, a.x, a.y, button, i)
      }
      return '{}'
    }
    case 'down':
      mouse(1, a.x, a.y, 0, 1)
      return '{}'
    case 'up':
      mouse(2, a.x, a.y, 0, 1)
      return '{}'
    case 'drag': {
      mouse(5, a.x1, a.y1, 0)
      mouse(1, a.x1, a.y1, 0, 1)
      const steps = 20
      for (let i = 1; i <= steps; i++) {
        mouse(6, a.x1 + ((a.x2 - a.x1) * i) / steps, a.y1 + ((a.y2 - a.y1) * i) / steps, 0)
        delay(0.01)
      }
      mouse(2, a.x2, a.y2, 0, 1)
      return '{}'
    }
    case 'scroll': {
      mouse(5, a.x, a.y, 0)
      // Line units; CG uses positive = up/left.
      post($.CGEventCreateScrollWheelEvent2(null, 1, 2, -a.dy, -a.dx, 0))
      return '{}'
    }
    case 'key': {
      key(a.code, a.flags, true)
      if (a.hold) delay(a.hold)
      key(a.code, a.flags, false)
      return '{}'
    }
    case 'paste': {
      // Typing arbitrary Unicode (CJK, emoji) via keycodes is unreliable, so
      // paste it and put the user's clipboard back afterwards.
      const pb = $.NSPasteboard.generalPasteboard
      const type = $.NSPasteboardTypeString
      const old = pb.stringForType(type)
      pb.clearContents
      pb.setStringForType($(a.text), type)
      key(9, 1 << 20, true)
      key(9, 1 << 20, false)
      delay(0.25)
      pb.clearContents
      if (!old.isNil()) pb.setStringForType(old, type)
      return '{}'
    }
  }
  throw new Error('unknown op ' + a.op)
}
`

async function call<T = unknown>(op: Record<string, unknown>): Promise<T> {
  try {
    const { stdout } = await run(
      'osascript',
      ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(op)],
      {
        timeout: 15_000,
      },
    )
    return JSON.parse(stdout.trim() || '{}') as T
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    throw new Error(`macOS input failed: ${msg}`, { cause: err })
  }
}

export function macDriver(): NativeDriver {
  return {
    displays: () => call<DisplayInfo[]>({ op: 'displays' }),
    cursor: () => call<Point>({ op: 'cursor' }),
    async capture(display, size) {
      const dir = await mkdtemp(join(tmpdir(), 'aitech-shot-'))
      try {
        const raw = join(dir, 'raw.png')
        const out = join(dir, 'shot.jpg')
        // -x: no sound, -D: which display (1 = main)
        await run('screencapture', ['-x', '-D', String(display.index + 1), '-t', 'png', raw], {
          timeout: 15_000,
        })
        await run(
          'sips',
          [
            '-z',
            String(size.height),
            String(size.width),
            '-s',
            'format',
            'jpeg',
            '-s',
            'formatOptions',
            '70',
            raw,
            '--out',
            out,
          ],
          { timeout: 15_000 },
        )
        return new Uint8Array(await readFile(out))
      } catch (err) {
        throw new Error(
          `截屏失败：${(err as Error).message}。请在“系统设置 → 隐私与安全性 → 录屏与系统录音”中允许 AnyDot。`,
          { cause: err },
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    move: (p) => call({ op: 'move', ...p }).then(() => {}),
    click: (p, button, count) => call({ op: 'click', ...p, button, count }).then(() => {}),
    mouse: (kind, p) => call({ op: kind, ...p }).then(() => {}),
    drag: (from, to) =>
      call({ op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y }).then(() => {}),
    scroll: (p, dx, dy) => call({ op: 'scroll', ...p, dx, dy }).then(() => {}),
    type: (text) => call({ op: 'paste', text }).then(() => {}),
    key: (combo, holdMs) =>
      call({ op: 'key', ...macKey(combo), hold: holdMs ? holdMs / 1000 : 0 }).then(() => {}),
    dispose() {},
  }
}
