import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { ComputerPermissions } from '../shared/ipc'

const PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

export function computerPermissions(): ComputerPermissions {
  if (process.platform === 'win32')
    return { supported: true, accessibility: true, screen: 'granted' }
  if (process.platform !== 'darwin')
    return { supported: false, accessibility: false, screen: 'unknown' }
  return {
    supported: true,
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus('screen'),
  }
}

/**
 * Ask macOS for a permission. The first request shows the system prompt;
 * after that the only way is the System Settings pane, which we open.
 */
export async function requestComputerPermission(
  kind: 'accessibility' | 'screen',
): Promise<ComputerPermissions> {
  if (process.platform !== 'darwin') return computerPermissions()
  if (kind === 'accessibility') {
    if (!systemPreferences.isTrustedAccessibilityClient(true))
      void shell.openExternal(PANES.accessibility)
  } else if (systemPreferences.getMediaAccessStatus('screen') === 'not-determined') {
    // Capturing once registers the app and shows the prompt.
    await desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => {})
  } else if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    void shell.openExternal(PANES.screen)
  }
  return computerPermissions()
}
