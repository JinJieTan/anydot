import { AlertTriangle } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { invoke } from '../lib/api'
import { CopyButton } from './Markdown'
import { Button } from './ui'

/** Send a renderer error to the main process's log file. */
export function logError(err: unknown, source: string): void {
  const e = err instanceof Error ? err : new Error(String(err))
  void invoke('app.logError', { message: e.message, stack: e.stack, source }).catch(() => {})
}

/**
 * Catches render errors so a bug in one view shows a message (and lands in the
 * log) instead of blanking the whole window. Give it a `resetKey` that changes
 * on navigation, so moving elsewhere tries again.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; fullscreen?: boolean },
  { error: Error | null; key?: string }
> {
  override state: { error: Error | null; key?: string } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error: Error | null; key?: string },
  ) {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey }
    return null
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    logError(
      Object.assign(new Error(error.message), {
        stack: `${error.stack ?? ''}\nComponent stack:${info.componentStack ?? ''}`,
      }),
      'render',
    )
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    const details = `${error.message}\n\n${error.stack ?? ''}`
    return (
      <div
        className={`flex flex-1 items-center justify-center p-8 ${this.props.fullscreen ? 'h-full bg-surface' : ''}`}
      >
        <div className="max-w-lg text-center">
          <AlertTriangle className="mx-auto size-8 text-amber-500" />
          <h2 className="mt-3 text-base font-semibold">这里出了点问题</h2>
          <p className="mt-1 text-sm text-fg-soft">
            界面遇到了一个错误，你的数据没有受影响。错误已记录到日志，可以重试或重新加载窗口。
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-muted p-3 text-left text-xs whitespace-pre-wrap text-fg-soft">
            {error.message}
          </pre>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="primary" onClick={() => this.setState({ error: null })}>
              重试
            </Button>
            <Button size="sm" onClick={() => location.reload()}>
              重新加载窗口
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void invoke('app.revealLogs')}>
              打开日志文件夹
            </Button>
            <CopyButton
              text={details}
              className="rounded-lg px-2 text-fg-faint hover:bg-muted hover:text-fg"
            />
          </div>
        </div>
      </div>
    )
  }
}
