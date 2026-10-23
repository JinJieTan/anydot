import { app, BrowserWindow, session, type WebContents } from 'electron'
import type { BrowserCommand, BrowserReply } from '@aitech/agent'
import { formatSnapshot, HELPERS, type PageSnapshot } from './page-helpers'

const PARTITION = 'persist:aitech-browser'
/** Isolated JS world for our page helpers, so page scripts can't tamper with them. */
const WORLD = 1001
const MAX_SHOT_WIDTH = 1280

/** Playwright-style key names → Electron accelerator key codes. */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
}
const MODIFIER_KEYS: Record<string, 'control' | 'shift' | 'alt' | 'meta'> = {
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  controlormeta: process.platform === 'darwin' ? 'meta' : 'control',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The agent's own browser: a normal app window with a persistent, separate
 * session, so the user can watch it and sign in to sites for the agent.
 */
export class AgentBrowser {
  private win: BrowserWindow | null = null

  /** Bring the window to the front (from the UI). */
  show(): void {
    const win = this.window()
    if (win.webContents.getURL() === '') void win.loadURL('about:blank')
    win.show()
    win.focus()
  }

  close(): void {
    this.win?.destroy()
    this.win = null
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const ses = session.fromPartition(PARTITION)
    // Pages never get camera, mic, location, notifications etc.
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    // Look like the Chrome we are, not "Electron", which some sites block.
    ses.setUserAgent(app.userAgentFallback.replace(/\s(aitech|Electron)\/\S+/g, ''))

    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      show: false,
      title: 'aitech 浏览器',
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    // Keep everything in this one tab.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void win.loadURL(url)
      return { action: 'deny' }
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.win = win
    return win
  }

  private reveal(win: BrowserWindow) {
    // Show without stealing focus from what the user is doing.
    if (!win.isVisible()) win.showInactive()
  }

  async exec(cmd: BrowserCommand): Promise<BrowserReply> {
    const win = this.window()
    const wc = win.webContents
    switch (cmd.action) {
      case 'navigate': {
        this.reveal(win)
        const url = /^https?:\/\//i.test(cmd.url) ? cmd.url : `http://${cmd.url}`
        await this.load(wc, () => wc.loadURL(url))
        return this.snapshot(wc)
      }
      case 'snapshot':
        return this.snapshot(wc)
      case 'click': {
        this.reveal(win)
        const p = (await this.helper(wc, `__aitech.point(${JSON.stringify(cmd.ref)})`)) as {
          x: number
          y: number
          covered: string | null
        }
        await wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
        await wc.sendInputEvent({
          type: 'mouseDown',
          x: p.x,
          y: p.y,
          button: 'left',
          clickCount: 1,
        })
        await wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        await this.settle(wc)
        const note = p.covered
          ? `Note: the click landed on "${p.covered}", which covers ${cmd.ref}.\n`
          : ''
        return this.snapshot(wc, `${note}Clicked ${cmd.ref}.`)
      }
      case 'type': {
        this.reveal(win)
        const focused = await this.helper(wc, `__aitech.focusAndSelect(${JSON.stringify(cmd.ref)})`)
        if (!focused) throw new Error(`${cmd.ref} could not be focused`)
        if (cmd.text) await wc.insertText(cmd.text)
        else this.key(wc, 'Backspace')
        if (cmd.submit) this.key(wc, 'Return')
        await this.settle(wc)
        return this.snapshot(wc, `Typed into ${cmd.ref}${cmd.submit ? ' and pressed Enter' : ''}.`)
      }
      case 'select': {
        const label = await this.helper(
          wc,
          `__aitech.select(${JSON.stringify(cmd.ref)}, ${JSON.stringify(cmd.value)})`,
        )
        await this.settle(wc)
        return this.snapshot(wc, `Selected "${label}" in ${cmd.ref}.`)
      }
      case 'press': {
        this.reveal(win)
        this.press(wc, cmd.key)
        await this.settle(wc)
        return this.snapshot(wc, `Pressed ${cmd.key}.`)
      }
      case 'scroll': {
        const amount = Math.max(0.2, Math.min(20, cmd.amount ?? 1))
        const s = (await this.helper(
          wc,
          `__aitech.scroll(${cmd.direction === 'up' ? -amount : amount})`,
        )) as { y: number; height: number; viewport: number }
        await sleep(300)
        return {
          text: `Scrolled ${cmd.direction}. Position ${s.y}–${s.y + s.viewport} of ${s.height}px. Take a snapshot or screenshot to see the page.`,
        }
      }
      case 'back': {
        if (!wc.navigationHistory.canGoBack()) return { text: 'There is no previous page.' }
        await this.load(wc, async () => wc.navigationHistory.goBack())
        return this.snapshot(wc)
      }
      case 'screenshot': {
        this.reveal(win)
        let img = await wc.capturePage()
        const { width } = img.getSize()
        if (width > MAX_SHOT_WIDTH) img = img.resize({ width: MAX_SHOT_WIDTH, quality: 'good' })
        const size = img.getSize()
        return {
          text: `Screenshot of ${wc.getURL()} (${size.width}×${size.height}).`,
          image: { data: img.toJPEG(75).toString('base64'), mime: 'image/jpeg' },
        }
      }
    }
  }

  private async helper(wc: WebContents, expr: string): Promise<unknown> {
    if (!wc.getURL() || wc.getURL() === 'about:blank')
      throw new Error('No page is open; call browser_navigate first.')
    // Errors thrown inside the page come back as a generic failure, so report them as values.
    const code = `${HELPERS}\ntry { ({ ok: true, value: ${expr} }) } catch (e) { ({ ok: false, error: String(e && e.message || e) }) }`
    const r = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true)) as {
      ok: boolean
      value?: unknown
      error?: string
    }
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  private async snapshot(wc: WebContents, prefix = ''): Promise<BrowserReply> {
    const s = (await this.helper(wc, '__aitech.snapshot()')) as PageSnapshot
    return { text: formatSnapshot(s, prefix) }
  }

  /** Run a navigation and wait for it to finish (or give up after 30s). */
  private async load(wc: WebContents, start: () => Promise<unknown>) {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        start(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Page load timed out after 30s.')), 30_000)
        }),
      ])
    } catch (err) {
      // ERR_ABORTED: a redirect or client-side navigation replaced this load.
      if (!/ERR_ABORTED|\(-3\)/.test((err as Error).message)) throw err
    } finally {
      clearTimeout(timer)
    }
    await this.settle(wc)
  }

  /** Give the page a moment to react, and wait out any navigation it started. */
  private async settle(wc: WebContents) {
    await sleep(350)
    if (wc.isLoading()) {
      await Promise.race([
        new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve())),
        sleep(15_000),
      ])
      await sleep(250)
    }
  }

  private key(
    wc: WebContents,
    keyCode: string,
    modifiers: ('control' | 'shift' | 'alt' | 'meta')[] = [],
  ) {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    // A "char" event is what actually inserts text / activates Enter in forms.
    if (!modifiers.some((m) => m !== 'shift')) {
      const ch =
        keyCode === 'Return'
          ? '\r'
          : keyCode === 'Space'
            ? ' '
            : keyCode.length === 1
              ? keyCode
              : null
      if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers })
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  private press(wc: WebContents, combo: string) {
    const parts = combo
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean)
    const mods: ('control' | 'shift' | 'alt' | 'meta')[] = []
    let key: string | null = null
    for (const p of parts) {
      const m = MODIFIER_KEYS[p.toLowerCase()]
      if (m && parts.length > 1) mods.push(m)
      else
        key =
          KEY_ALIASES[p.toLowerCase()] ?? (p.length === 1 ? p : p[0]!.toUpperCase() + p.slice(1))
    }
    if (!key) throw new Error(`No key in "${combo}"`)
    this.key(wc, key, mods)
  }
}
