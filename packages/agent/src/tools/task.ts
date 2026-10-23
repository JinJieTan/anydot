import { str, type AgentTool } from './types'

export const taskTool: AgentTool<{ description: string; prompt: string }> = {
  kind: 'meta',
  definition: {
    name: 'task',
    description:
      'Hand a self-contained research task to a sub-agent with its own fresh context. It can read files, ' +
      'search and browse the web, but cannot change anything. Only its final report comes back, so use it ' +
      'for broad searches and investigations that would otherwise fill your context with file contents. ' +
      'Give it everything it needs in the prompt (it cannot see this conversation) and say what the report ' +
      'should contain. Several task calls in one turn run in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short (3-6 word) label for the task' },
        prompt: { type: 'string', description: 'The full task for the sub-agent' },
      },
      required: ['description', 'prompt'],
    },
  },
  describe: (input) => `子任务：${input.description}`,
  async run(input, ctx) {
    const prompt = str(input.prompt, 'prompt')
    if (!ctx.subagent) return { output: 'Sub-agents are not available here.', isError: true }
    return ctx.subagent(prompt, ctx.toolCallId)
  },
}
