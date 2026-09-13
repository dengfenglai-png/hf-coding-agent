// test/anthropic.test.ts
// 测试 Anthropic 消息格式转换 + SSE 解析。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { contextToAnthropicMessages, anthropicStream } from '../src/anthropic.js'
import type { Model } from '../src/llm.js'

// mock Anthropic SSE（event + data 两行格式）
function mockAnthropicSSE(events: { event: string; data: object }[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(ctrl) {
      for (const e of events) {
        ctrl.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`))
      }
      ctrl.close()
    },
  })
}

const model: Model = { apiKey: 'test-key', model: 'claude-sonnet' }

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })

describe('contextToAnthropicMessages', () => {
  it('user 字符串消息原样转换', () => {
    const result = contextToAnthropicMessages({
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('assistant tool_use 转 tool_use block', () => {
    const result = contextToAnthropicMessages({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
        ],
      }],
    })
    expect(result[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      ],
    })
  })

  it('tool 消息转 user + tool_result block', () => {
    const result = contextToAnthropicMessages({
      messages: [{ role: 'tool', tool_use_id: 't1', content: 'ok' }],
    })
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
  })

  it('连续 tool 消息打包成一个 user 消息', () => {
    const result = contextToAnthropicMessages({
      messages: [
        { role: 'tool', tool_use_id: 't1', content: 'ok1' },
        { role: 'tool', tool_use_id: 't2', content: 'ok2' },
      ],
    })
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok1' },
          { type: 'tool_result', tool_use_id: 't2', content: 'ok2' },
        ],
      },
    ])
  })
})

describe('anthropicStream', () => {
  it('解析文本响应', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: mockAnthropicSSE([
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of anthropicStream(model, { messages: [] })) events.push(e)

    expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('Hello')
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('解析 tool_use 响应（input 一次性给全）', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: mockAnthropicSSE([
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } } } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of anthropicStream(model, { messages: [] })) events.push(e)

    const tc = events.find(e => e.type === 'tool_call') as { id: string; name: string; args: unknown }
    expect(tc).toEqual({ type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'a.txt' } })
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' })
  })
})
