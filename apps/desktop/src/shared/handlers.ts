/**
 * RPC handlers that don't depend on the runtime, shared by the desktop main
 * process and the web app's worker. No Node or Electron imports here: how a
 * key is encrypted and how changes are announced come in through `deps`.
 */
import { inferCapabilities, listModels, normalizeBaseUrl } from '@aitech/core'
import type { ProviderRow, Store } from '@aitech/db'
import { DEFAULT_SETTINGS, type Events, type ProviderDTO, type Rpc, type Settings } from './ipc'

export const SETTINGS_KEY = 'app.settings'

export function loadSettings(store: Store): Settings {
  return { ...DEFAULT_SETTINGS, ...store.getSetting<Partial<Settings>>(SETTINGS_KEY, {}) }
}

/** "sk-abc…wxyz" for display. Short keys are fully masked. */
export function keyHint(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export function validateBaseUrl(url: string): string {
  const trimmed = url.trim()
  let normalized: string
  try {
    normalized = normalizeBaseUrl(trimmed)
  } catch {
    throw new Error('Base URL 格式不正确，例如 https://api.example.com')
  }
  if (!/^https?:\/\//.test(normalized)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  return trimmed.replace(/\/+$/, '')
}

export interface DataHandlerDeps {
  store: Store
  encryptKey: (key: string) => string | Promise<string>
  /** null when the key can't be read (e.g. data copied from another machine). */
  decryptKey: (ref: string | null) => string | null | Promise<string | null>
  invalidate: (scope: Events['invalidate']['scope']) => void
}

type Handlers<K extends keyof Rpc> = {
  [M in K]: (...args: Parameters<Rpc[M]>) => ReturnType<Rpc[M]> | Promise<ReturnType<Rpc[M]>>
}

export type ProviderMethod =
  | 'providers.list'
  | 'providers.create'
  | 'providers.update'
  | 'providers.delete'
  | 'providers.test'
  | 'providers.syncModels'
  | 'models.list'
  | 'models.available'
  | 'models.add'
  | 'models.update'
  | 'models.delete'

/** Providers and their models: the same on desktop and on the web. */
export function providerHandlers({
  store,
  encryptKey,
  decryptKey,
  invalidate,
}: DataHandlerDeps): Handlers<ProviderMethod> {
  const safeDecrypt = async (ref: string | null) => {
    try {
      return await decryptKey(ref)
    } catch {
      return null
    }
  }
  const toDTO = async (p: ProviderRow): Promise<ProviderDTO> => {
    const key = await safeDecrypt(p.keyRef)
    return {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      type: p.type,
      enabled: p.enabled,
      hasKey: !!key,
      keyHint: keyHint(key),
    }
  }

  return {
    'providers.list': () => Promise.all(store.listProviders().map(toDTO)),
    'providers.create': async (input) => {
      const name = input.name.trim()
      if (!name) throw new Error('请填写名称')
      const key = input.apiKey?.trim()
      if (!key) throw new Error('请填写 API Key')
      const p = store.createProvider({
        name,
        baseUrl: validateBaseUrl(input.baseUrl),
        type: input.type,
        keyRef: await encryptKey(key),
      })
      invalidate('providers')
      return toDTO(p)
    },
    'providers.update': async (id, input) => {
      const patch: Parameters<Store['updateProvider']>[1] = {}
      if (input.name !== undefined) {
        if (!input.name.trim()) throw new Error('请填写名称')
        patch.name = input.name.trim()
      }
      if (input.baseUrl !== undefined) patch.baseUrl = validateBaseUrl(input.baseUrl)
      if (input.type !== undefined) patch.type = input.type
      if (input.enabled !== undefined) patch.enabled = input.enabled
      if (input.apiKey?.trim()) patch.keyRef = await encryptKey(input.apiKey.trim())
      const p = store.updateProvider(id, patch)
      invalidate('providers')
      return toDTO(p)
    },
    'providers.delete': (id) => {
      store.deleteProvider(id)
      invalidate('providers')
    },
    'providers.test': async (target) => {
      const saved = target.id ? store.getProvider(target.id) : undefined
      const baseUrl = target.baseUrl ?? saved?.baseUrl
      const apiKey = target.apiKey?.trim() || (await safeDecrypt(saved?.keyRef ?? null))
      if (!baseUrl) return { ok: false, error: '请填写 Base URL' }
      if (!apiKey) return { ok: false, error: '请填写 API Key' }
      try {
        const models = await listModels(validateBaseUrl(baseUrl), apiKey)
        return { ok: true, models: models.length }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    'providers.syncModels': async (id) => {
      const p = store.getProvider(id)
      if (!p) throw new Error('服务商不存在')
      const key = await safeDecrypt(p.keyRef)
      if (!key) throw new Error('服务商未配置 Key')
      const remote = await listModels(p.baseUrl, key)
      const caps = remote.map((m) => ({ id: m.id, capabilities: inferCapabilities(m.id, p.type) }))
      const { added } = store.syncModels(id, caps)
      invalidate('models')
      return { added, total: store.listModels(id).length }
    },

    'models.list': (providerId) => store.listModels(providerId),
    'models.available': () => store.listAvailableModels(),
    'models.add': ({ providerId, modelId, protocol }) => {
      const id = modelId.trim()
      if (!id) throw new Error('请填写模型 ID')
      const p = store.getProvider(providerId)
      if (!p) throw new Error('服务商不存在')
      store.syncModels(providerId, [{ id, capabilities: inferCapabilities(id, p.type) }])
      const row = store.listModels(providerId).find((m) => m.modelId === id)!
      const updated = protocol !== undefined ? store.updateModel(row.id, { protocol }) : row
      invalidate('models')
      return updated
    },
    'models.update': (id, patch) => {
      const m = store.updateModel(id, patch)
      invalidate('models')
      return m
    },
    'models.delete': (id) => {
      store.deleteModel(id)
      invalidate('models')
    },
  }
}
