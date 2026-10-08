// Minimal MCP stdio server for tests: tools "add" and "whoami" (read-only).
import { createInterface } from 'node:readline'
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.id === undefined) return // notification
  switch (req.method) {
    case 'initialize':
      return send({
        id: req.id,
        result: {
          protocolVersion: req.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock', version: '1.0.0' },
        },
      })
    case 'tools/list':
      return send({
        id: req.id,
        result: {
          tools: [
            {
              name: 'add',
              description: 'Add two numbers',
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
              },
            },
            {
              name: 'whoami',
              description: 'Report env',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      })
    case 'tools/call': {
      const { name, arguments: args } = req.params
      if (name === 'add')
        return send({
          id: req.id,
          result: { content: [{ type: 'text', text: String(args.a + args.b) }] },
        })
      if (name === 'whoami')
        return send({
          id: req.id,
          result: { content: [{ type: 'text', text: process.env.MCP_TEST_VAR ?? 'unset' }] },
        })
      return send({
        id: req.id,
        result: { content: [{ type: 'text', text: 'no such tool' }], isError: true },
      })
    }
    default:
      return send({ id: req.id, error: { code: -32601, message: 'Method not found' } })
  }
})
