import type { Api } from '../../../preload'

export const api: Api = window.api
export const invoke = api.invoke.bind(api) as Api['invoke']

/** URL the renderer can load a stored blob from (served by the main process). */
export const blobUrl = (sha256: string) => `aitech-blob://blob/${sha256}`

export const isMac = api.platform === 'darwin'
