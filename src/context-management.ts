// src/context-management.ts
// 上下文管理 —— token 估算 + 压缩阈值推导。
// 估算用固定密度启发式（参考 deepseek-harness token-meter），
// 但系数取 2 而非 4：pi 以中文对话为主，中文 1 字≈1~2 token，/4 会低估约 4 倍。

import { buildToolResultMessages, type ContentBlock, type Context, type Message } from './llm.js'

/** 固定密度：每 2 字符 ≈ 1 token（折中，兼顾中文对话与英文代码） */
const CHARS_PER_TOKEN = 2
/** 每条消息的 role 字段结构开销 */
const ROLE_OVERHEAD = 4
/** 每个 content block 的 JSON 结构开销 */
const BLOCK_OVERHEAD = 4
/** 默认上下文窗口（未配置时使用，glm-5.2 按 128K 假设） */
export const DEFAULT_CONTEXT_WINDOW = 128_000
/** 安全余量：估算法本身的误差缓冲，避免撞上模型真实上限 */
const SAFETY_MARGIN = 0.15

/** 估算一组 content block 的 token（不含 role 开销） */
export function estimateContentTokens(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool_use':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(JSON.stringify(block.input).length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
    }
  }
  return tokens
}

/** 估算单条消息的 token（含 role 开销） */
export function estimateMessageTokens(message: Message): number {
  if (typeof message.content === 'string') {
    return Math.ceil(message.content.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  return estimateContentTokens(message.content) + ROLE_OVERHEAD
}

/** 估算整个 context 的 token（system prompt + 全部消息） */
export function estimateContextTokens(context: Context): number {
  let tokens = 0
  if (context.systemPrompt) {
    tokens += Math.ceil(context.systemPrompt.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  for (const message of context.messages) {
    tokens += estimateMessageTokens(message)
  }
  return tokens
}

/** 从 context window 推导压缩触发线：contextWindow − maxTokens − 安全余量 */
export function compactTriggerTokens(contextWindow: number, maxTokens: number): number {
  const available = contextWindow - maxTokens
  return Math.floor(available * (1 - SAFETY_MARGIN))
}

/** 压缩后保留的近期内容 token 预算 */
export const KEEP_RECENT_TOKENS = 4000

/**
 * 计算每条消息边界的 tool 配对平衡状态。
 * balance[i] = 处理完前 i 条消息后仍在进行的 tool 调用数；
 * 切点在索引 i 处安全 ⟺ balance[i] === 0（无未完成的 tool 调用跨过切点）。
 */
function toolPairBalance(messages: readonly Message[]): number[] {
  const balance = new Array<number>(messages.length + 1).fill(0)
  let count = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool') {
      count--  // 每个 tool 消息对应一个 tool 结果
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      count += msg.content.filter(b => b.type === 'tool_use').length
    }
    balance[i + 1] = count
  }
  return balance
}

/**
 * 找压缩切点：从尾部往前累加 token 凑够保留预算，再往前退到 tool 配对平衡的位置。
 * 返回 messages[cut..] 为保留的近期内容；cut === 0 表示放弃压缩（无安全切点）。
 */
export function findCompactCut(messages: readonly Message[], keepTokens: number): number {
  const balance = toolPairBalance(messages)
  let cut = messages.length
  let acc = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i])
    cut = i
    if (acc >= keepTokens) break
  }
  while (cut > 0 && balance[cut] !== 0) cut--
  return cut
}

/**
 * 判断摘要是否值得替换旧消息：摘要 token 必须严格小于被压缩内容的 token。
 * 否则压缩不但没省空间，反而更占空间（用 >= 拒绝，与 deepseek 一致）。
 */
export function isSummaryWorthCompacting(summary: string, oldMessages: readonly Message[]): boolean {
  const summaryMessage: Message = { role: 'user', content: summary }
  const shadowedTokens = oldMessages.reduce((total, m) => total + estimateMessageTokens(m), 0)
  return estimateMessageTokens(summaryMessage) < shadowedTokens
}

/**
 * 崩溃恢复（P1-2）：找出所有没有 tool 结果配对的 tool_use，合成 error 结果补齐配对，
 * 保证恢复后 API 不报 400。正常流程不会留悬空（abort 路径会丢弃 tool_calls），
 * 出现悬空即意味着进程在工具执行中途被 kill。修复 = 追加不改写（deepseek-harness 语义）；
 * message 粒度的事件没有 started 标记，无法区分"没开始"与"结果未知"，统一按结果未知处理。
 */
export function repairOpenToolCalls(messages: readonly Message[]): Message[] {
  const open: { id: string; name: string }[] = []
  const answered = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use') open.push({ id: b.id, name: b.name })
      }
    } else if (msg.role === 'tool') {
      answered.add(msg.tool_use_id)
    }
  }
  const unresolved = open.filter(t => !answered.has(t.id))
  if (unresolved.length === 0) return []
  return buildToolResultMessages(unresolved.map(t => ({
    tool_use_id: t.id,
    content: `error: tool "${t.name}" was interrupted before its result was recorded (process may have crashed); the effect is unknown — retry only if the operation is read-only or idempotent`,
  })))
}

/** 检测死循环：最近 N 次工具调用是否完全相同（同样的 name + args） */
export function detectLoop(context: Context, maxRepeat = 3): boolean {
  const toolUses: string[] = []
  for (const msg of context.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const b of msg.content) {
      if (b.type === 'tool_use') toolUses.push(`${b.name}:${JSON.stringify(b.input)}`)
    }
  }
  if (toolUses.length < maxRepeat) return false
  const last = toolUses.slice(-maxRepeat)
  return last.every(t => t === last[0])
}
