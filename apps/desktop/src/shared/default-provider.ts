import { inferCapabilities, listModels } from '@aitech/core'
import type { Store } from '@aitech/db'

/**
 * The built-in "AnyDot 默认" provider: requests go to the relay at anydot.app,
 * which adds the real key server-side (apps/relay/src/default-llm.ts). The
 * app only holds a placeholder key. Shared by the web worker and the desktop
 * main process; the relay decides which of the two it serves.
 */
export const DEFAULT_PROVIDER_URL = 'https://anydot.app/ctl/llm/v1'
export const DEFAULT_PROVIDER_NAME = 'AnyDot 默认'
const PLACEHOLDER_KEY = 'anydot-default'
const SEEDED = 'defaultProviderSeeded'

/**
 * Adds the default provider once per install, when the relay offers it to
 * this client. Not re-added after the user deletes it; retried on the next
 * start while the relay turns this client away. Returns whether it was added.
 */
export async function seedDefaultProvider(
  store: Store,
  encryptKey: (key: string) => string | Promise<string>,
  baseUrl = DEFAULT_PROVIDER_URL,
): Promise<boolean> {
  if (store.getSetting<boolean>(SEEDED, false)) return false
  let models: Awaited<ReturnType<typeof listModels>>
  try {
    models = await listModels(baseUrl, PLACEHOLDER_KEY)
  } catch {
    return false
  }
  if (!models.length) return false
  const p = store.createProvider({
    name: DEFAULT_PROVIDER_NAME,
    baseUrl,
    type: 'auto',
    keyRef: await encryptKey(PLACEHOLDER_KEY),
  })
  store.syncModels(
    p.id,
    models.map((m) => ({ id: m.id, capabilities: inferCapabilities(m.id, p.type) })),
  )
  store.setSetting(SEEDED, true)
  return true
}
