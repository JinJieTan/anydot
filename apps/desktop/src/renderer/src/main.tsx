import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary, logError } from './components/ErrorBoundary'
import './index.css'

window.addEventListener('error', (e) => logError(e.error ?? e.message, 'window'))
window.addEventListener('unhandledrejection', (e) => logError(e.reason, 'promise'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fullscreen>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
