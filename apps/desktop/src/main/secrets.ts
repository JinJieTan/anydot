import { safeStorage } from 'electron'

/**
 * API keys at rest. Encrypted with the OS keychain (macOS Keychain, Windows
 * DPAPI, libsecret on Linux) via safeStorage. If no keychain is available we
 * fall back to plain storage and say so in the UI rather than failing.
 */
export function keyStorageKind(): 'os' | 'plain' {
  return safeStorage.isEncryptionAvailable() ? 'os' : 'plain'
}

export function encryptKey(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `os:${safeStorage.encryptString(key).toString('base64')}`
  }
  return `plain:${Buffer.from(key, 'utf8').toString('base64')}`
}

export function decryptKey(ref: string | null): string | null {
  if (!ref) return null
  const [kind, data] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]
  if (kind === 'os') return safeStorage.decryptString(Buffer.from(data, 'base64'))
  if (kind === 'plain') return Buffer.from(data, 'base64').toString('utf8')
  return null
}

/** "sk-abc…wxyz" for display. Short keys are fully masked. */
export function keyHint(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}
