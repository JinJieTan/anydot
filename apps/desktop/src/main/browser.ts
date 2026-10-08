import { app, BrowserWindow, session, type WebContents } from 'electron'
import type { BrowserCommand, BrowserReply } from '@aitech/agent'

const PARTITION = 'persist:aitech-browser'
/** Isolated JS world for our page helpers, so page scripts can't tamper with them. */
const WORLD = 1001
const MAX_SNAPSHOT = 15_000
const MAX_SHOT_WIDTH = 1280

/**
 * Page-side helpers, installed once per document in the isolated world.
 * `snapshot()` lists visible text and interactive elements, tagging each
 * interactive one with a ref (e1, e2, …) that later commands refer to.
 */
const HELPERS = String.raw`
if (!window.__aitech) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'IFRAME'])
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'])
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|NAV|LI|UL|OL|TR|TD|TH|TABLE|FORM|FIELDSET|DL|DT|DD|PRE|BLOCKQUOTE|FIGURE|FIGCAPTION|LABEL|BR|HR|H[1-6])$/
  const clean = (s, n = 100) => {
    s = (s || '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n) + '…' : s
  }
  const visible = (el) => {
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0 || st.display === 'contents'
  }
  const interactive = (el) => {
    const tag = el.tagName
    if (tag === 'A' && el.hasAttribute('href')) return true
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true
    if (tag === 'INPUT') return el.type !== 'hidden'
    const role = el.getAttribute('role')
    if (role && ROLES.has(role)) return true
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true
    return false
  }
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ')
      if (clean(t)) return clean(t)
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText)
    const text = clean(el.innerText || el.textContent)
    if (text) return text
    const img = el.querySelector && el.querySelector('img[alt]')
    return clean(el.getAttribute('title') || el.getAttribute('placeholder') || img?.alt || '')
  }
  const describe = (el, ref) => {
    const tag = el.tagName
    const role = el.getAttribute('role')
    let kind = role || (tag === 'A' ? 'link' : tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textbox' : tag.toLowerCase())
    let extra = ''
    if (tag === 'INPUT') {
      const t = el.type
      kind = t === 'checkbox' || t === 'radio' ? t : t === 'submit' || t === 'button' ? 'button' : 'textbox'
      if (kind === 'textbox') {
        if (t !== 'text') extra += ' type=' + t
        if (t === 'password') extra += el.value ? ' value=(hidden)' : ''
        else if (el.value) extra += ' value="' + clean(el.value, 80) + '"'
        if (el.placeholder) extra += ' placeholder="' + clean(el.placeholder, 60) + '"'
      }
      if (el.checked) extra += ' checked'
    } else if (tag === 'TEXTAREA') {
      if (el.value) extra += ' value="' + clean(el.value, 120) + '"'
      if (el.placeholder) extra += ' placeholder="' + clean(el.placeholder, 60) + '"'
    } else if (tag === 'SELECT') {
      const opts = [...el.options].slice(0, 30).map((o) => (o.selected ? '*' : '') + clean(o.label || o.text, 40))
      extra += ' options=[' + opts.join(' | ') + (el.options.length > 30 ? ' | …' : '') + ']'
    } else if (tag === 'A') {
      const href = el.getAttribute('href')
      if (href && !href.startsWith('javascript:')) extra += ' -> ' + clean(href, 80)
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') extra += ' disabled'
    if (el.getAttribute('aria-expanded')) extra += ' expanded=' + el.getAttribute('aria-expanded')
    const name = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      ? clean(el.getAttribute('aria-label') || (el.labels && el.labels[0]?.innerText) || el.title || el.name || '', 60)
      : labelOf(el)
    return '[' + ref + '] ' + kind + (name ? ' "' + name + '"' : '') + extra
  }
  window.__aitech = {
    refs: new Map(),
    snapshot() {
      this.refs = new Map()
      for (const old of document.querySelectorAll('[data-aitech-ref]')) old.removeAttribute('data-aitech-ref')
      const lines = []
      let n = 0
      let buf = ''
      const flush = () => {
        const t = clean(buf, 400)
        if (t) lines.push(t)
        buf = ''
      }
      const walk = (node) => {
        if (node.nodeType === 3) {
          buf += ' ' + node.nodeValue
          return
        }
        if (node.nodeType !== 1 && node.nodeType !== 11) return
        const el = node
        if (node.nodeType === 1) {
          if (SKIP.has(el.tagName.toUpperCase()) || !visible(el)) return
          if (interactive(el)) {
            flush()
            const ref = 'e' + ++n
            this.refs.set(ref, el)
            el.setAttribute('data-aitech-ref', ref)
            lines.push(describe(el, ref))
            return
          }
          if (el.tagName === 'IMG' && el.alt) buf += ' [image: ' + clean(el.alt, 60) + ']'
          const h = /^H([1-6])$/.exec(el.tagName)
          if (h) {
            flush()
            lines.push('#'.repeat(+h[1]) + ' ' + clean(el.innerText, 150))
            return
          }
          if (BLOCK.test(el.tagName)) flush()
          if (el.shadowRoot) walk(el.shadowRoot)
        }
        for (const c of el.childNodes) walk(c)
        if (node.nodeType === 1 && BLOCK.test(el.tagName)) flush()
      }
      walk(document.body || document.documentElement)
      flush()
      const se = document.scrollingElement || document.documentElement
      return {
        url: location.href,
        title: document.title,
        text: lines.join('\n'),
        scroll: { y: Math.round(se.scrollTop), height: se.scrollHeight, viewport: innerHeight },
      }
    },
    el(ref) {
      const el = this.refs.get(ref) || document.querySelector('[data-aitech-ref="' + ref + '"]')
      if (!el || !el.isConnected) throw new Error('Element ' + ref + ' not found; take a new snapshot.')
      return el
    },
    /** Scroll into view; returns the centre point in viewport CSS pixels. */
    point(ref) {
      const el = this.el(ref)
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + Math.min(r.width / 2, Math.max(1, r.width - 2)))
      const y = Math.round(r.top + Math.min(r.height / 2, Math.max(1, r.height - 2)))
      // Inside a shadow root, hit-test there, or the host would count as covering it.
      const root = el.getRootNode()
      const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y)
      const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el)
      return { x, y, covered: covered ? labelOf(hit) || hit.tagName.toLowerCase() : null }
    },
    focusAndSelect(ref) {
      const el = this.el(ref)
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      el.focus()
      if (typeof el.select === 'function') el.select()
      else if (el.isContentEditable) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
      return document.activeElement === el || el.contains(document.activeElement)
    },
    select(ref, value) {
      const el = this.el(ref)
      if (el.tagName !== 'SELECT') throw new Error(ref + ' is not a <select>')
      const opt = [...el.options].find((o) => o.value === value) ||
        [...el.options].find((o) => clean(o.label || o.text) === clean(value))
      if (!opt) throw new Error('No option "' + value + '" in ' + ref)
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(el, opt.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return clean(opt.label || opt.text)
    },
    scroll(dy) {
      let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
      while (el && el !== document.body) {
        const st = getComputedStyle(el)
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) break
        el = el.parentElement
      }
      const target = el && el !== document.body ? el : document.scrollingElement || document.documentElement
      target.scrollBy({ top: dy * innerHeight * 0.85, behavior: 'instant' })
      return { y: Math.round(target.scrollTop), height: target.scrollHeight, viewport: target.clientHeight }
    },
  }
}
`

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
    const s = (await this.helper(wc, '__aitech.snapshot()')) as {
      url: string
      title: string
      text: string
      scroll: { y: number; height: number; viewport: number }
    }
    let body = s.text
    if (body.length > MAX_SNAPSHOT)
      body = `${body.slice(0, MAX_SNAPSHOT)}\n…[snapshot truncated; ${body.length - MAX_SNAPSHOT} more chars]`
    const head = [
      prefix,
      `URL: ${s.url}`,
      `Title: ${s.title}`,
      `Viewport: ${s.scroll.y}–${s.scroll.y + s.scroll.viewport} of ${s.scroll.height}px`,
    ]
    return { text: `${head.filter(Boolean).join('\n')}\n\n${body || '(empty page)'}` }
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
