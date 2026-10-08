import { Check, Copy } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

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
          <CopyButton
            text={textContent(children).replace(/\n$/, '')}
            className="rounded p-1 hover:bg-muted hover:text-fg"
          />
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
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
