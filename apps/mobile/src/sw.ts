/// <reference lib="webworker" />
/**
 * Service worker: offline app shell, and Web Push. Push payloads are
 * end-to-end encrypted by the desktop; we decrypt them here with this
 * device's key so even notification text never passes the relay in clear.
 */
import {
  createIdentity,
  deviceIdOf,
  fromB64url,
  open,
  sharedKey,
  type Envelope,
} from '@aitech/protocol'
import { get } from 'idb-keyval'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { kv, type PairedDesktop } from './lib/storage'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

interface PushBody {
  from: string
  fromKey: string
  payload: string
}

async function decrypt(
  body: PushBody,
): Promise<{ title: string; body: string; tag: string } | null> {
  const secret = await get<Uint8Array>('identity', kv)
  const desktops = (await get<PairedDesktop[]>('desktops', kv)) ?? []
  const desktop = desktops.find((d) => d.deviceId === body.from && d.publicKey === body.fromKey)
  if (!secret || !desktop) return null
  const me = createIdentity(secret)
  const key = fromB64url(body.fromKey)
  if (deviceIdOf(key) !== body.from) return null
  const env = JSON.parse(
    open(sharedKey(me, key), body.payload, `${body.from}>${me.deviceId}`),
  ) as Envelope
  if (env.body.type !== 'event' || env.body.name !== 'notify') return null
  return env.body.data as { title: string; body: string; tag: string }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let n: { title: string; body: string; tag: string } | null = null
      let from = ''
      try {
        const body = event.data?.json() as PushBody
        from = body.from
        n = await decrypt(body)
      } catch {
        // fall through to a generic notification (one must be shown)
      }
      const scope = self.registration.scope
      await self.registration.showNotification(n?.title ?? 'aitech', {
        body: n?.body ?? '你的电脑有新动态',
        tag: n?.tag,
        icon: `${scope}icon-192.png`,
        badge: `${scope}icon-192.png`,
        data: { url: n?.tag && from ? `${scope}#/d/${from}/c/${n.tag}` : scope },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string })?.url ?? self.registration.scope
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of all) {
        if ('focus' in c) {
          await (c as WindowClient).navigate(url).catch(() => {})
          return (c as WindowClient).focus()
        }
      }
      return self.clients.openWindow(url)
    })(),
  )
})
