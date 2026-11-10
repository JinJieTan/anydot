/**
 * Mounts the desktop's renderer. Imported only after `window.api` exists:
 * the renderer reads it when its modules load.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../desktop/src/renderer/src/App'
import { ErrorBoundary, logError } from '../../desktop/src/renderer/src/components/ErrorBoundary'

export function mount(el: HTMLElement): () => void {
  const onError = (e: ErrorEvent) => logError(e.error ?? e.message, 'window')
  const onRejection = (e: PromiseRejectionEvent) => logError(e.reason, 'promise')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  const root = createRoot(el)
  root.render(
    <StrictMode>
      <ErrorBoundary fullscreen>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
  return () => {
    root.unmount()
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
