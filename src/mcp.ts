// src/mcp.ts
// MCP（Model Context Protocol）client：通过 stdio 连接外部工具服务。
// 手写最小 JSON-RPC 2.0 over stdio（零依赖），只实现核心方法。

import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'
import type { AgentTool } from './agent.js'

/** 待响应的请求回调 */
interface Pending {
  resolve: (result: unknown) => void
  reject: (e: Error) => void
}

/** MCP client：spawn 子进程，通过 stdio 收发 JSON-RPC 消息（NDJSON 每行一个） */
export class McpClient {
  private child: ChildProcess
  private nextId = 0
  private pending = new Map<number, Pending>()

  constructor(command: string, args: string[] = []) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })

    // spawn 失败（命令不存在等）时，reject 所有待响应的请求
    this.child.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e)
      this.pending.clear()
    })

    const rl = readline.createInterface({ input: this.child.stdout! })
    rl.on('line', (line) => this.handleLine(line))
  }

  /** 解析一行响应，按 id 匹配到对应的请求 */
  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: unknown }
    try { msg = JSON.parse(line) } catch { return }  // 忽略非 JSON 行
    if (msg.id === undefined) return  // 通知（无 id）忽略

    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result)
  }

  /** 发送 JSON-RPC 请求，返回 Promise<result> */
  sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const request = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    this.child.stdin!.write(JSON.stringify(request) + '\n')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  /** 关闭连接，杀掉子进程 */
  close(): void {
    this.child.kill()
  }
}

/** MCP 工具定义（tools/list 返回的单个工具） */
interface McpToolDef {
  name: string
  description?: string
  inputSchema?: object
}

/** 把 MCP 工具包装成 AgentTool：inputSchema 直接复用为 parameters */
function mcpToolToAgentTool(client: McpClient, tool: McpToolDef): AgentTool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    execute: async (args) => {
      const r = await client.sendRequest('tools/call', { name: tool.name, arguments: args }) as {
        content?: { type: string; text?: string }[]
        isError?: boolean
      }
      const text = (r.content ?? []).map(c => c.text ?? '').join('')
      return r.isError ? `error: ${text}` : text
    },
  }
}

/** 连接 MCP server（stdio），返回其工具包装成的 AgentTool 数组 */
export async function connectMcpTools(command: string, args: string[] = []): Promise<AgentTool[]> {
  const client = new McpClient(command, args)

  // 握手：告诉 server 协议版本和能力
  await client.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'hf-coding-agent', version: '0.1.0' },
  })

  // 发现工具
  const result = await client.sendRequest('tools/list') as { tools?: McpToolDef[] }
  return (result.tools ?? []).map(t => mcpToolToAgentTool(client, t))
}
