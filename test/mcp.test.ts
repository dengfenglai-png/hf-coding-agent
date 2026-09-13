// test/mcp.test.ts
// 测试 MCP client 的 JSON-RPC 请求/响应配对。
import { describe, it, expect } from 'vitest'
import { McpClient, connectMcpTools } from '../src/mcp.js'

// mock MCP server：读 stdin 的 JSON-RPC 请求，按 id 回 result
const mockServer = `
  const rl = require('readline').createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { id: msg.id, method: msg.method } }) + '\\n')
  })
`

describe('McpClient', () => {
  it('sendRequest 收到响应（请求/响应配对）', async () => {
    const client = new McpClient('node', ['-e', mockServer])
    const result = await client.sendRequest('ping')
    expect(result).toEqual({ id: 0, method: 'ping' })
    client.close()
  })

  it('并发请求按 id 正确配对', async () => {
    const client = new McpClient('node', ['-e', mockServer])
    const [r1, r2] = await Promise.all([
      client.sendRequest('a'),
      client.sendRequest('b'),
    ])
    expect(r1).toEqual({ id: 0, method: 'a' })
    expect(r2).toEqual({ id: 1, method: 'b' })
    client.close()
  })
})

describe('connectMcpTools', () => {
  it('发现工具 + 调用工具', async () => {
    // mock MCP server：处理 initialize / tools/list / tools/call
    const server = `
      const rl = require('readline').createInterface({ input: process.stdin })
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
        if (msg.method === 'initialize') respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } })
        else if (msg.method === 'tools/list') respond({ tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
        else if (msg.method === 'tools/call') respond({ content: [{ type: 'text', text: 'ECHO: ' + msg.params.arguments.text }], isError: false })
      })
    `

    const tools = await connectMcpTools('node', ['-e', server])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('echo')
    const result = await tools[0].execute({ text: 'hi' })
    expect(result).toBe('ECHO: hi')
  })
})
