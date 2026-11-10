import { inferCapabilities, listModels } from '@aitech/core'
import type { Store } from '@aitech/db/browser'

/**
 * The built-in "AnyDot 默认" provider: requests go to the relay at anydot.app,
 * which adds the real key server-side (apps/relay/src/default-llm.ts). The
 * browser only holds a placeholder key. Override the URL with
 * VITE_DEFAULT_LLM_URL (e.g. a local relay in dev).
 */
export const DEFAULT_PROVIDER_URL =
  (import.meta.env.VITE_DEFAULT_LLM_URL as string | undefined) ?? 'https://anydot.app/ctl/llm/v1'
export const DEFAULT_PROVIDER_NAME = 'AnyDot 默认'
const PLACEHOLDER_KEY = 'anydot-default'
const SEEDED = 'web.defaultProviderSeeded'

/**
 * Adds the default provider once per browser, when the relay offers it.
 * Not re-added after the user deletes it; retried on the next start while
 * the relay has it switched off. Returns whether anything was added.
 */
export async function seedDefaultProvider(
  store: Store,
  encryptKey: (key: string) => Promise<string>,
): Promise<boolean> {
  if (store.getSetting<boolean>(SEEDED, false)) return false
  let models: Awaited<ReturnType<typeof listModels>>
  try {
    models = await listModels(DEFAULT_PROVIDER_URL, PLACEHOLDER_KEY)
  } catch {
    return false
  }
  if (!models.length) return false
  const p = store.createProvider({
    name: DEFAULT_PROVIDER_NAME,
    baseUrl: DEFAULT_PROVIDER_URL,
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
