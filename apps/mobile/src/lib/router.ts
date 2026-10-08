import { useEffect, useState } from 'react'

/** Minimal hash router: "#/d/abc/c/xyz" → ["d", "abc", "c", "xyz"]. */
export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean)
}

export function go(path: string, replace = false) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`
  if (replace) history.replaceState(null, '', target)
  else location.hash = target
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function back(fallback = '/') {
  if (history.length > 1) history.back()
  else go(fallback, true)
}
