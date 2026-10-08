import { Check, Copy, Play } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { invoke } from '../lib/api'

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return textContent((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={className}
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

const components: Components = {
  pre({ children }) {
    const code = Array.isArray(children) ? children[0] : children
    const className =
      (code && typeof code === 'object' && 'props' in code
        ? (code as { props: { className?: string } }).props.className
        : '') ?? ''
    const lang = /language-([\w-]+)/.exec(className)?.[1] ?? ''
    return (
      <div className="code-block overflow-hidden rounded-xl border border-line bg-code">
        <div className="flex h-8 items-center justify-between border-b border-line px-3 text-xs text-fg-faint">
          <span>{lang || 'text'}</span>
          <div className="flex items-center gap-1">
            {(lang === 'html' || lang === 'svg') && (
              <button
                type="button"
                title="在独立窗口中预览"
                className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-muted hover:text-fg"
                onClick={() => void invoke('preview.html', textContent(children))}
              >
                <Play className="size-3" />
                预览
              </button>
            )}
            <CopyButton
              text={textContent(children).replace(/\n$/, '')}
              className="rounded p-1 hover:bg-muted hover:text-fg"
            />
          </div>
        </div>
        <pre>{children}</pre>
      </div>
    )
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
