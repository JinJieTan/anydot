import { ToolInputError, type AgentTool, type Question } from './types'

export const askUserTool: AgentTool<{ questions: Question[] }> = {
  kind: 'meta',
  definition: {
    name: 'ask_user',
    description:
      'Ask the user 1-4 multiple-choice questions and wait for the answers. Use it when a decision is ' +
      "genuinely the user's (unclear requirements, a choice between approaches with real trade-offs), not " +
      'for things you can find out yourself or settle with a sensible default. Put the recommended option ' +
      'first and add "(推荐)" / "(Recommended)" to its label. The user can always type their own answer instead.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The full question, ending with "?"' },
              header: { type: 'string', description: 'Very short label (max ~12 chars)' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '1-5 words' },
                    description: { type: 'string', description: 'What choosing it means' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow choosing several options' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  describe: (input) =>
    `向你提问：${Array.isArray(input.questions) ? (input.questions[0]?.question ?? '') : ''}`,
  async run(input, ctx) {
    const questions = validate(input.questions)
    if (!ctx.ask) return { output: 'Asking the user is not available here.', isError: true }
    const answers = await ctx.ask(questions, ctx.toolCallId)
    if (!answers)
      return {
        output:
          'The user dismissed the questions without answering. Continue with your best judgement, ' +
          'or ask in your reply if you cannot proceed.',
      }
    const lines = questions.map(
      (q) => `"${q.question}" = "${answers[q.question] ?? '(no answer)'}"`,
    )
    return { output: `The user answered:\n${lines.join('\n')}` }
  },
}

function validate(v: unknown): Question[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 4)
    throw new ToolInputError('"questions" must be an array of 1-4 questions')
  return v.map((q: Partial<Question>, i) => {
    if (!q || typeof q.question !== 'string' || !q.question.trim())
      throw new ToolInputError(`questions[${i}].question must be a non-empty string`)
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4)
      throw new ToolInputError(`questions[${i}].options must have 2-4 options`)
    return {
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: !!q.multiSelect,
      options: q.options.map((o, j) => {
        if (!o || typeof o.label !== 'string' || !o.label.trim())
          throw new ToolInputError(`questions[${i}].options[${j}].label must be a non-empty string`)
        return {
          label: o.label,
          description: typeof o.description === 'string' ? o.description : undefined,
        }
      }),
    }
  })
}
