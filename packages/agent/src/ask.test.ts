import { describe, expect, it } from 'vitest'
import { askUserTool } from './tools/ask'
import { ToolInputError, type Question, type ToolContext } from './tools/types'

const base: ToolContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  platform: process.platform,
  env: {},
  readFiles: new Map(),
  toolCallId: 'call-1',
}
const questions: Question[] = [
  { question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
]

describe('ask_user', () => {
  it('returns the answers keyed by question', async () => {
    let seen: { qs: Question[]; id?: string } | null = null
    const res = await askUserTool.run(
      { questions },
      {
        ...base,
        ask: async (qs, id) => {
          seen = { qs, id }
          return { 'Which DB?': 'SQLite' }
        },
      },
    )
    expect(seen).toEqual({
      qs: [
        {
          ...questions[0],
          header: undefined,
          multiSelect: false,
          options: [
            { label: 'SQLite', description: undefined },
            { label: 'Postgres', description: undefined },
          ],
        },
      ],
      id: 'call-1',
    })
    expect(res.output).toBe('The user answered:\n"Which DB?" = "SQLite"')
  })

  it('reports a dismissal', async () => {
    const res = await askUserTool.run({ questions }, { ...base, ask: async () => null })
    expect(res.output).toMatch(/dismissed/)
    expect(res.isError).toBeUndefined()
  })

  it('validates the questions', async () => {
    const ctx = { ...base, ask: async () => ({}) }
    await expect(askUserTool.run({ questions: [] }, ctx)).rejects.toThrow(ToolInputError)
    await expect(
      askUserTool.run({ questions: [{ question: 'Q?', options: [{ label: 'only' }] }] }, ctx),
    ).rejects.toThrow(/2-4 options/)
  })

  it('is unavailable without a UI', async () => {
    const res = await askUserTool.run({ questions }, base)
    expect(res.isError).toBe(true)
  })
})
