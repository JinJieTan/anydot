import { create } from 'zustand'

export type ArtifactKind = 'html' | 'svg' | 'mermaid' | 'markdown'

export interface Artifact {
  title: string
  kind: ArtifactKind
  content: string
  /** Set when it came from a file on disk (so it can be reloaded). */
  file?: { conversationId: string; path: string }
}

/** Code-block languages and file extensions the panel can render. */
export function artifactKind(langOrExt: string): ArtifactKind | null {
  switch (langOrExt.toLowerCase().replace(/^\./, '')) {
    case 'html':
    case 'htm':
      return 'html'
    case 'svg':
      return 'svg'
    case 'mermaid':
    case 'mmd':
      return 'mermaid'
    case 'md':
    case 'markdown':
      return 'markdown'
    default:
      return null
  }
}

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs'

/** A full page for the sandboxed iframe (everything but markdown). */
export function artifactPage(a: Artifact, dark: boolean): string {
  const bg = dark ? '#0a0a0a' : '#ffffff'
  const fg = dark ? '#e5e5e5' : '#171717'
  if (a.kind === 'html') return a.content
  const escaped = a.content.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const body =
    a.kind === 'svg'
      ? a.content
      : `<pre class="mermaid">${escaped}</pre>
<script type="module">
  import mermaid from '${MERMAID_URL}'
  mermaid.initialize({ startOnLoad: true, theme: '${dark ? 'dark' : 'default'}' })
</script>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${bg};color:${fg};font-family:system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
svg{max-width:100%;height:auto}
</style></head><body>${body}</body></html>`
}

/** The right-hand side panel: one artifact, or a conversation's uncommitted changes. */
interface SidePanelState {
  artifact: Artifact | null
  /** Conversation whose folder's git changes are shown. */
  changesFor: string | null
  open: (a: Artifact) => void
  openChanges: (conversationId: string) => void
  close: () => void
}

export const useArtifact = create<SidePanelState>((set) => ({
  artifact: null,
  changesFor: null,
  open: (artifact) => set({ artifact, changesFor: null }),
  openChanges: (changesFor) => set({ changesFor, artifact: null }),
  close: () => set({ artifact: null, changesFor: null }),
}))
