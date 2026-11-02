// test/context-management.test.ts
// 测试 token 估算函数（固定密度启发式）。
import { describe, it, expect } from 'vitest'
import {
  estimateContentTokens,
  estimateMessageTokens,
  estimateContextTokens,
  compactTriggerTokens,
  findCompactCut,
  isSummaryWorthCompacting,
  detectLoop,
  repairOpenToolCalls,
} from '../src/context-management.js'
import type { ContentBlock, Context, Message } from '../src/llm.js'

describe('estimateMessageTokens', () => {
  it('字符串 content：5 字符', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'hello' })).toBe(7) // ceil(5/2)=3 + role 4
  })

  it('中文 content：2 字', () => {
    expect(estimateMessageTokens({ role: 'user', content: '你好' })).toBe(5) // ceil(2/2)=1 + role 4
  })

  it('空 content：只 role 开销', () => {
    expect(estimateMessageTokens({ role: 'user', content: '' })).toBe(4)
  })
})

describe('estimateContentTokens', () => {
  it('text block', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    expect(estimateContentTokens(blocks)).toBe(7) // ceil(5/2)=3 + block 4
  })

  it('tool_use block：name + input JSON', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 'c1', name: 'read', input: { a: 'b' } }]
    // name 'read'=4 → ceil(4/2)=2; input '{"a":"b"}'=9 → ceil(9/2)=5; + block 4 = 11
    expect(estimateContentTokens(blocks)).toBe(11)
  })
})

describe('estimateContextTokens', () => {
  it('system prompt + 1 条消息', () => {
    const context: Context = { systemPrompt: 'hi', messages: [{ role: 'user', content: 'hello' }] }
    // system 'hi'=2 → ceil(2/2)=1 + role 4 = 5; message = 7; 合计 12
    expect(estimateContextTokens(context)).toBe(12)
  })
})

describe('compactTriggerTokens', () => {
  it('从 context window 推导触发线', () => {
    // 128000 - 4096 = 123904; × 0.85 = 105318.4 → floor = 105318
    expect(compactTriggerTokens(128_000, 4096)).toBe(105318)
  })
})

describe('findCompactCut', () => {
  it('无 tool：按 token 预算从尾部保留', () => {
    const messages: Message[] = [
      { role: 'user', content: 'aaaa' }, // ceil(4/2)+4 = 6
      { role: 'user', content: 'bbbb' }, // 6
    ]
    expect(findCompactCut(messages, 6)).toBe(1) // 保留最后 1 条
  })

  it('切点落在 tool 配对中间时往前退', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },                                                           // 5
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] }, // 11
      { role: 'tool', tool_use_id: 'c1', content: 'ok' },                                        // 5
      { role: 'user', content: 'bye' },                                                          // 6
    ]
    // keepTokens=10 → 尾部累加 bye(6)+tool(5)=11≥10，候选 cut=2（balance=1），往前退到 cut=1（balance=0）
    expect(findCompactCut(messages, 10)).toBe(1)
  })
})

describe('isSummaryWorthCompacting', () => {
  it('摘要比原文小 → 值得压缩', () => {
    const oldMessages: Message[] = [
      { role: 'user', content: '这是一段很长很长的旧消息内容' }, // 14 字 → 11
    ]
    expect(isSummaryWorthCompacting('短摘要', oldMessages)).toBe(true) // 3 字 → 6 < 11
  })

  it('摘要不比原文小 → 不值得压缩', () => {
    const oldMessages: Message[] = [
      { role: 'user', content: 'hi' }, // 2 字 → 5
    ]
    expect(isSummaryWorthCompacting('这是一段很长的摘要', oldMessages)).toBe(false) // 9 字 → 9 >= 5
  })
})

describe('detectLoop', () => {
  it('连续 3 次相同工具调用 → true', () => {
    const context: Context = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x' } }] },
        { role: 'tool', tool_use_id: 'a', content: 'ok' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'x' } }] },
        { role: 'tool', tool_use_id: 'b', content: 'ok' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read_file', input: { path: 'x' } }] },
        { role: 'tool', tool_use_id: 'c', content: 'ok' },
      ],
    }
    expect(detectLoop(context)).toBe(true)
  })

  it('不同工具调用 → false', () => {
    const context: Context = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x' } }] },
        { role: 'tool', tool_use_id: 'a', content: 'ok' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'write_file', input: { path: 'y' } }] },
        { role: 'tool', tool_use_id: 'b', content: 'ok' },
      ],
    }
    expect(detectLoop(context)).toBe(false)
  })

  it('少于 3 次 → false', () => {
    const context: Context = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x' } }] },
        { role: 'tool', tool_use_id: 'a', content: 'ok' },
      ],
    }
    expect(detectLoop(context)).toBe(false)
  })
})

describe('repairOpenToolCalls（P1-2 崩溃恢复）', () => {
  const dangling: Message = {
    role: 'assistant',
    content: [
      { type: 'text', text: '我来读取' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ] as ContentBlock[],
  }

  it('无悬空调用 → 空数组（正常结束 / abort 丢弃后的对话不需要修复）', () => {
    expect(repairOpenToolCalls([])).toEqual([])
    expect(repairOpenToolCalls([{ role: 'user', content: 'hi' }])).toEqual([])
    expect(repairOpenToolCalls([
      dangling,
      { role: 'tool', tool_use_id: 'call_1', content: 'content' },
    ])).toEqual([])
  })

  it('悬空 tool_use → 合成 error 结果，配对完整（API 不再 400）', () => {
    const repair = repairOpenToolCalls([dangling])
    expect(repair).toHaveLength(1)
    expect(repair[0]).toMatchObject({ role: 'tool', tool_use_id: 'call_1' })
    expect((repair[0] as { content: string }).content).toContain('interrupted')
  })

  it('部分配对：只为未回答的调用补结果', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
        { type: 'tool_use', id: 'b', name: 'read_file', input: {} },
      ] as ContentBlock[] },
      { role: 'tool', tool_use_id: 'a', content: 'ok' },  // b 悬空（kill 在两个结果之间）
    ]
    const repair = repairOpenToolCalls(messages)
    expect(repair).toHaveLength(1)
    expect(repair[0]).toMatchObject({ role: 'tool', tool_use_id: 'b' })
  })

  it('多个悬空调用各补一条，且消息名出现在错误文本里', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'run_bash', input: {} },
        { type: 'tool_use', id: 'b', name: 'glob', input: {} },
      ] as ContentBlock[] },
    ]
    const repair = repairOpenToolCalls(messages)
    expect(repair).toHaveLength(2)
    expect(repair.map(m => (m as { tool_use_id: string }).tool_use_id)).toEqual(['a', 'b'])
    expect((repair[0] as { content: string }).content).toContain('run_bash')
    expect((repair[1] as { content: string }).content).toContain('glob')
  })
})
