// verify-tool-deny.sh 用のダミー MCP サーバー。
// Slack には一切触らず、tools/call が届いたかどうかだけを合図として返す。
// サーバー名は --mcp-config 側で決めるので、ここは中身を持たない。
const send = (msg: unknown) => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const TOOLS = [
  {
    name: 'reply',
    description: 'Echo a marker so the caller can tell whether this tool was reachable.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]

let buffer = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString()
  let index: number
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let req: { id?: unknown; method?: string }
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    if (req.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'deny-fixture', version: '0.0.0' },
        },
      })
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } })
    } else if (req.method === 'tools/call') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: 'TOOL_REACHED' }] },
      })
    } else if (req.id !== undefined) {
      send({ jsonrpc: '2.0', id: req.id, result: {} })
    }
  }
})
