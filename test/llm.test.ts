// test/llm.test.ts
// 测试 llm 模块的核心功能：SSE 解析、消息构建、格式转换。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stream, buildAssistantMessage, buildToolResultMessages, contextToOpenAIMessages, isRetryableStatus, isNonRetryableError, retryableFetch, type Model } from '../src/llm.js'

// mock fetch，用 JSON.stringify 构造 SSE 数据（避免手写转义）
function mockSSE(chunks: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
      ctrl.close()
    },
  })
}

const baseModel: Model = { apiKey: 'test-key', model: 'glm-5.2' }

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })

describe('stream', () => {
  it('解析纯文本响应', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: mockSSE([
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of stream(baseModel, { messages: [] })) events.push(e)

    expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('Hello world')
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('解析 tool_use 响应', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: mockSSE([
        { choices: [{ delta: { content: 'Reading file' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of stream(baseModel, { messages: [] })) events.push(e)

    const tc = events.find(e => e.type === 'tool_call') as { id: string; name: string; args: unknown }
    expect(tc).toEqual({ type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: 'a.txt' } })
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' })
  })
})

describe('buildAssistantMessage', () => {
  it('把 text + tool_calls 打包成 assistant message', () => {
    const msg = buildAssistantMessage('hi', [{ id: 't1', name: 'read_file', args: { path: 'a' } }])
    expect(msg.role).toBe('assistant')
    expect(msg.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
    ])
  })
})

describe('buildToolResultMessages', () => {
  it('把 tool 执行结果打包成 tool 消息数组', () => {
    const msgs = buildToolResultMessages([{ tool_use_id: 't1', content: 'hello' }])
    expect(msgs).toEqual([{ role: 'tool', tool_use_id: 't1', content: 'hello' }])
  })
})

describe('contextToOpenAIMessages', () => {
  it('纯文本 user message 原样转换', () => {
    const result = contextToOpenAIMessages({ messages: [{ role: 'user', content: 'hello' }] })
    expect(result).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('system prompt 转成 system message', () => {
    const result = contextToOpenAIMessages({ systemPrompt: 'be helpful', messages: [] })
    expect(result[0]).toEqual({ role: 'system', content: 'be helpful' })
  })

  it('assistant + tool_use 转成 tool_calls', () => {
    const result = contextToOpenAIMessages({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
        ],
      }],
    })
    expect(result[0]).toEqual({
      role: 'assistant', content: 'reading', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      ],
    })
  })

  it('tool 消息转成 role:tool', () => {
    const result = contextToOpenAIMessages({
      messages: [{ role: 'tool', tool_use_id: 't1', content: 'file content' }],
    })
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'file content' })
  })

  it('空 assistant 文本时 content 为 null', () => {
    const result = contextToOpenAIMessages({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] }],
    })
    expect((result[0] as { content: unknown }).content).toBeNull()
  })

  it('无文本无 tool_calls 的 assistant 用空串占位（避免 API 400）', () => {
    // buildAssistantMessage('', []) 产出 content: [] —— 既无文本也无 tool_use
    const result = contextToOpenAIMessages({
      messages: [{ role: 'assistant', content: [] }],
    })
    const msg = result[0] as { content: unknown; tool_calls?: unknown }
    // content 必须非 null（空串），且不带 tool_calls —— 满足 OpenAI "content or tool_calls must be set"
    expect(msg.content).toBe('')
    expect(msg.tool_calls).toBeUndefined()
  })
})

describe('isRetryableStatus', () => {
  it('429 / 5xx → true', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
  })

  it('200 / 400 / 401 → false', () => {
    expect(isRetryableStatus(200)).toBe(false)
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
  })
})

describe('isNonRetryableError', () => {
  it('配额/账单消息 → true', () => {
    expect(isNonRetryableError('insufficient_quota')).toBe(true)
    expect(isNonRetryableError('quota exceeded')).toBe(true)
    expect(isNonRetryableError('billing error')).toBe(true)
    expect(isNonRetryableError('余额不足或无可用资源包,请充值。')).toBe(true)  // 智谱 1113
  })

  it('限流/其他 → false', () => {
    expect(isNonRetryableError('rate limit')).toBe(false)
    expect(isNonRetryableError('internal error')).toBe(false)
  })
})

describe('retryableFetch', () => {
  it('网络错误 → 重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await retryableFetch('http://x', {}, { maxRetries: 3, baseDelayMs: 1 })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('429 限流 → 重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limit', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await retryableFetch('http://x', {}, { maxRetries: 3, baseDelayMs: 1 })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('配额错误（429）→ 不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('insufficient_quota', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await retryableFetch('http://x', {}, { maxRetries: 3, baseDelayMs: 1 })
    expect(response.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('400 → 不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await retryableFetch('http://x', {}, { maxRetries: 3, baseDelayMs: 1 })
    expect(response.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
