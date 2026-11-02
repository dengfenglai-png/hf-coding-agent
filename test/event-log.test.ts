// test/event-log.test.ts
// 测试事件日志：envelope/seq、撕裂尾容错、ignorable 前向兼容、fold 重放、agent 集成。
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RunEventLog, foldEvents, EVENT_LOG_VERSION, type RunEvent } from '../src/event-log.js'
import { runAgent, type AgentTool } from '../src/agent.js'
import type { Context, Message, Model, StreamEvent, StreamFn } from '../src/llm.js'

let dir: string
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  dir = ''
})

async function tmpFile(name: string): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-eventlog-'))
  return path.join(dir, name)
}

const asMsg = (s: string): Message => ({ role: 'user', content: s })

describe('RunEventLog', () => {
  it('create 写 header 行（version + cwd）', async () => {
    const file = await tmpFile('events-1.jsonl')
    await RunEventLog.create(file, '/tmp/proj')
    const first = JSON.parse((await fs.readFile(file, 'utf-8')).split('\n')[0])
    expect(first.type).toBe('header')
    expect(first.version).toBe(EVENT_LOG_VERSION)
    expect(first.cwd).toBe('/tmp/proj')
  })

  it('append seq 单调分配，open 往返读回', async () => {
    const file = await tmpFile('events-1.jsonl')
    const log = await RunEventLog.create(file, '/p')
    const m1 = asMsg('hi')
    const m2: Message = { role: 'assistant', content: 'hello' }
    await log.appendMessage(m1)
    await log.appendMessage(m2)
    await log.appendTurnEnd('end_turn')
    const { events } = await RunEventLog.open(file, '/p')
    expect(events.map(e => e.type)).toEqual(['message', 'message', 'turn_end'])
    expect(events.map(e => e.seq)).toEqual([0, 1, 2])
    expect((events[0] as { data: { message: Message } }).data.message).toEqual(m1)
    expect((events[2] as { data: { reason: string } }).data.reason).toBe('end_turn')
  })

  it('open 不存在的文件：补 header、空事件、可直接续写', async () => {
    const file = await tmpFile('events-x.jsonl')
    const { events, log } = await RunEventLog.open(file, '/p')
    expect(events).toEqual([])
    await log.appendTurnEnd('aborted')
    const raw = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean)
    expect(JSON.parse(raw[0]).type).toBe('header')
    expect(JSON.parse(raw[1]).data.reason).toBe('aborted')
  })

  it('撕裂尾（无结尾换行的半行）跳过，seq 从读回的最大值继续', async () => {
    const file = await tmpFile('events-1.jsonl')
    const log = await RunEventLog.create(file, '/p')
    await log.appendMessage(asMsg('ok'))
    await fs.appendFile(file, '{"type":"message","seq":9,"time":1,"dat')  // 模拟崩溃半行
    const { log: log2, events } = await RunEventLog.open(file, '/p')
    expect(events).toHaveLength(1)
    await log2.appendTurnEnd('end_turn')
    const { events: ev2 } = await RunEventLog.open(file, '/p')
    expect(ev2.at(-1)!.seq).toBe(1)
  })

  it('未知事件无 ignorable 拒读（fail-closed）；带 ignorable 读入且不参与 fold', async () => {
    const file = await tmpFile('events-1.jsonl')
    await RunEventLog.create(file, '/p')
    await fs.appendFile(file, '{"type":"future_tool","seq":0,"time":1,"data":{}}\n')
    await expect(RunEventLog.open(file, '/p')).rejects.toThrow('unknown event type')

    const file2 = await tmpFile('events-2.jsonl')
    await RunEventLog.create(file2, '/p')
    await fs.appendFile(file2, '{"type":"future_thing","seq":0,"time":1,"data":{},"ignorable":true}\n')
    const { events } = await RunEventLog.open(file2, '/p')
    expect(events).toHaveLength(1)
    expect(foldEvents(events)).toEqual([])
  })
})

describe('foldEvents', () => {
  const ev = (seq: number, e: Omit<RunEvent, 'seq' | 'time'>): RunEvent => ({ seq, time: 0, ...e } as RunEvent)

  it('message 依序重放，turn_end 忽略', () => {
    const events = [
      ev(0, { type: 'message', data: { message: asMsg('a') } }),
      ev(1, { type: 'turn_end', data: { reason: 'end_turn' } }),
      ev(2, { type: 'message', data: { message: asMsg('b') } }),
    ]
    expect(foldEvents(events)).toEqual([asMsg('a'), asMsg('b')])
  })

  it('compaction 截断：保留 keptFromIndex 之后的消息，摘要置于头部', () => {
    const events = [
      ev(0, { type: 'message', data: { message: asMsg('old1') } }),
      ev(1, { type: 'message', data: { message: asMsg('old2') } }),
      ev(2, { type: 'message', data: { message: asMsg('kept1') } }),
      ev(3, { type: 'message', data: { message: asMsg('kept2') } }),
      ev(4, { type: 'compaction', data: { summary: asMsg('S'), keptFromIndex: 2 } }),
    ]
    expect(foldEvents(events)).toEqual([asMsg('S'), asMsg('kept1'), asMsg('kept2')])
  })

  it('多次 compaction：在后一次的结果上继续截断', () => {
    const events = [
      ev(0, { type: 'message', data: { message: asMsg('a') } }),
      ev(1, { type: 'message', data: { message: asMsg('b') } }),
      ev(2, { type: 'compaction', data: { summary: asMsg('S1'), keptFromIndex: 1 } }),
      ev(3, { type: 'message', data: { message: asMsg('c') } }),
      ev(4, { type: 'compaction', data: { summary: asMsg('S2'), keptFromIndex: 1 } }),
    ]
    // 第一次 fold：[S1, b]；追加 c → [S1, b, c]；第二次 keptFromIndex=1 → [S2, b, c]
    expect(foldEvents(events)).toEqual([asMsg('S2'), asMsg('b'), asMsg('c')])
  })
})

describe('agent ↔ 事件日志', () => {
  const model: Model = { apiKey: 'k', model: 'm' }
  const tool: AgentTool = {
    name: 'echo', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => 'echo-ok',
  }

  /** 把 agent 事件流按 cli 的方式写进事件日志（cli.ts onPrompt 的镜像；初始消息视为已落盘） */
  async function drive(file: string, context: Context, tools: AgentTool[], streamFn: StreamFn, m: Model = model): Promise<void> {
    const log = await RunEventLog.create(file, '/p')
    for (const msg of context.messages) await log.appendMessage(msg)
    for await (const ev of runAgent(m, context, tools, undefined, undefined, streamFn)) {
      if (ev.type === 'message_appended') await log.appendMessage(ev.message)
      else if (ev.type === 'compaction') await log.appendCompaction(ev.summary, ev.keptFromIndex)
      else if (ev.type === 'turn_end') await log.appendTurnEnd(ev.stopReason)
    }
  }

  it('工具轮次：message_appended 逐条发出，事件日志 fold 与 context 完全一致', async () => {
    const file = await tmpFile('roundtrip.jsonl')
    const context: Context = { systemPrompt: 's', messages: [asMsg('hi')] }
    const script: StreamEvent[][] = [
      [{ type: 'tool_call', id: '1', name: 'echo', args: {} }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text_delta', delta: 'final' }, { type: 'done', stopReason: 'end_turn' }],
    ]
    let turn = 0
    const streamFn: StreamFn = async function* () { yield* script[turn++]! }
    await drive(file, context, [tool], streamFn)

    const { events } = await RunEventLog.open(file, '/p')
    expect(events.at(-1)!.type).toBe('turn_end')
    expect(foldEvents(events)).toEqual(context.messages)  // user + assistant(tool) + tool result + assistant(final)
  })

  it('compaction 触发时发 compaction 事件，fold 复现 [summary, ...kept] 顺序', async () => {
    const file = await tmpFile('compaction.jsonl')
    const context: Context = { systemPrompt: '', messages: [asMsg('x'.repeat(9000)), asMsg('y'.repeat(9000)), asMsg('tail')] }
    // 摘要请求（conversationText 以 "user: " 开头）返回短摘要；正式请求返回最终回答
    const streamFn: StreamFn = async function* (_model, ctx) {
      const first = ctx.messages[0]
      const isSummaryCall = typeof first?.content === 'string' && first.content.startsWith('user: ')
      yield { type: 'text_delta', delta: isSummaryCall ? 'sum' : 'final' }
      yield { type: 'done', stopReason: 'end_turn' }
    }
    const smallWindow: Model = { apiKey: 'k', model: 'm', contextWindow: 4600, maxTokens: 0 }
    await drive(file, context, [], streamFn, smallWindow)
    expect(context.messages[0].content).toContain('[context summary]')  // 压缩确实发生
    const { events } = await RunEventLog.open(file, '/p')
    expect(foldEvents(events)).toEqual(context.messages)
  })
})
