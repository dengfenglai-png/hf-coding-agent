// src/llm.ts
// 统一 LLM API —— 把 OpenAI Completions SSE 响应解析成四种事件流。
// 教学版只支持 OpenAI 兼容格式（GLM、DeepSeek、Ollama 等均兼容）。

// ===== 类型 =====

/** 模型配置 */
export type Model = {
  apiKey: string
  model: string          // 如 "gpt-4o" 或 "glm-5.2"
  baseUrl?: string       // 默认 https://api.openai.com/v1
  maxTokens?: number     // 不设则由 API 决定默认值（cli.ts 设为 4096）
  contextWindow?: number // 模型上下文窗口 token 数，默认 128K（见 context-management.ts）
  retry?: RetrySettings  // 重试配置（参考 pi 的 RetrySettings）
}

/** 重试配置：有界重试 + 指数退避（参考 pi 的 RetrySettings） */
export type RetrySettings = {
  enabled?: boolean     // 默认 true
  maxRetries?: number   // 默认 3
  baseDelayMs?: number  // 默认 2000（退避：2s, 4s, 8s）
}

/**
 * content block：消息内容的结构化单元。
 * tool_result 不是 block，而是独立的 tool 消息（对齐 pi 的 ToolResultMessage）。
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

/** 消息：user / assistant 用 ContentBlock，tool 结果是独立的 tool 消息 */
export type Message =
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: string | ContentBlock[] }
  | { role: 'tool'; tool_use_id: string; content: string }

/** Context：纯 JSON，可 stringify 落盘 */
export type Context = {
  systemPrompt?: string
  messages: Message[]
}

/** 流事件：llm 模块对外的统一输出 */
export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
  | { type: 'error'; error: Error }

/** agent 模块传入的 tool 定义格式 */
export type ToolDef = {
  name: string
  description: string
  parameters: object
}

// ===== 辅助函数 =====

/**
 * 把 nanopi Context 转成 OpenAI messages 格式。
 * 纯转换函数，不含网络逻辑。
 */
export function contextToOpenAIMessages(context: Context): object[] {
  const messages: object[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })

  for (const msg of context.messages) {
    if (msg.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: msg.tool_use_id, content: msg.content })
      continue
    }

    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    const blocks = msg.content
    if (msg.role === 'assistant') {
      const toolCalls: object[] = []
      let text = ''
      for (const b of blocks) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })
        }
      }
      // OpenAI 要求 assistant 消息必须有 content（非 null）或 tool_calls。
      // 纯 tool_call 时 content 为 null；两者皆空（如 abort/error 后的无内容轮次）用空串占位，避免 API 400。
      const content = text || (toolCalls.length ? null : '')
      messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined })
    } else {
      // user 消息的 text block → user 消息
      for (const b of blocks) {
        if (b.type === 'text') {
          messages.push({ role: 'user', content: b.text })
        }
      }
    }
  }
  return messages
}

// ===== 重试退避 =====

/** 配额/账单错误：即使返回 429，也是配额耗尽而非限流，重试无用 */
const NON_RETRYABLE_ERROR_PATTERNS = [
  /insufficient_quota/i,
  /quota exceeded/i,
  /out of budget/i,
  /billing/i,
  /usage limit/i,
  /余额不足/,       // 智谱 1113
  /无可用资源包/,
  /请充值/,
]

/** 可重试的 HTTP 状态码：429 限流 + 5xx 服务端错误 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** 判断错误消息是否为配额/账单错误（fail fast，不重试） */
export function isNonRetryableError(text: string): boolean {
  return NON_RETRYABLE_ERROR_PATTERNS.some(re => re.test(text))
}

/** 可中断的 sleep：abort 时 reject，用于退避等待 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

/** 带退避重试的 fetch：429/5xx/网络错误重试，配额错误 fail fast */
export async function retryableFetch(
  url: string,
  init: RequestInit,
  retry: RetrySettings | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const maxRetries = retry?.enabled === false ? 0 : (retry?.maxRetries ?? 3)
  const baseDelayMs = retry?.baseDelayMs ?? 2000
  let attempt = 0
  for (;;) {
    try {
      const response = await fetch(url, init)
      if (!isRetryableStatus(response.status)) return response
      const text = await response.clone().text()
      if (isNonRetryableError(text)) return response
      if (attempt >= maxRetries) return response
      attempt++
      await sleep(baseDelayMs * 2 ** (attempt - 1), signal)
    } catch (e) {
      if (signal?.aborted || attempt >= maxRetries) throw e
      attempt++
      await sleep(baseDelayMs * 2 ** (attempt - 1), signal)
    }
  }
}

/** OpenAI SSE chunk 的最小类型 */
type OpenAIChunk = {
  choices: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
}

/** 解析一行 SSE data，累积 tool_call，返回 text_delta 和 stop_reason */
function handleSSELine(
  data: string,
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { textDelta: string | null; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null } {
  let chunk: OpenAIChunk
  try { chunk = JSON.parse(data) as OpenAIChunk } catch { return { textDelta: null, stopReason: null } }

  const choice = chunk.choices[0]
  if (!choice) return { textDelta: null, stopReason: null }

  let textDelta: string | null = null
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null

  if (choice.delta?.content) textDelta = choice.delta.content

  // tool_call 增量：按 index 累积 name + arguments 的 partial JSON
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!toolCallBuffers.has(idx)) {
        toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsBuf: '' })
      }
      const entry = toolCallBuffers.get(idx)!
      if (tc.id) entry.id = tc.id
      if (tc.function?.name) entry.name = tc.function.name
      if (tc.function?.arguments) entry.argsBuf += tc.function.arguments
    }
  }

  // finish_reason 映射：tool_calls → tool_use，length → max_tokens，stop → end_turn（默认值）
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'

  return { textDelta, stopReason }
}

/** 流结束：把累积的 tool_calls 按顺序发出 */
function flushToolCalls(
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { id: string; name: string; args: unknown }[] {
  const calls: { id: string; name: string; args: unknown }[] = []
  for (const [, tc] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
    let args: unknown = {}
    if (tc.argsBuf) {
      try { args = JSON.parse(tc.argsBuf) } catch { args = {} }
    }
    calls.push({ id: tc.id, name: tc.name, args })
  }
  return calls
}

// ===== stream 函数 =====

/**
 * 调用 OpenAI Completions API（streaming），返回统一事件流。
 *
 * @param model    模型配置
 * @param context  对话上下文
 * @param opts     tools + abort signal
 */
export async function* stream(
  model: Model,
  context: Context,
  opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
  const messages = contextToOpenAIMessages(context)

  const body: Record<string, unknown> = { model: model.model, stream: true, messages }
  if (model.maxTokens) body.max_tokens = model.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  // 发请求（带重试退避）
  let response: Response
  try {
    response = await retryableFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    }, model.retry, opts.signal)
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'unknown error')
    yield { type: 'error', error: new Error(`API ${response.status}: ${text}`) }; return
  }

  // 逐行解析 SSE
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
  const toolCallBuffers = new Map<number, { id: string; name: string; argsBuf: string }>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue

        const result = handleSSELine(data, toolCallBuffers)
        if (result.textDelta) yield { type: 'text_delta', delta: result.textDelta }
        if (result.stopReason) stopReason = result.stopReason
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  // 发出累积的 tool_calls
  for (const tc of flushToolCalls(toolCallBuffers)) {
    yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args }
  }
  yield { type: 'done', stopReason: opts.signal?.aborted ? 'aborted' : stopReason }
}

// ===== message 构建辅助函数 =====

/** 从一轮 stream 的事件中累积出 assistant message */
export function buildAssistantMessage(
  text: string,
  toolCalls: { id: string; name: string; args: unknown }[],
): Message {
  const content: ContentBlock[] = []
  if (text) content.push({ type: 'text', text })
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
  }
  return { role: 'assistant', content }
}

/** 构造 tool 结果消息（每个结果一条独立的 tool 消息） */
export function buildToolResultMessages(
  results: { tool_use_id: string; content: string }[],
): Message[] {
  return results.map(r => ({
    role: 'tool',
    tool_use_id: r.tool_use_id,
    content: r.content,
  }))
}
