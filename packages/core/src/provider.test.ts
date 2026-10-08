import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl, resolveProtocol } from './provider'

describe('resolveProtocol', () => {
  it.each([
    ['claude-opus-5-5', 'auto', 'anthropic'],
    ['gpt-5', 'auto', 'openai-responses'],
    ['gpt-image-2', 'auto', 'openai-images'],
    ['gpt-image-2', 'anthropic', 'openai-images'],
    ['claude-sonnet-5-5', 'openai', 'openai-responses'],
    ['some-model', 'anthropic', 'anthropic'],
  ] as const)('%s on %s -> %s', (model, type, expected) => {
    expect(resolveProtocol(model, type)).toBe(expected)
  })

  it('honours an explicit override', () => {
    expect(resolveProtocol('gpt-5', 'auto', 'openai-chat')).toBe('openai-chat')
  })
})

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com/v1'],
    ['https://api.example.com/', 'https://api.example.com/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    [' https://api.example.com/proxy ', 'https://api.example.com/proxy/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected)
  })

  it('rejects invalid urls', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow()
  })
})
