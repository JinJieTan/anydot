/// <reference lib="webworker" />
/**
 * Serves stored files at <app>/__blob/<sha256>, the web stand-in for the
 * desktop's aitech-blob:// protocol, so the shared renderer can keep using
 * plain URLs in <img> and <video>. The bytes come from the tab that owns the
 * database (its worker), asked over a MessageChannel.
 */
declare const self: ServiceWorkerGlobalScope
export {}

const PREFIX = new URL('__blob/', self.registration.scope).pathname

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin || !url.pathname.startsWith(PREFIX)) return
  e.respondWith(serveBlob(url.pathname.slice(PREFIX.length), e.request.headers.get('range')))
})

interface BlobReply {
  ok: boolean
  data?: ArrayBuffer
  mime?: string
}

function ask(client: Client, sha256: string): Promise<BlobReply> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve({ ok: false }), 15_000)
    channel.port1.onmessage = (e: MessageEvent<BlobReply>) => {
      clearTimeout(timer)
      resolve(e.data)
    }
    client.postMessage({ type: 'anydot-blob', sha256 }, [channel.port2])
  })
}

async function serveBlob(sha256: string, range: string | null): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return new Response('bad blob id', { status: 400 })
  // Only the tab holding the database lock can answer; the others say no.
  const clients = await self.clients.matchAll({ type: 'window' })
  let reply: BlobReply = { ok: false }
  for (const client of clients) {
    reply = await ask(client, sha256)
    if (reply.ok) break
  }
  if (!reply.ok || !reply.data) return new Response('not found', { status: 404 })

  const headers = {
    'Content-Type': reply.mime ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // Content-addressed: a URL never changes what it points to.
    'Cache-Control': 'private, max-age=31536000, immutable',
  }
  const size = reply.data.byteLength
  // Safari plays <video> only from range responses.
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range)
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size || start > end)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    return new Response(reply.data.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` },
    })
  }
  return new Response(reply.data, { headers })
}
