/** Run the mock gateway standalone: `pnpm --filter @aitech/core mock` */
import { startMockServer } from './mock-server'

const server = await startMockServer({
  delayMs: 40,
  reply: (r) => ({
    reasoning: r.path === '/v1/messages' ? '先理解问题，再组织回答。' : undefined,
    text: `这是来自本地模拟网关的回复。用于在没有真实 Key 的情况下调试界面、流式输出和停止生成。\n\n你说的是：**${r.lastUserText || '（空）'}**\n\n\`\`\`ts\nconsole.log('hello from ${r.path}')\n\`\`\``,
  }),
})
console.log(`mock gateway: ${server.url}  key: sk-test`)
