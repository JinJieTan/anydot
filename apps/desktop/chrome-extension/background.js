// AnyDot 浏览器助手: connects to the AnyDot desktop app on this machine over a
// local WebSocket and runs its browser_* commands in one tab of this Chrome.
//
// Protocol (JSON text frames):
//   ext → app  { type: 'hello', version, userAgent }
//   app → ext  { type: 'welcome', app, extensionVersion }
//   app → ext  { type: 'exec', id, cmd }      cmd: a BrowserCommand
//   ext → app  { type: 'result', id, result } result: { text?, snapshot?, image? }
//   ext → app  { type: 'error', id, error }
//   app → ext  { type: 'ping' }  /  ext → app  { type: 'pong' }

const PORTS = [18741, 18742, 18743]
const MAX_SHOT_WIDTH = 1280
const VERSION = chrome.runtime.getManifest().version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- connection

let ws = null
let connecting = null
let state = { connected: false, port: null, app: null, error: null }
let queue = Promise.resolve()

function setState(patch) {
  state = { ...state, ...patch }
  void chrome.action.setBadgeText({ text: state.connected ? 'on' : '' })
  void chrome.action.setBadgeBackgroundColor({ color: '#16a34a' })
}

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return Promise.resolve()
  connecting ??= (async () => {
    try {
      for (const port of PORTS) {
        const sock = await open(port)
        if (sock) return adopt(sock, port)
      }
      setState({ connected: false, port: null, error: '没有找到正在运行的 AnyDot 桌面端' })
    } finally {
      connecting = null
    }
  })()
  return connecting
}

/** Open a socket and wait for the app's welcome, so a stranger on the port is skipped. */
function open(port) {
  return new Promise((resolve) => {
    let sock
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}/aitech`)
    } catch {
      return resolve(null)
    }
    const fail = () => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        // already closed
      }
      resolve(null)
    }
    const timer = setTimeout(fail, 3000)
    sock.onerror = fail
    sock.onopen = () =>
      sock.send(JSON.stringify({ type: 'hello', version: VERSION, userAgent: navigator.userAgent }))
    sock.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return fail()
      }
      if (msg.type !== 'welcome') return fail()
      clearTimeout(timer)
      sock.onerror = null
      sock.welcome = msg
      resolve(sock)
    }
  })
}

async function adopt(sock, port) {
  ws = sock
  setState({ connected: true, port, app: sock.welcome.app ?? null, error: null })
  sock.onmessage = (e) => onMessage(sock, e.data)
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    setState({ connected: false, port: null })
    void detachAll()
    setTimeout(() => void connect(), 3000)
  }
  // The app rewrote our files with a newer version: reload once to pick them up.
  const want = sock.welcome.extensionVersion
  if (want && want !== VERSION) {
    const { reloadedFor } = await chrome.storage.local.get('reloadedFor')
    if (reloadedFor !== want) {
      await chrome.storage.local.set({ reloadedFor: want })
      chrome.runtime.reload()
    }
  }
}

function send(sock, msg) {
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg))
}

function onMessage(sock, data) {
  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  if (msg.type === 'ping') return send(sock, { type: 'pong' })
  if (msg.type !== 'exec') return
  // One command at a time, like a person at one tab.
  queue = queue
    .then(() => run(msg.cmd))
    .then(
      (result) => send(sock, { type: 'result', id: msg.id, result }),
      (err) => send(sock, { type: 'error', id: msg.id, error: String(err?.message ?? err) }),
    )
}

// Service workers get suspended when idle; the app's pings and this alarm keep us connected.
chrome.alarms.create('aitech-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
void connect()

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'status') reply({ ...state, version: VERSION })
  else if (msg?.type === 'reconnect') connect().then(() => reply({ ...state, version: VERSION }))
  else return false
  return true
})

// ---------------------------------------------------------------- the agent's tab

async function agentTab(create) {
  const { tabId } = await chrome.storage.session.get('tabId')
  if (tabId != null) {
    try {
      return await chrome.tabs.get(tabId)
    } catch {
      // closed by the user
    }
  }
  if (!create) throw new Error('No page is open; call browser_navigate first.')
  let tab
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: true })
  } catch {
    // No browser window open (macOS keeps Chrome running without one).
    const win = await chrome.windows.create({ url: 'about:blank', focused: true })
    tab = win.tabs[0]
  }
  try {
    const group = await chrome.tabs.group({ tabIds: tab.id })
    await chrome.tabGroups.update(group, { title: 'AnyDot', color: 'blue' })
  } catch {
    // tab groups are cosmetic
  }
  await chrome.storage.session.set({ tabId: tab.id })
  return tab
}

chrome.tabs.onRemoved.addListener(async (closed) => {
  attached.delete(closed)
  const { tabId } = await chrome.storage.session.get('tabId')
  if (tabId === closed) await chrome.storage.session.remove('tabId')
})

/** Wait for a navigation to finish (or give up after `ms`). */
function waitForLoad(tabId, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn) => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      fn()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done(resolve)
    }
    const timer = setTimeout(
      () => done(() => reject(new Error(`Page load timed out after ${ms / 1000}s.`))),
      ms,
    )
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/** Give the page a moment to react, and wait out any navigation it started. */
async function settle(tabId) {
  await sleep(350)
  const deadline = Date.now() + 15_000
  let waited = false
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab || tab.status !== 'loading') break
    waited = true
    await sleep(150)
  }
  if (waited) await sleep(250)
}

// ---------------------------------------------------------------- page helpers

function callHelper(method, args) {
  try {
    return { ok: true, value: window.__aitech[method](...args) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** Run one of the helpers.js functions in the page's isolated world. */
async function helper(tab, method, ...args) {
  if (!tab.url || tab.url === 'about:blank')
    throw new Error('No page is open; call browser_navigate first.')
  const target = { tabId: tab.id }
  let res
  try {
    await chrome.scripting.executeScript({ target, files: ['helpers.js'] })
    ;[res] = await chrome.scripting.executeScript({
      target,
      func: callHelper,
      args: [method, args],
    })
  } catch (e) {
    const m = String(e?.message ?? e)
    if (/cannot (access|be scripted)|chrome:\/\/|extensions gallery/i.test(m))
      throw new Error(`Extensions cannot read this page (${tab.url}).`, { cause: e })
    throw e
  }
  const r = res?.result
  if (!r) throw new Error('The page did not respond; try again.')
  if (!r.ok) throw new Error(r.error)
  return r.value
}

const snapshot = async (tabId, text) => ({
  text,
  snapshot: await helper(await chrome.tabs.get(tabId), 'snapshot'),
})

// ---------------------------------------------------------------- DevTools protocol

const attached = new Set()
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId))

async function cdp(tabId, method, params) {
  for (let attempt = 0; ; attempt++) {
    if (!attached.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3')
      } catch (e) {
        if (!/already attached/i.test(String(e?.message))) throw e
      }
      attached.add(tabId)
    }
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params)
    } catch (e) {
      if (attempt > 0 || !/not attached/i.test(String(e?.message))) throw e
      attached.delete(tabId)
    }
  }
}

async function detachAll() {
  for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {})
  attached.clear()
}

const IS_MAC = /Mac/.test(navigator.userAgent)
const MODS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
MODS.controlormeta = IS_MAC ? 4 : 2
/** name → [key, code, keyCode, text?] */
const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'],
  return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  space: [' ', 'Space', 32, ' '],
  ' ': [' ', 'Space', 32, ' '],
}
/** Shortcuts CDP key events don't trigger on their own. */
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' }

function keySpec(name, mods) {
  const known = KEYS[name.toLowerCase()]
  if (known) return known
  const f = /^f([1-9]|1[0-2])$/i.exec(name)
  if (f) return [`F${f[1]}`, `F${f[1]}`, 111 + Number(f[1])]
  if (name.length === 1) {
    const ch = mods & 8 ? name.toUpperCase() : name
    const up = name.toUpperCase()
    const code = /[A-Z]/.test(up) ? `Key${up}` : /[0-9]/.test(up) ? `Digit${up}` : ''
    return [ch, code, /[A-Z0-9]/.test(up) ? up.charCodeAt(0) : 0, ch]
  }
  throw new Error(`Unknown key "${name}"`)
}

async function key(tabId, name, mods = 0) {
  const [key, code, keyCode, text] = keySpec(name, mods)
  const typing = text && !(mods & (1 | 2 | 4))
  const shortcut = mods & (IS_MAC ? 4 : 2) && EDIT_COMMANDS[key.toLowerCase()]
  const base = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: mods,
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: typing ? 'keyDown' : 'rawKeyDown',
    ...(typing ? { text, unmodifiedText: text } : {}),
    ...(shortcut ? { commands: [shortcut] } : {}),
  })
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function press(tabId, combo) {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  let mods = 0
  let name = null
  for (const p of parts) {
    const m = MODS[p.toLowerCase()]
    if (m && parts.length > 1) mods |= m
    else name = p
  }
  if (!name) throw new Error(`No key in "${combo}"`)
  await key(tabId, name, mods)
}

async function click(tabId, x, y) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const button = { x, y, button: 'left', clickCount: 1 }
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...button })
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...button })
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function screenshot(tab) {
  // Capturing a hidden tab can stall, so bring it to the front of its window.
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true })
    await sleep(300)
  }
  const { data } = await cdp(tab.id, 'Page.captureScreenshot', { format: 'png' })
  const { cssLayoutViewport } = await cdp(tab.id, 'Page.getLayoutMetrics')
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
  const width = Math.min(MAX_SHOT_WIDTH, cssLayoutViewport?.clientWidth || bmp.width, bmp.width)
  const height = Math.round((bmp.height * width) / bmp.width)
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d').drawImage(bmp, 0, 0, width, height)
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
  return {
    text: `Screenshot of ${tab.url} (${width}×${height}).`,
    image: { data: toBase64(await jpeg.arrayBuffer()), mime: 'image/jpeg' },
  }
}

// ---------------------------------------------------------------- commands

async function run(cmd) {
  switch (cmd.action) {
    case 'navigate': {
      const tab = await agentTab(true)
      const url = /^https?:\/\//i.test(cmd.url) ? cmd.url : `http://${cmd.url}`
      const loaded = waitForLoad(tab.id, 30_000)
      await chrome.tabs.update(tab.id, { url })
      await loaded
      await settle(tab.id)
      return snapshot(tab.id)
    }
    case 'snapshot':
      return snapshot((await agentTab(false)).id)
    case 'click': {
      const tab = await agentTab(false)
      const p = await helper(tab, 'point', cmd.ref)
      await click(tab.id, p.x, p.y)
      await settle(tab.id)
      const note = p.covered
        ? `Note: the click landed on "${p.covered}", which covers ${cmd.ref}.\n`
        : ''
      return snapshot(tab.id, `${note}Clicked ${cmd.ref}.`)
    }
    case 'type': {
      const tab = await agentTab(false)
      if (!(await helper(tab, 'focusAndSelect', cmd.ref)))
        throw new Error(`${cmd.ref} could not be focused`)
      if (cmd.text) await cdp(tab.id, 'Input.insertText', { text: cmd.text })
      else await key(tab.id, 'Backspace')
      if (cmd.submit) await key(tab.id, 'Enter')
      await settle(tab.id)
      return snapshot(tab.id, `Typed into ${cmd.ref}${cmd.submit ? ' and pressed Enter' : ''}.`)
    }
    case 'select': {
      const tab = await agentTab(false)
      const label = await helper(tab, 'select', cmd.ref, cmd.value)
      await settle(tab.id)
      return snapshot(tab.id, `Selected "${label}" in ${cmd.ref}.`)
    }
    case 'press': {
      const tab = await agentTab(false)
      await press(tab.id, cmd.key)
      await settle(tab.id)
      return snapshot(tab.id, `Pressed ${cmd.key}.`)
    }
    case 'scroll': {
      const tab = await agentTab(false)
      const amount = Math.max(0.2, Math.min(20, cmd.amount ?? 1))
      const s = await helper(tab, 'scroll', cmd.direction === 'up' ? -amount : amount)
      await sleep(300)
      return {
        text: `Scrolled ${cmd.direction}. Position ${s.y}–${s.y + s.viewport} of ${s.height}px. Take a snapshot or screenshot to see the page.`,
      }
    }
    case 'back': {
      const tab = await agentTab(false)
      try {
        await chrome.tabs.goBack(tab.id)
      } catch {
        return { text: 'There is no previous page.' }
      }
      await settle(tab.id)
      return snapshot(tab.id)
    }
    case 'screenshot':
      return screenshot(await agentTab(false))
    default:
      throw new Error(`Unknown action ${cmd.action}`)
  }
}
