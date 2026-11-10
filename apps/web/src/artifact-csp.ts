/**
 * CSP for public/artifact.html, the page model-generated HTML runs in. Same
 * rules as the desktop's artifact server (inline scripts and https libraries,
 * no network requests), plus `sandbox`: the page gets an opaque origin even
 * when opened in its own tab, so it can never read the app's storage or keys.
 *
 * nginx must send the same header for /app/artifact.html (see README.md).
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  'sandbox allow-scripts allow-popups allow-forms allow-modals',
].join('; ')
