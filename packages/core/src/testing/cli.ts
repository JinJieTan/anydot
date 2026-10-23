/**
 * Run the mock gateway standalone: `pnpm --filter @aitech/core mock`
 *
 * Plain chats get a canned Markdown reply. Requests that offer tools (project
 * conversations) get a scripted agent run: todo list → list files → run a
 * command (needs approval in "ask" mode) → summary.
 */
import { startMockServer } from './mock-server'

const server = await startMockServer({
  delayMs: 40,
  reply: (r) => {
    const body = r.body as { tools?: unknown[] }
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
    // "html": a page to open in the artifact panel.
    if (/html/i.test(r.lastUserText) && !r.toolResults.length)
      return {
        text:
          '一个可以在侧栏预览的页面：\n\n```html\n<!doctype html><html><head><title>计数器</title></head>' +
          '<body style="font-family:system-ui;text-align:center;padding:40px"><h1>计数器</h1>' +
          '<button onclick="n.textContent=+n.textContent+1">+1</button> <span id="n">0</span>' +
          '</body></html>\n```',
      }
    // "提问": the ask_user tool.
    if (hasTools && /提问/.test(r.lastUserText)) {
      if (!r.toolResults.length)
        return {
          toolCalls: [
            {
              name: 'ask_user',
              input: {
                questions: [
                  {
                    question: '用哪种数据库？',
                    header: '数据库',
                    options: [
                      { label: 'SQLite (推荐)', description: '零配置，适合本地' },
                      { label: 'Postgres', description: '需要单独部署' },
                    ],
                  },
                ],
              },
            },
          ],
        }
      return { text: `收到：${r.toolResults.at(-1)}` }
    }
    if (hasTools) {
      const step = r.toolResults.length
      if (step === 0)
        return {
          text: '我先看一下项目结构。',
          toolCalls: [
            {
              name: 'todo_write',
              input: {
                todos: [
                  { content: '了解项目结构', status: 'in_progress' },
                  { content: '创建示例文件', status: 'pending' },
                ],
              },
            },
            { name: 'list_files', input: { pattern: '**/*' } },
          ],
        }
      if (step === 2)
        return {
          toolCalls: [
            {
              name: 'bash',
              input: { command: 'echo "hello from agent" > agent-demo.txt && cat agent-demo.txt' },
            },
          ],
        }
      return { text: `完成了。最后一步的输出：\n\n\`\`\`\n${r.toolResults.at(-1)}\n\`\`\`` }
    }
    return {
      reasoning: r.path === '/v1/messages' ? '先理解问题，再组织回答。' : undefined,
      text: `这是来自本地模拟网关的回复。用于在没有真实 Key 的情况下调试界面、流式输出和停止生成。\n\n你说的是：**${r.lastUserText || '（空）'}**\n\n\`\`\`ts\nconsole.log('hello from ${r.path}')\n\`\`\``,
    }
  },
})
console.log(`mock gateway: ${server.url}  key: sk-test`)
