import { describe, expect, it } from 'vitest'
import { capOutputTokens, estimateInputTokens } from './token-limits'

describe('estimateInputTokens', () => {
  it('counts CJK per character, other text per 4 characters', () => {
    expect(
      estimateInputTokens({ model: 'x', messages: [{ role: 'user', content: '你好世界' }] }),
    ).toBe(4)
    expect(estimateInputTokens({ messages: [{ role: 'user', content: 'abcdefgh' }] })).toBe(2)
  })

  it('counts an image as a flat amount, not by its base64 length', () => {
    const img = 'A'.repeat(400_000)
    const chat = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }],
        },
      ],
    }
    const anthropic = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } },
          ],
        },
      ],
    }
    expect(estimateInputTokens(chat)).toBe(1000)
    expect(estimateInputTokens(anthropic)).toBe(1000)
    // Non-image files count by size.
    expect(
      estimateInputTokens({
        input: [{ file_data: `data:application/pdf;base64,${'A'.repeat(4000)}` }],
      }),
    ).toBe(750)
  })
})

describe('capOutputTokens', () => {
  it('caps or sets the limit for each protocol', () => {
    const responses: Record<string, unknown> = { model: 'gpt-5', max_output_tokens: 99_999 }
    capOutputTokens('/responses', responses, 15_000)
    expect(responses.max_output_tokens).toBe(15_000)

    const unset: Record<string, unknown> = { model: 'gpt-5' }
    capOutputTokens('/responses', unset, 15_000)
    expect(unset.max_output_tokens).toBe(15_000)

    const small: Record<string, unknown> = { max_output_tokens: 500 }
    expect(capOutputTokens('/responses', small, 15_000)).toBe(false)

    const chatReasoning: Record<string, unknown> = { model: 'gpt-5-mini' }
    capOutputTokens('/chat/completions', chatReasoning, 15_000)
    expect(chatReasoning).toEqual({ model: 'gpt-5-mini', max_completion_tokens: 15_000 })

    const chatOld: Record<string, unknown> = { model: 'deepseek-chat', max_tokens: 64_000 }
    capOutputTokens('/chat/completions', chatOld, 15_000)
    expect(chatOld.max_tokens).toBe(15_000)

    const messages: Record<string, unknown> = {
      model: 'claude-x',
      max_tokens: 64_000,
      thinking: { type: 'enabled', budget_tokens: 32_000 },
    }
    capOutputTokens('/messages', messages, 15_000)
    expect(messages).toMatchObject({ max_tokens: 15_000, thinking: { budget_tokens: 14_999 } })

    const tiny: Record<string, unknown> = {
      max_tokens: 64_000,
      thinking: { type: 'enabled', budget_tokens: 2000 },
    }
    capOutputTokens('/messages', tiny, 1000)
    expect(tiny).toEqual({ max_tokens: 1000 })
  })
})
