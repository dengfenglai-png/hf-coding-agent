// test/agent.test.ts
// 测试 agent loop 的核心路径：纯文本回复、tool_call 执行后把结果放回到 Context、未知 tool 报错。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent, Model, Context } from '../src/llm.js'

const { mockStreamFn } = vi.hoisted(() => ({
  mockStreamFn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', stopReason: 'end_turn' }
  }),
}))

vi.mock('../src/llm.js', () => ({
  stream: mockStreamFn,
  buildAssistantMessage: (text: string, toolCalls: { id: string; name: string; args: unknown }[]) => {
    const content: unknown[] = []
    if (text) content.push({ type: 'text', text })
    for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
    return { role: 'assistant', content }
  },
  buildToolResultMessages: (results: { tool_use_id: string; content: string }[]) =>
    results.map((r) => ({ role: 'tool', tool_use_id: r.tool_use_id, content: r.content })),
}))

import { runAgent, groupToolCalls, withTimeout, type AgentTool, type StreamFn } from '../src/agent.js'

beforeEach(() => { mockStreamFn.mockClear() })

const model: Model = { apiKey: 'k', model: 'test' }

describe('runAgent', () => {
  it('纯文本回复：一轮就结束', async () => {
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', delta: 'Hello' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const ctx: Context = { messages: [] }
    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, ctx, [] as AgentTool[])) events.push(e)

    expect(events.find(e => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', delta: 'Hello' })
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })
    expect(ctx.messages).toHaveLength(1)
  })

  it('tool_call → 执行 → 把结果放回到 Context → 下一轮纯文本', async () => {
    const echoTool: AgentTool = {
      name: 'echo',
      description: 'echo back',
      parameters: { type: 'object', properties: {} },
      execute: async (args: { text: string }) => `ECHO: ${args.text}`,
    }

    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'echo', args: { text: 'hi' } }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'Done' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const ctx: Context = { messages: [] }
    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, ctx, [echoTool])) events.push(e)

    // 每条消息落 context 时发 message_appended（P1 事件日志）
    expect(events.map(e => e.type)).toEqual([
      'tool_call', 'message_appended', 'tool_result', 'message_appended', 'assistant_text', 'message_appended', 'turn_end',
    ])
    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('ECHO: hi')
    // 3 条消息：assistant(tool_use) + tool + assistant(text)
    expect(ctx.messages).toHaveLength(3)
  })

  it('未知 tool 名 → 把报错结果放回到 Context', async () => {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'nope', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'ok' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [] as AgentTool[])) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toContain('not found')
  })
})

describe('groupToolCalls', () => {
  const readTool: AgentTool = { name: 'read', description: '', parameters: {}, execute: async () => '' }
  const writeTool: AgentTool = { name: 'write', description: '', parameters: {}, execute: async () => '', exclusive: true }
  const toolMap = new Map([['read', readTool], ['write', writeTool]])

  it('连续非独占 → 一个并行组', () => {
    const calls = [
      { id: '1', name: 'read', args: {} },
      { id: '2', name: 'read', args: {} },
    ]
    expect(groupToolCalls(toolMap, calls).map(g => g.map(c => c.name))).toEqual([['read', 'read']])
  })

  it('独占工具单独成组', () => {
    const calls = [
      { id: '1', name: 'read', args: {} },
      { id: '2', name: 'write', args: {} },
      { id: '3', name: 'read', args: {} },
    ]
    expect(groupToolCalls(toolMap, calls).map(g => g.map(c => c.name))).toEqual([['read'], ['write'], ['read']])
  })

  it('未知工具视为非独占', () => {
    const calls = [{ id: '1', name: 'unknown', args: {} }]
    expect(groupToolCalls(toolMap, calls).map(g => g.map(c => c.name))).toEqual([['unknown']])
  })
})

describe('runAgent 审批', () => {
  function makeDangerTool(execute: () => Promise<string>): AgentTool {
    return {
      name: 'danger',
      description: '',
      parameters: { type: 'object', properties: {} },
      needsApproval: () => true,
      execute,
    }
  }

  function mockOneToolCall(): void {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'danger', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })
  }

  it('approve 通过 → 执行工具', async () => {
    const execute = vi.fn(async () => 'executed')
    mockOneToolCall()
    const approve = vi.fn(async () => true)

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [makeDangerTool(execute)], undefined, approve)) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('executed')
    expect(approve).toHaveBeenCalledWith('danger', {})
  })

  it('approve 拒绝 → 不执行', async () => {
    const execute = vi.fn(async () => 'executed')
    mockOneToolCall()
    const approve = vi.fn(async () => false)

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [makeDangerTool(execute)], undefined, approve)) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('error: denied by user')
    expect(execute).not.toHaveBeenCalled()
  })

  it('无审批回调 → fail-closed 拒绝', async () => {
    const execute = vi.fn(async () => 'executed')
    mockOneToolCall()

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [makeDangerTool(execute)])) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toContain('requires approval')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('runAgent StreamFn 注入', () => {
  it('使用传入的 streamFn 而非默认', async () => {
    const customStreamFn = vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', delta: 'custom' }
      yield { type: 'done', stopReason: 'end_turn' }
    }) as StreamFn

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [], undefined, undefined, customStreamFn)) events.push(e)

    expect(customStreamFn).toHaveBeenCalledTimes(1)
    expect(events.find(e => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', delta: 'custom' })
  })
})

describe('runAgent shouldStopAfterTurn', () => {
  const echoTool: AgentTool = {
    name: 'echo',
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  }

  it('回调返回 true → 停止并 yield stopped', async () => {
    // 每轮都产生 tool_call（永不自然结束），靠 shouldStopAfterTurn 停下
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'tool_call', id: 't1', name: 'echo', args: {} }
      yield { type: 'done', stopReason: 'tool_use' }
    })

    let calls = 0
    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [echoTool], undefined, undefined, mockStreamFn as unknown as StreamFn, () => ++calls >= 1)) {
      events.push(e)
    }

    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'stopped' })
    expect(calls).toBe(1)
  })

  it('回调返回 false → 继续直到模型自然停', async () => {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'echo', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'Done' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [echoTool], undefined, undefined, mockStreamFn as unknown as StreamFn, () => false)) {
      events.push(e)
    }

    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })
  })
})

describe('withTimeout', () => {
  it('超时 → reject', async () => {
    await expect(withTimeout(new Promise(r => setTimeout(r, 50)), 10)).rejects.toThrow('timed out')
  })

  it('未超时 → resolve', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok')
  })
})

describe('runAgent 工具超时', () => {
  it('超时工具 → 返回 error', async () => {
    const slowTool: AgentTool = {
      name: 'slow',
      description: '',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 10,
      execute: async () => { await new Promise(r => setTimeout(r, 100)); return 'done' },
    }
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'slow', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [slowTool])) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toContain('timed out')
  })
})

describe('runAgent beforeToolCall', () => {
  const echoTool: AgentTool = {
    name: 'echo',
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'executed',
  }

  function mockEchoCall(): void {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'echo', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })
  }

  it('block: true → 阻止执行', async () => {
    const execute = vi.fn(async () => 'executed')
    const tool = { ...echoTool, execute }
    mockEchoCall()
    const beforeToolCall = vi.fn(async () => ({ block: true, reason: 'blocked by policy' }))

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [tool], undefined, undefined, mockStreamFn as unknown as StreamFn, undefined, beforeToolCall)) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('blocked by policy')
    expect(execute).not.toHaveBeenCalled()
  })

  it('返回 undefined → 正常执行', async () => {
    const execute = vi.fn(async () => 'executed')
    const tool = { ...echoTool, execute }
    mockEchoCall()
    const beforeToolCall = vi.fn(async () => undefined)

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [tool], undefined, undefined, mockStreamFn as unknown as StreamFn, undefined, beforeToolCall)) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('executed')
    expect(execute).toHaveBeenCalled()
  })
})

describe('runAgent afterToolCall', () => {
  function mockEchoCall(): void {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'echo', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })
  }

  it('覆盖结果', async () => {
    const echoTool: AgentTool = {
      name: 'echo', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => 'secret sk-123456',
    }
    mockEchoCall()
    const afterToolCall = vi.fn(async () => ({ result: 'redacted' }))

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [echoTool], undefined, undefined, mockStreamFn as unknown as StreamFn, undefined, undefined, afterToolCall)) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('redacted')
  })

  it('返回 undefined → 保持原结果', async () => {
    const echoTool: AgentTool = {
      name: 'echo', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => 'original',
    }
    mockEchoCall()
    const afterToolCall = vi.fn(async () => undefined)

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [echoTool], undefined, undefined, mockStreamFn as unknown as StreamFn, undefined, undefined, afterToolCall)) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('original')
  })
})
