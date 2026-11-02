// src/agent.ts
// Agent Loop —— 整个项目的灵魂：一个 while 循环。
//
// LLM 流式回复 → 有 tool_call 就执行 → 结果放回到 Context → 继续流式
// 直到模型不再调工具（end_turn / max_tokens）或被中断（aborted / error）。
//
// 直接 import stream 而非依赖注入——让学习者一眼看到"这是 LLM 交互点"。
// pi 用 StreamFn 参数注入支持替换后端，教学版省略。

import { stream, buildAssistantMessage, buildToolResultMessages, type Model, type Context, type Message, type ToolDef, type StreamEvent } from './llm.js'
import { compactTriggerTokens, DEFAULT_CONTEXT_WINDOW, estimateContextTokens, findCompactCut, isSummaryWorthCompacting, KEEP_RECENT_TOKENS } from './context-management.js'
import { validateArgs } from './tools.js'

/** LLM 流式调用函数：agent 对 LLM 后端的依赖接口。失败不 throw，编码进事件流（error/aborted）。 */
export type StreamFn = (
  model: Model,
  context: Context,
  opts?: { tools?: ToolDef[]; signal?: AbortSignal },
) => AsyncGenerator<StreamEvent>

/** 工具定义：name + 描述 + JSON Schema 参数 + execute 函数 */
export type AgentTool = {
  name: string
  description: string
  parameters: object  // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>
  exclusive?: boolean // 独占：不能与其他工具并行（如写文件、执行命令）
  needsApproval?: (args: unknown) => boolean // 返回 true 则该调用需用户审批（如危险命令）
  timeoutMs?: number  // 执行超时（毫秒），不设则不超时
}

/** agent 对外的事件流，供 UI 消费 */
export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  // 事件日志（P1）：消息落 context 的瞬间通知，持久化层据此按事件粒度落盘
  | { type: 'message_appended'; message: Message }
  | { type: 'compaction'; summary: Message; keptFromIndex: number }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' | 'stopped' }

/** shouldStopAfterTurn 回调：每轮后判断是否停止，返回 true 则结束循环（限制步数 / 检测死循环） */
export type ShouldStopAfterTurnFn = (context: Context) => boolean | Promise<boolean>

/**
 * 对话压缩：当消息过多时，让 LLM 总结旧消息，用摘要替换。
 * 教的是"context 有上限，满了要压缩"——agent 自管理上下文的核心能力。
 * pi 的实现 970 行含 token 估算/cut point 边界/split turn 等，教学版极简为消息条数近似。
 * 返回压缩信息供事件日志记录（keptFromIndex 是重放截断点）；未压缩返回 undefined。
 */
async function compactContext(
  model: Model,
  context: Context,
  streamFn: StreamFn,
  signal?: AbortSignal,
): Promise<{ summary: Message; keptFromIndex: number } | undefined> {
  if (signal?.aborted) return  // abort 时不压缩——避免空摘要损坏 context
  const trigger = compactTriggerTokens(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW, model.maxTokens ?? 0)
  if (estimateContextTokens(context) < trigger) return

  const cut = findCompactCut(context.messages, KEEP_RECENT_TOKENS)
  if (cut <= 0) return  // 无安全切点（tool 配对始终未平衡），放弃压缩

  const oldMessages = context.messages.slice(0, cut)
  const recentMessages = context.messages.slice(cut)

  // 把旧消息序列化成纯文本让 LLM 总结
  const conversationText = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  // 用一轮非流式调用让 LLM 总结
  const summaryContext: Context = {
    systemPrompt: '请将以下对话总结为简洁的上下文摘要，保留关键决策、已做的工作和待办事项。',
    messages: [{ role: 'user', content: conversationText }],
  }

  let summary = ''
  let failed = false
  for await (const ev of streamFn(model, summaryContext, { signal })) {
    if (ev.type === 'text_delta') summary += ev.delta
    else if (ev.type === 'error' || ev.type === 'done' && ev.stopReason === 'aborted') { failed = true; break }
  }

  // 压缩失败时不替换 context——保留原始消息比空摘要更安全
  if (failed || !summary) return

  // 摘要不比原文小就不压缩——压缩必须净省 token（否则保留原文）
  const summaryText = `[context summary]\n${summary}`
  if (!isSummaryWorthCompacting(summaryText, oldMessages)) return

  // 用摘要消息替换旧消息，保留近期消息
  const summaryMessage: Message = { role: 'user', content: summaryText }
  context.messages = [summaryMessage, ...recentMessages]
  return { summary: summaryMessage, keptFromIndex: cut }
}

/** 一次工具调用（来自 LLM 的 tool_call delta） */
type ToolCall = { id: string; name: string; args: unknown }

/** 工具执行结果（保留 id/name 便于按顺序 yield） */
interface ToolCallResult {
  id: string
  name: string
  result: string
}

/** 审批回调：询问用户是否允许执行该工具调用，返回 true 允许 / false 拒绝 */
type ApproveFn = (name: string, args: unknown) => Promise<boolean>

/** beforeToolCall 回调的返回：block 为 true 阻止执行，reason 成为错误结果 */
export type BeforeToolCallResult = { block?: boolean; reason?: string }

/** beforeToolCall 回调：工具执行前拦截（可阻止任意工具） */
export type BeforeToolCallFn = (name: string, args: unknown) => Promise<BeforeToolCallResult | undefined>

/** afterToolCall 回调的返回：result 覆盖工具结果文本 */
export type AfterToolCallResult = { result?: string }

/** afterToolCall 回调：工具执行后修改结果（如脱敏） */
export type AfterToolCallFn = (name: string, args: unknown, result: string) => Promise<AfterToolCallResult | undefined>

/** 组内并发的工具调用上限（对应 deepseek 的 maxParallelToolCalls） */
const MAX_PARALLEL = 4

/** 为每条落 context 的消息发 message_appended 事件（持久化层据此写事件日志） */
async function* emitAppended(messages: readonly Message[]): AsyncGenerator<AgentEvent> {
  for (const m of messages) yield { type: 'message_appended', message: m }
}

/**
 * 把 tool_calls 按独占工具切分成组：连续非独占 = 一个并行组，独占 = 单独一组（barrier）。
 * 组内并行、组间串行，保证独占工具不会和其他调用并发。
 */
export function groupToolCalls(
  toolMap: Map<string, AgentTool>,
  toolCalls: readonly ToolCall[],
): ToolCall[][] {
  const groups: ToolCall[][] = []
  let i = 0
  while (i < toolCalls.length) {
    const group: ToolCall[] = []
    while (i < toolCalls.length && !(toolMap.get(toolCalls[i].name)?.exclusive)) {
      group.push(toolCalls[i])
      i++
    }
    if (group.length > 0) groups.push(group)
    if (i < toolCalls.length) {
      groups.push([toolCalls[i]])
      i++
    }
  }
  return groups
}

/** 给 Promise 加超时：超时 reject，正常则 clearTimeout 防泄漏 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 执行单个工具：校验 → 审批 → abort 检查 → 执行 → 错误处理 */
async function executeOne(
  toolMap: Map<string, AgentTool>,
  tc: ToolCall,
  signal: AbortSignal | undefined,
  approve: ApproveFn | undefined,
  beforeToolCall: BeforeToolCallFn | undefined,
  afterToolCall: AfterToolCallFn | undefined,
): Promise<ToolCallResult> {
  const tool = toolMap.get(tc.name)
  if (!tool) return { id: tc.id, name: tc.name, result: `error: tool "${tc.name}" not found` }

  const violations = validateArgs(tool.parameters, tc.args)
  if (violations.length > 0) {
    return { id: tc.id, name: tc.name, result: `error: invalid arguments: ${violations.join('; ')}` }
  }

  // 执行前拦截（通用钩子，可阻止任意工具）
  if (beforeToolCall) {
    const decision = await beforeToolCall(tc.name, tc.args)
    if (decision?.block) {
      return { id: tc.id, name: tc.name, result: decision.reason ?? `error: tool "${tc.name}" blocked` }
    }
  }

  // 危险调用需审批：无审批渠道 fail-closed（拒绝），有则询问用户
  if (tool.needsApproval?.(tc.args)) {
    if (!approve) {
      return { id: tc.id, name: tc.name, result: `error: tool "${tc.name}" requires approval but no approval channel is available` }
    }
    const allowed = await approve(tc.name, tc.args)
    if (!allowed) return { id: tc.id, name: tc.name, result: 'error: denied by user' }
  }

  if (signal?.aborted) return { id: tc.id, name: tc.name, result: 'error: aborted' }

  try {
    const exec = tool.execute(tc.args, signal)
    const result = tool.timeoutMs !== undefined ? await withTimeout(exec, tool.timeoutMs) : await exec
    const final = afterToolCall ? (await afterToolCall(tc.name, tc.args, result))?.result ?? result : result
    return { id: tc.id, name: tc.name, result: final }
  } catch (e) {
    return { id: tc.id, name: tc.name, result: signal?.aborted ? 'aborted' : `error: ${(e as Error).message}` }
  }
}

/**
 * 执行一组工具调用：组内并行（限 MAX_PARALLEL）、组间串行。
 * 结果按 tool_calls 顺序返回，保证 tool_call/tool_result 配对不乱。
 */
async function executeToolCalls(
  toolMap: Map<string, AgentTool>,
  toolCalls: ToolCall[],
  signal: AbortSignal | undefined,
  approve: ApproveFn | undefined,
  beforeToolCall: BeforeToolCallFn | undefined,
  afterToolCall: AfterToolCallFn | undefined,
): Promise<ToolCallResult[]> {
  const executed: ToolCallResult[] = []
  for (const group of groupToolCalls(toolMap, toolCalls)) {
    for (let j = 0; j < group.length; j += MAX_PARALLEL) {
      const chunk = group.slice(j, j + MAX_PARALLEL)
      executed.push(...await Promise.all(chunk.map(tc => executeOne(toolMap, tc, signal, approve, beforeToolCall, afterToolCall))))
    }
  }
  return executed
}

/**
 * 运行 agent 循环。无 max_steps——loop 到模型说停为止。pi 同样无硬编码步数上限，但额外有 shouldStopAfterTurn 回调，教学版省略。
 *
 * @param model    模型配置
 * @param context  对话上下文（会被原地修改）
 * @param tools    工具注册表
 * @param signal   abort 信号
 * @param approve  审批回调（危险工具调用时询问用户），缺省时危险调用 fail-closed 拒绝
 * @param streamFn LLM 流式调用函数（默认 llm.ts 的 stream，可注入替换后端）
 * @param shouldStopAfterTurn 每轮后判断是否停止，返回 true 则 yield turn_end(stopped) 结束
 * @param beforeToolCall 工具执行前拦截（返回 block: true 阻止执行）
 * @param afterToolCall 工具执行后修改结果（返回 result 覆盖）
 */
export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
  approve?: ApproveFn,
  streamFn: StreamFn = stream,
  shouldStopAfterTurn?: ShouldStopAfterTurnFn,
  beforeToolCall?: BeforeToolCallFn,
  afterToolCall?: AfterToolCallFn,
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))

  while (true) {
    // 0. 对话压缩：消息过多时先压缩旧消息
    const compacted = await compactContext(model, context, streamFn, signal)
    if (compacted) yield { type: 'compaction', summary: compacted.summary, keptFromIndex: compacted.keptFromIndex }

    // 1. 流式调用 LLM，收集文本和 tool_calls
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    const toolCalls: ToolCall[] = []

    for await (const ev of streamFn(model, context, { tools: toolDefs, signal })) {
      if (ev.type === 'text_delta') {
        text += ev.delta
        yield { type: 'assistant_text', delta: ev.delta }
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
        yield { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args }
      } else if (ev.type === 'done') {
        stopReason = ev.stopReason
        if (ev.stopReason === 'aborted') {
          // abort 时丢弃 tool_calls（无对应 tool_result 会导致 session 恢复后 API 报错）
          const assistant = buildAssistantMessage(text, [])
          context.messages.push(assistant)
          yield { type: 'message_appended', message: assistant }
          yield { type: 'turn_end', stopReason: 'aborted' }
          return
        }
      } else if (ev.type === 'error') {
        const assistant = buildAssistantMessage(text, [])
        context.messages.push(assistant)
        yield { type: 'message_appended', message: assistant }
        yield { type: 'assistant_text', delta: `\n[error] ${ev.error.message}` }
        yield { type: 'turn_end', stopReason: 'error' }
        return
      }
    }

    // 2. 把 assistant 回复塞回 context
    const assistant = buildAssistantMessage(text, toolCalls)
    context.messages.push(assistant)
    yield { type: 'message_appended', message: assistant }

    // 3. 截断处理：max_tokens 时 tool args 可能不完整，不执行，把错误放回到 Context 让模型重发
    if (stopReason === 'max_tokens' && toolCalls.length > 0) {
      const results = toolCalls.map(tc => ({
        tool_use_id: tc.id,
        content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
      }))
      const resultMessages = buildToolResultMessages(results)
      context.messages.push(...resultMessages)
      yield* emitAppended(resultMessages)
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_result', id: toolCalls[i].id, name: toolCalls[i].name, result: results[i].content }
      }
      continue
    }

    // 4. 没有 tool_call → 循环结束
    // 畸形 API 可能返回 tool_use 但无 tool_call delta，此时视为正常结束
    const reason = stopReason === 'tool_use' ? 'end_turn' : stopReason
    if (toolCalls.length === 0) {
      yield { type: 'turn_end', stopReason: reason }
      return
    }

    // 5. 执行 tool_calls：独占工具切分组，组内并行、组间串行
    const executed = await executeToolCalls(toolMap, toolCalls, signal, approve, beforeToolCall, afterToolCall)
    const results = executed.map(r => ({ tool_use_id: r.id, content: r.result }))
    for (const r of executed) {
      yield { type: 'tool_result', id: r.id, name: r.name, result: r.result }
    }

    // 6. 把 tool_result 放回到 Context，进入下一轮
    const resultMessages = buildToolResultMessages(results)
    context.messages.push(...resultMessages)
    yield* emitAppended(resultMessages)

    // 7. 每轮后让调用方判断是否该停（限制步数 / 检测死循环）
    if (shouldStopAfterTurn && await shouldStopAfterTurn(context)) {
      yield { type: 'turn_end', stopReason: 'stopped' }
      return
    }
  }
}
