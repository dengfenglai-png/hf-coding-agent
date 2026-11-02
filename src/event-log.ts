// src/event-log.ts
// RunEvent 事件日志 —— append-only 的 run 事实记录（P1）。
// 一个 session 一个文件，首行 header，之后每行一个事件 {type, seq, time, data}。
// 日志只追加不改写：崩溃恢复 = 追加合成事件（P1-2），重放 = foldEvents（P1-3）。
// 设计参照 pi（版本化 header / compaction 截断点）与 deepseek-harness（信封 + ignorable 前向兼容）。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Message } from './llm.js'

/** 事件日志格式版本（header 行携带） */
export const EVENT_LOG_VERSION = 1

/** 首行 header：标识文件身份与格式版本 */
export interface RunEventHeader {
  type: 'header'
  version: number
  time: number
  cwd: string
}

type TurnEndReason = 'end_turn' | 'max_tokens' | 'aborted' | 'error' | 'stopped' | 'interrupted'

/** 事件信封：seq 追加侧单调分配；ignorable = 老版本读到这里可安全跳过（前向兼容） */
interface EventEnvelope {
  seq: number
  time: number
  ignorable?: true
}

export type RunEvent =
  | (EventEnvelope & { type: 'message'; data: { message: Message } })
  | (EventEnvelope & { type: 'turn_end'; data: { reason: TurnEndReason } })
  // summary 放在事件里而非单独 message 事件：保证 fold 顺序与实际 context 一致（[summary, ...kept]）
  | (EventEnvelope & { type: 'compaction'; data: { summary: Message; keptFromIndex: number } })
  | (EventEnvelope & { type: string; data?: unknown })

/** 未知 type 且无 ignorable 标记 → 拒读（fail-closed，与 deepseek-harness 一致） */
function assertKnownEvent(ev: RunEvent): RunEvent {
  if (ev.type !== 'message' && ev.type !== 'turn_end' && ev.type !== 'compaction' && !ev.ignorable) {
    throw new Error(`unknown event type: ${ev.type}`)
  }
  return ev
}

/**
 * 把事件流重放出 Message[]（context.messages 的投影）。
 * message 依序追加；compaction 是截断点：保留 keptFromIndex 之后的旧消息、摘要置于头部。
 */
export function foldEvents(events: RunEvent[]): Message[] {
  const entries: { message: Message }[] = []
  for (const ev of events) {
    if (ev.type === 'message') {
      entries.push({ message: (ev.data as { message: Message }).message })
    } else if (ev.type === 'compaction') {
      // 宽 type: string 变体会干扰联合窄化，这里显式收窄
      const { summary, keptFromIndex } = ev.data as { summary: Message; keptFromIndex: number }
      entries.splice(0, entries.length, { message: summary }, ...entries.slice(keptFromIndex))
    }
    // turn_end 不进 context
  }
  return entries.map(e => e.message)
}

function headerLine(cwd: string): string {
  const header: RunEventHeader = { type: 'header', version: EVENT_LOG_VERSION, time: Date.now(), cwd }
  return JSON.stringify(header) + '\n'
}

export class RunEventLog {
  private seq = 0
  private warned = false

  private constructor(private readonly file: string) {}

  /** 新建日志文件（写入 header 行）；文件已存在会追加，调用方保证文件名唯一 */
  static async create(file: string, cwd: string): Promise<RunEventLog> {
    await fs.mkdir(path.dirname(file) || '.', { recursive: true })
    await fs.appendFile(file, headerLine(cwd), 'utf-8')
    return new RunEventLog(file)
  }

  /** 打开已有日志：读回事件并恢复 seq 计数；文件不存在则补 header（老会话首次双写） */
  static async open(file: string, cwd: string): Promise<{ log: RunEventLog; events: RunEvent[] }> {
    const log = new RunEventLog(file)
    let events: RunEvent[] = []
    let existed = true
    try {
      const data = await fs.readFile(file, 'utf-8')
      if (!data.endsWith('\n')) {
        // 物理修复：截掉撕裂尾再续写，否则下一次 append 会拼进坏行一起报废（deepseek truncateTornTail）
        await fs.truncate(file, data.lastIndexOf('\n') + 1)
      }
      const lines = data.split('\n')
      lines.pop()  // 文件以 \n 结尾时末段为空串；无结尾换行时末段是撕裂尾，同样丢弃
      events = lines.flatMap(line => {
        if (!line) return []
        let ev: RunEvent
        try { ev = JSON.parse(line) as RunEvent } catch { return [] }  // 损坏行跳过（进程崩溃可能写出半行）
        if (ev.type === 'header') return []  // 首行 header 不进事件流
        return [assertKnownEvent(ev)]
      })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      existed = false
    }
    if (!existed) await RunEventLog.create(file, cwd)
    log.seq = events.length > 0 ? events[events.length - 1]!.seq + 1 : 0
    return { log, events }
  }

  /** 追加事件。写失败只警告一次——双写期事件日志不得影响主路径 */
  private async append(ev: { type: string; data: unknown }): Promise<void> {
    const full = { seq: this.seq++, time: Date.now(), ...ev }
    try {
      await fs.appendFile(this.file, JSON.stringify(full) + '\n', 'utf-8')
    } catch (e) {
      if (!this.warned) {
        this.warned = true
        console.error(`[event-log] 写入失败（后续忽略）: ${(e as Error).message}`)
      }
    }
  }

  appendMessage(message: Message): Promise<void> {
    return this.append({ type: 'message', data: { message } })
  }

  appendTurnEnd(reason: TurnEndReason): Promise<void> {
    return this.append({ type: 'turn_end', data: { reason } })
  }

  appendCompaction(summary: Message, keptFromIndex: number): Promise<void> {
    return this.append({ type: 'compaction', data: { summary, keptFromIndex } })
  }
}
