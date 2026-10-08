import type { AgentTool } from './types'

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export const todoTool: AgentTool<{ todos: Todo[] }> = {
  kind: 'meta',
  definition: {
    name: 'todo_write',
    description:
      'Maintain a short task list for multi-step work. Send the full list every time; keep exactly one ' +
      'item in_progress while working. The user sees this list.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  describe: () => '更新任务列表',
  async run(input) {
    const todos = Array.isArray(input.todos) ? input.todos : []
    const done = todos.filter((t) => t.status === 'completed').length
    return { output: `Task list updated (${done}/${todos.length} completed).` }
  },
}
