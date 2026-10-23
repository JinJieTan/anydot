/**
 * Page-side code shared by the built-in browser window and the Chrome
 * extension (which gets it as helpers.js).
 */

const MAX_SNAPSHOT = 15_000

/**
 * Page-side helpers, installed once per document in the isolated world.
 * `snapshot()` lists visible text and interactive elements, tagging each
 * interactive one with a ref (e1, e2, …) that later commands refer to.
 */
export const HELPERS = String.raw`
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

/** What `__aitech.snapshot()` returns. */
export interface PageSnapshot {
  url: string
  title: string
  text: string
  scroll: { y: number; height: number; viewport: number }
}

/** The text the browser_* tools return for a page. */
export function formatSnapshot(s: PageSnapshot, prefix = ''): string {
  let body = s.text
  if (body.length > MAX_SNAPSHOT)
    body = `${body.slice(0, MAX_SNAPSHOT)}\n…[snapshot truncated; ${body.length - MAX_SNAPSHOT} more chars]`
  const head = [
    prefix,
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    `Viewport: ${s.scroll.y}–${s.scroll.y + s.scroll.viewport} of ${s.scroll.height}px`,
  ]
  return `${head.filter(Boolean).join('\n')}\n\n${body || '(empty page)'}`
}
