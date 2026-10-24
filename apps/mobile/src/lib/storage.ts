import type { ProviderType } from '@aitech/core'
import { createIdentity, type Identity } from '@aitech/protocol'
import { createStore, get, set } from 'idb-keyval'

/** Shared with the service worker, which needs the identity to decrypt pushes. */
export const kv = createStore('aitech', 'kv')

export interface PairedDesktop {
  deviceId: string
  /** base64url Ed25519 public key */
  publicKey: string
  name: string
  relayUrl: string
  pairedAt: number
}

export interface MobileSettings {
  deviceName: string
  /** Direct use of the user's provider on the phone (optional). */
  baseUrl: string
  apiKey: string
  providerType: ProviderType
  /** Access token for relays in "token" mode. */
  relayToken: string
  notifications: boolean
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android 手机'
  return '浏览器'
}

export const DEFAULT_SETTINGS: MobileSettings = {
  deviceName: '',
  baseUrl: '',
  apiKey: '',
  providerType: 'auto',
  relayToken: '',
  notifications: false,
}

export async function loadIdentity(): Promise<Identity> {
  const secret = await get<Uint8Array>('identity', kv)
  if (secret) return createIdentity(secret)
  const id = createIdentity()
  await set('identity', id.secretKey, kv)
  return id
}

export async function loadDesktops(): Promise<PairedDesktop[]> {
  return (await get<PairedDesktop[]>('desktops', kv)) ?? []
}

export async function saveDesktops(list: PairedDesktop[]) {
  await set('desktops', list, kv)
}

export async function loadSettings(): Promise<MobileSettings> {
  const s = { ...DEFAULT_SETTINGS, ...((await get<Partial<MobileSettings>>('settings', kv)) ?? {}) }
  if (!s.deviceName) s.deviceName = defaultDeviceName()
  return s
}

export async function saveSettings(s: MobileSettings) {
  await set('settings', s, kv)
}

// ── local (on-phone) chats ───────────────────────────────────

export interface LocalMessage {
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  /** data: URLs */
  images?: string[]
  error?: string
}

export interface LocalChat {
  id: string
  title: string
  modelId: string | null
  messages: LocalMessage[]
  updatedAt: number
}

export async function loadChats(): Promise<LocalChat[]> {
  return (await get<LocalChat[]>('chats', kv)) ?? []
}

export async function saveChats(chats: LocalChat[]) {
  await set('chats', chats, kv)
}

/**
 * The relay this web app is served from: https://anydot.app/ctl for
 * https://anydot.app/ctl/m/. In development (served from the dev server) it's
 * the official relay.
 */
export function servingRelayUrl(): string {
  const m = /^(.*)\/m(\/.*)?$/.exec(location.pathname)
  return m ? `${location.origin}${m[1]}` : 'https://anydot.app/ctl'
}
