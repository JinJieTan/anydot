import { BrowserWindow, Notification } from 'electron'
import type { Store } from '@aitech/db'
import type { ChatStreamEvent } from '../shared/ipc'

/**
 * System notifications for chat runs while the app is in the background:
 * a run finished or failed, or the agent is waiting for an approval.
 * Clicking one brings the window forward on that conversation.
 */
export class Notifier {
  /** Keep references so notifications aren't garbage-collected before they're clicked. */
  private shown = new Set<Notification>()

  constructor(
    private readonly store: Store,
    private readonly enabled: () => boolean,
    private readonly window: () => BrowserWindow | null,
    private readonly open: (conversationId: string) => void,
  ) {}

  onChatEvent(e: ChatStreamEvent): void {
    if (e.type === 'approval') {
      const { approval } = e
      const what = approval.questions ? '有问题需要你回答' : '需要你确认'
      this.show(
        approval.conversationId,
        what,
        approval.questions?.[0]?.question ?? approval.summary,
      )
    } else if (e.type === 'run' && !e.running) {
      this.show(e.conversationId, e.error ? '任务出错' : '任务完成', e.error)
    }
  }

  private show(conversationId: string, what: string, detail?: string) {
    if (!this.enabled() || !Notification.isSupported()) return
    if (BrowserWindow.getFocusedWindow()) return
    const title = this.store.getConversation(conversationId)?.title ?? '新对话'
    const n = new Notification({
      title: `${what} · ${title}`,
      body: (detail ?? '').slice(0, 200),
      silent: false,
    })
    n.on('click', () => {
      const win = this.window()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      this.open(conversationId)
    })
    n.on('close', () => this.shown.delete(n))
    this.shown.add(n)
    n.show()
  }
}
