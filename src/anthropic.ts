// src/anthropic.ts
// Anthropic provider adapter：把内部 Context 转成 Anthropic 格式，并解析 Anthropic SSE。
// 实现 StreamFn 契约（产出 StreamEvent），可注入 runAgent 替换 OpenAI 后端。

import { retryableFetch, type Model, type Context, type StreamEvent, type ToolDef } from './llm.js'

/** Anthropic API 根地址 */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'

/**
 * 把 Context 转成 Anthropic 的 messages 格式（不含 system 和 tools）。
 * 关键差异：Anthropic 没有独立的 tool role，tool 结果放在 user 消息的 tool_result block 里，
 * 所以内部模型里连续的 tool 消息要打包成一个 user 消息。
 */
export function contextToAnthropicMessages(context: Context): object[] {
  const messages: object[] = []
  let i = 0
  while (i < context.messages.length) {
    const msg = context.messages[i]
    if (msg.role === 'tool') {
      const toolResults: object[] = []
      while (i < context.messages.length) {
        const t = context.messages[i]
        if (t.role !== 'tool') break
        toolResults.push({ type: 'tool_result', tool_use_id: t.tool_use_id, content: t.content })
        i++
      }
      messages.push({ role: 'user', content: toolResults })
    } else if (msg.role === 'assistant') {
      // assistant 的 content 实际总是 ContentBlock[]，string 分支仅为类型安全
      const content = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content.map(b =>
          b.type === 'text'
            ? { type: 'text', text: b.text }
            : { type: 'tool_use', id: b.id, name: b.name, input: b.input },
        )
      messages.push({ role: 'assistant', content })
      i++
    } else {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content })
      } else {
        const textBlocks = msg.content.filter(b => b.type === 'text').map(b => ({ type: 'text', text: b.text }))
        messages.push({ role: 'user', content: textBlocks })
      }
      i++
    }
  }
  return messages
}

/** Anthropic SSE 事件的最小类型 */
type AnthropicEvent = {
  type: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  content_block?: { type?: string; id?: string; name?: string; input?: unknown }
}

/** Anthropic stop_reason → 内部 stopReason */
function mapStopReason(reason: string): 'end_turn' | 'tool_use' | 'max_tokens' {
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'max_tokens'
  return 'end_turn'  // end_turn / stop_sequence / 其他
}

/** 解析一行 Anthropic SSE data，返回 text_delta / tool_call / stop_reason */
function handleAnthropicEvent(
  data: string,
): { textDelta: string | null; toolCall: { id: string; name: string; args: unknown } | null; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null } {
  let event: AnthropicEvent
  try { event = JSON.parse(data) as AnthropicEvent } catch { return { textDelta: null, toolCall: null, stopReason: null } }

  // 文本增量：content_block_delta 的 text_delta
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return { textDelta: event.delta.text ?? '', toolCall: null, stopReason: null }
  }
  // 工具调用：content_block_start 的 tool_use（input 一次性给全，无需分片累积）
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    return {
      textDelta: null,
      toolCall: {
        id: event.content_block.id ?? '',
        name: event.content_block.name ?? '',
        args: event.content_block.input ?? {},
      },
      stopReason: null,
    }
  }
  // 停止原因：message_delta 的 stop_reason
  if (event.type === 'message_delta' && event.delta?.stop_reason) {
    return { textDelta: null, toolCall: null, stopReason: mapStopReason(event.delta.stop_reason) }
  }
  return { textDelta: null, toolCall: null, stopReason: null }
}

/**
 * 调用 Anthropic Messages API（streaming），返回统一事件流。
 * 实现 StreamFn 契约，可注入 runAgent 替换 OpenAI 后端。
 */
export async function* anthropicStream(
  model: Model,
  context: Context,
  opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? ANTHROPIC_BASE_URL}/messages`
  const messages = contextToAnthropicMessages(context)

  const body: Record<string, unknown> = {
    model: model.model,
    max_tokens: model.maxTokens ?? 4096,  // Anthropic 必须显式给 max_tokens
    stream: true,
    messages,
  }
  if (context.systemPrompt) body.system = context.systemPrompt
  if (opts.tools?.length) {
    body.tools = opts.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  // 发请求（带重试退避）
  let response: Response
  try {
    response = await retryableFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      },
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

        const result = handleAnthropicEvent(data)
        if (result.textDelta) yield { type: 'text_delta', delta: result.textDelta }
        if (result.toolCall) yield { type: 'tool_call', id: result.toolCall.id, name: result.toolCall.name, args: result.toolCall.args }
        if (result.stopReason) stopReason = result.stopReason
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  yield { type: 'done', stopReason: opts.signal?.aborted ? 'aborted' : stopReason }
}
