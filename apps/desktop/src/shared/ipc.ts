/** IPC contract shared by main, preload and renderer. */
export const IpcChannel = {
  AppInfo: 'app:info',
  AgentPing: 'agent:ping',
} as const

export interface AppInfo {
  version: string
  platform: string
  versions: { electron: string; chrome: string; node: string }
  db: { path: string; schemaVersion: number }
}

export interface AgentPong {
  ok: boolean
  latencyMs: number
  pid?: number
  error?: string
}

/** Messages between main and the agent utilityProcess. */
export type AgentRequest = { type: 'ping'; id: string }
export type AgentResponse = { type: 'pong'; id: string; pid: number }
