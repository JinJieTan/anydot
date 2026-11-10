import type { Api } from '../../../preload'

export const api: Api = window.api
export const invoke = api.invoke.bind(api) as Api['invoke']

/** URL the renderer can load a stored blob from. */
export const blobUrl = api.blobUrl

export const isMac = api.platform === 'darwin'

/** The browser build: desktop-only features (projects, tools, MCP, phone…) are hidden. */
export const isWeb = api.platform === 'web'
