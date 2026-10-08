import { startMockServer, type MockServer } from '@aitech/core/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Computer, type NativeDriver } from './computer'
import { runAgent } from './loop'
import { computerTool } from './tools'

let server: MockServer

beforeAll(async () => {
  server = await startMockServer({
    reply: (r) =>
      r.toolResults.length
        ? { text: 'done' }
        : { toolCalls: [{ name: 'computer', input: { action: 'screenshot' } }] },
  })
})
afterAll(() => server.close())

const driver: NativeDriver = {
  displays: async () => [
    {
      id: '1',
      name: 'Main',
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      main: true,
      index: 0,
    },
  ],
  capture: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  cursor: async () => ({ x: 0, y: 0 }),
  move: async () => {},
  click: async () => {},
  mouse: async () => {},
  drag: async () => {},
  scroll: async () => {},
  type: async () => {},
  key: async () => {},
  dispose() {},
}

async function runScreenshot(modelId: string) {
  const before = server.requests.length
  const result = await runAgent({
    model: { provider: { baseUrl: server.url, apiKey: 'sk-test', type: 'auto' }, modelId },
    messages: [{ role: 'user', content: 'look at my screen' }],
    tools: [computerTool() as never],
    mode: 'auto',
    ctx: {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      platform: process.platform,
      env: process.env,
      readFiles: new Map(),
      computer: new Computer(driver),
    },
    onEvent: () => {},
    approve: async () => 'allow',
  })
  expect(result.status).toBe('done')
  const followUp = server.requests.slice(before).at(-1)!
  return JSON.stringify(followUp.body)
}

describe('screenshots in tool results', () => {
  it('reach Claude as image blocks', async () => {
    const body = await runScreenshot('claude-sonnet-5-5')
    expect(body).toMatch(/"type":"tool_result"/)
    expect(body).toMatch(/"type":"image","source":\{"type":"base64","media_type":"image\/jpeg"/)
  })

  it('reach GPT (Responses API) as input_image', async () => {
    const body = await runScreenshot('gpt-5')
    expect(body).toMatch(/"type":"function_call_output"/)
    expect(body).toMatch(/"type":"input_image","image_url":"data:image\/jpeg;base64,/)
  })
})
