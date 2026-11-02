#!/usr/bin/env node
// src/cli.ts
// 拼装层 —— 把 llm / agent / tui / tools 粘起来，是唯一入口。
// session 持久化：每轮结束把 context.messages append 到 ~/.nanopi/session.jsonl。

import { promises as fs, realpathSync } from 'node:fs'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'
import * as os from 'node:os'
import { runAgent, type AgentTool, type StreamFn } from './agent.js'
import { Tui, parseSlashCommand, dimText } from './tui.js'
import { builtinTools } from './tools.js'
import { anthropicStream } from './anthropic.js'
import { connectMcpTools } from './mcp.js'
import { detectLoop } from './context-management.js'
import { RunEventLog } from './event-log.js'
import { DEFAULT_PROVIDER, getPreset, presetCatalog } from './providers.js'
import { builtinSkills, buildSkillCatalog, collectSkillTools, createLoadSkillTool } from './skills.js'
import { stream, type Model, type Context, type Message, type RetrySettings } from './llm.js'

const SESSION_DIR = path.join(os.homedir(), '.nanopi')
const CONFIG_FILE = path.join(SESSION_DIR, 'config.json')

/** 项目级 session 目录：按启动目录隔离（slug 规则与 Claude Code 的 projects 命名一致） */
export function projectSessionDir(cwd: string = process.cwd()): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-')
  return path.join(SESSION_DIR, 'projects', slug)
}

/** 目录下最近修改的 session 文件；没有则返回 undefined */
export async function latestSessionFile(dir: string): Promise<string | undefined> {
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter(f => /^session-.*\.jsonl$/.test(f))
  } catch {
    return undefined  // 目录不存在 = 该项目从未有过会话
  }
  if (files.length === 0) return undefined
  const withTime = await Promise.all(files.map(async f => ({
    f: path.join(dir, f),
    m: (await fs.stat(path.join(dir, f))).mtimeMs,
  })))
  return withTime.sort((a, b) => b.m - a.m)[0]!.f
}

/** 解析 -c / --continue：续接该项目最近一次会话 */
export function parseContinueFlag(argv: string[]): boolean {
  return argv.some(a => a === '-c' || a === '--continue')
}

/** 事件日志文件与 session 文件同 ts 配对：session-<ts>.jsonl ↔ events-<ts>.jsonl（导出供测试） */
export function eventFileFor(sessionFile: string): string {
  return path.join(path.dirname(sessionFile), path.basename(sessionFile).replace(/^session-/, 'events-'))
}

/** 固定 system prompt */
const SYSTEM_PROMPT = '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。'

// 记录已持久化的 message 数量，只 append 新增的。
// 这是 CLI 进程级状态（非 agent 状态——agent 本身无状态，context 就是状态）。
let persistedCount = 0

/** 应用配置：apiKey 可来自 flag / env / 配置文件，其余可从配置文件加载 */
type AppConfig = {
  apiKey: string
  providerId: string  // 预设 id（zhipu/deepseek/…），用于显示
  provider: 'openai' | 'anthropic'  // 协议，决定 LLM 后端
  model: string
  baseUrl?: string
  maxTokens?: number
  contextWindow?: number
  retry?: RetrySettings
  mcpServers?: { command: string; args?: string[] }[]
}

/** 配置文件的原始形态：provider 存的是预设 id（zhipu/deepseek/…），运行时解析成 protocol */
type FileConfig = Omit<Partial<AppConfig>, 'provider'> & { provider?: string }

/**
 * 解析 key 的三种来源，优先级：--api-key flag > NANOPI_API_KEY env > config.json。
 * 三者皆无时 throw，由调用方决定是否进入首次录入引导。
 */
export async function loadConfig(file: string = CONFIG_FILE, env: NodeJS.ProcessEnv = process.env, apiKeyArg?: string): Promise<AppConfig> {
  let fileConfig: FileConfig = {}
  try {
    fileConfig = JSON.parse(await fs.readFile(file, 'utf-8')) as FileConfig
  } catch {
    // 文件不存在或损坏，用默认值
  }

  const apiKey = apiKeyArg ?? env.NANOPI_API_KEY ?? fileConfig.apiKey
  if (!apiKey) throw new Error('未找到 API key：用 --api-key 传入、设置 NANOPI_API_KEY 环境变量，或重新运行进入引导录入')

  // provider id 决定预设，未显式指定的 model/baseUrl 落到预设值
  const providerId = env.NANOPI_PROVIDER ?? fileConfig.provider ?? DEFAULT_PROVIDER
  const preset = getPreset(providerId)
  if (!preset) throw new Error(`未知的 provider: ${providerId}\n可选 provider:\n${presetCatalog()}`)

  return {
    apiKey,
    providerId,
    provider: preset.protocol,
    model: env.NANOPI_MODEL ?? fileConfig.model ?? preset.model,
    baseUrl: env.NANOPI_BASE_URL ?? fileConfig.baseUrl ?? preset.baseUrl,
    maxTokens: fileConfig.maxTokens ?? 4096,
    contextWindow: fileConfig.contextWindow ?? 128000,
    retry: fileConfig.retry,
    mcpServers: fileConfig.mcpServers,
  }
}

/** 解析 --api-key <key> / --api-key=<key>，其余参数忽略（导出供测试） */
export function parseApiKeyArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api-key') return argv[i + 1]
    if (argv[i]?.startsWith('--api-key=')) return argv[i].slice('--api-key='.length)
  }
  return undefined
}

/** 401/403 → 追加 key 排查指引（导出供测试） */
export function friendlyKeyError(message: string): string {
  return /\bAPI 40[13]\b/.test(message)
    ? message + `\nAPI key 无效或无权限：请检查 --api-key / NANOPI_API_KEY，或删除 ${CONFIG_FILE} 后重新运行录入`
    : message
}

/** 保存 API key 到配置文件（保留已有字段），chmod 600 防其他用户读取（导出供测试） */
export async function saveApiKey(key: string, file: string = CONFIG_FILE): Promise<void> {
  let config: FileConfig = {}
  try { config = JSON.parse(await fs.readFile(file, 'utf-8')) as FileConfig } catch { /* 不存在则新建 */ }
  config.apiKey = key
  await fs.mkdir(path.dirname(file) || '.', { recursive: true })
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  await fs.chmod(file, 0o600)
}

/** 首次运行引导：终端读取 key（教学版简单回显，不做 raw-mode 隐藏输入） */
async function promptApiKey(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>(resolve => rl.question('未检测到 API key，请输入（回车确认）: ', resolve))
  rl.close()
  const key = answer.trim()
  if (!key) throw new Error('API key 不能为空')
  return key
}

async function main() {
  let config: AppConfig
  try {
    config = await loadConfig(undefined, process.env, parseApiKeyArg(process.argv.slice(2)))
  } catch (e) {
    // 只有"缺 key"可引导补救；其他配置错误（如未知 provider）直接退出
    if (!/API key/.test((e as Error).message)) {
      console.error((e as Error).message)
      process.exit(1)
    }
    try {
      const key = await promptApiKey()
      await saveApiKey(key)
      console.error(`已保存 API key 到 ${CONFIG_FILE}（权限 600）`)
      config = await loadConfig(undefined, process.env, key)
    } catch (e2) {
      console.error((e2 as Error).message)
      process.exit(1)
    }
  }

  const model: Model = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxTokens: config.maxTokens,
    contextWindow: config.contextWindow,
    retry: config.retry,
  }

  // 按 provider 选择 LLM 后端（默认 openai 兼容，NANOPI_PROVIDER=anthropic 时走 Anthropic）
  const backend = config.provider === 'anthropic' ? anthropicStream : stream

  // 401/403 转友好提示：key 无效是新手最常撞的错，raw 报错没有可操作性
  const streamFn: StreamFn = async function* (model, context, opts) {
    for await (const ev of backend(model, context, opts)) {
      yield ev.type === 'error' ? { ...ev, error: new Error(friendlyKeyError(ev.error.message)) } : ev
    }
  }

  // Skill 机制：name/description 目录常驻 system prompt，模型自主判断后用 load_skill 按需加载指令
  const skills = builtinSkills()

  // session 按启动目录隔离：默认开新会话，-c 续接该项目最近一次（对齐 Claude Code 语义）
  const argv = process.argv.slice(2)
  const projectDir = projectSessionDir()
  let sessionFile = (parseContinueFlag(argv) ? await latestSessionFile(projectDir) : undefined)
    ?? path.join(projectDir, `session-${Date.now()}.jsonl`)

  // 初始化 context：system prompt 用专用字段（含 skill 目录），messages 从 session 文件加载
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT + buildSkillCatalog(skills),
    messages: await loadSession(sessionFile),
  }

  // 事件日志（P1 双写）：与 session 文件同 ts 配对，消息落 context 的瞬间写事件。
  // context 仍以 session JSONL 为准；-c 续接老会话（无事件日志）时 open 会补 header 开始记录。
  const eventFile = eventFileFor(sessionFile)
  let eventLog = context.messages.length > 0
    ? (await RunEventLog.open(eventFile, process.cwd())).log
    : await RunEventLog.create(eventFile, process.cwd())

  // 内置工具 + MCP 工具（连接配置的 MCP server，失败只警告不阻塞）
  const mcpTools: AgentTool[] = []
  for (const server of config.mcpServers ?? []) {
    try {
      mcpTools.push(...await connectMcpTools(server.command, server.args ?? []))
    } catch (e) {
      console.error(`[mcp] 连接 ${server.command} 失败: ${(e as Error).message}`)
    }
  }
  // skill 工具常驻注册（不随加载动态挂载），load_skill 供模型按需取指令
  const tools = [...builtinTools(), ...mcpTools, ...collectSkillTools(skills), createLoadSkillTool(skills)]
  const tui = new Tui()

  // 欢迎信息：给"进入 harness"的明确反馈（模型 + 工作目录 + 会话状态）
  console.log(dimText(`hf-coding-agent · ${config.providerId}/${config.model}`))
  console.log(dimText(`cwd ${process.cwd()} · ${context.messages.length ? `已续接 ${context.messages.length} 条历史（-c 生效）` : '新会话'} · /help 查看命令 · Ctrl+C 退出`))

  // /new 后指向新的 session 文件，旧文件保留在磁盘（仍在当前项目目录内）
  const newSessionFile = () => path.join(projectDir, `session-${Date.now()}.jsonl`)

  let quitting = false
  const quit = () => {
    if (quitting) return  // stop() 关闭 readline 会再触发 close→onQuit，防重入
    quitting = true
    console.log('\n再见 👋')
    tui.stop()
    process.exit(0)
  }

  /** slash 命令：不进 agent 的本地操作（async：/new 需重建事件日志） */
  const handleCommand = async (text: string): Promise<void> => {
    const cmd = parseSlashCommand(text)
    switch (cmd) {
      case '/help':
        tui.printText([
          '命令：',
          '  /help   显示本帮助',
          '  /clear  清屏',
          '  /new    开新会话（丢弃当前上下文，旧 session 文件保留）',
          '  /model  查看当前模型配置',
          '  /exit   退出（/quit 同义）',
        ].join('\n') + '\n')
        break
      case '/clear':
        tui.clearScreen()
        break
      case '/new':
        context.messages = []
        persistedCount = 0
        sessionFile = newSessionFile()
        eventLog = await RunEventLog.create(eventFileFor(sessionFile), process.cwd())
        tui.printText('已开新会话\n')
        break
      case '/model':
        tui.printText(`${config.providerId}/${config.model} @ ${config.baseUrl ?? '（预设默认）'}（${config.provider} 协议）\n`)
        break
      case '/exit':
      case '/quit':
        quit()
        break
      default:
        tui.printText(`未知命令 ${cmd}，/help 查看可用命令\n`)
    }
  }

  tui.onQuit(quit)

  // 每轮：用户输入 → runAgent → 事件转发到 TUI → 持久化
  tui.onPrompt(async (text) => {
    try {
      // slash 命令本地处理，不进 agent、不持久化
      if (parseSlashCommand(text)) {
        await handleCommand(text)
        tui.setBusy(false)  // 同步命令完成，触发重新提示（setBusy(false) 即 re-prompt 时机）
        return
      }

      const userMessage: Message = { role: 'user', content: text }
      context.messages.push(userMessage)
      await eventLog.appendMessage(userMessage)

      tui.setBusy(true)
      tui.startSpinner('thinking…')
      const turnStart = Date.now()
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // 每轮新建 AbortController，需重新注册回调指向新的 controller

      const approve = (name: string, args: unknown) =>
        tui.askApproval(`\n[审批] 允许执行 ${name} ${JSON.stringify(args)}? [y/N] `)

      // 保护敏感文件：agent 读写密钥/环境变量文件时直接拦截
      const beforeToolCall = async (name: string, args: unknown) => {
        const path = (args as { path?: string }).path
        if (path && /(\.env|\.ssh|id_rsa|id_ed25519)/.test(path)) {
          return { block: true, reason: `禁止操作敏感文件: ${path}` }
        }
      }

      // 结果脱敏：把结果里的 API 密钥打码
      const afterToolCall = async (_name: string, _args: unknown, result: string) => {
        return { result: result.replace(/sk-[a-zA-Z0-9]+/g, 'sk-***') }
      }

      for await (const ev of runAgent(model, context, tools, ctrl.signal, approve, streamFn, detectLoop, beforeToolCall, afterToolCall)) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call':
            tui.printToolCall(ev.name, ev.args)
            tui.startSpinner(`tool: ${ev.name}`)
            break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'message_appended': await eventLog.appendMessage(ev.message); break
          case 'compaction': await eventLog.appendCompaction(ev.summary, ev.keptFromIndex); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            if (ev.stopReason === 'stopped') tui.printText('\n[stopped by shouldStopAfterTurn]')
            tui.stopSpinner()
            tui.foldTurn()  // 回合末把工具区收成一行摘要（显示层，不影响 context）
            tui.printTurnEnd()
            await eventLog.appendTurnEnd(ev.stopReason)
            tui.printText(dimText(`· ${context.messages.length} 条消息 · ${((Date.now() - turnStart) / 1000).toFixed(1)}s\n`))
            break
        }
      }

      await persistSession(context.messages, sessionFile)
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.stopSpinner()
      tui.setBusy(false)
    }
  })

  tui.start()

}

/** 启动时加载历史 messages，恢复上次对话（导出供测试） */
export async function loadSession(file: string): Promise<Message[]> {
  try {
    const data = await fs.readFile(file, 'utf-8')
    const lines = data.trim().split('\n').filter(Boolean)
    // 逐行容错：跳过损坏行而非丢弃全部历史（进程崩溃可能写出半行 JSON）
    const messages = lines.flatMap(line => {
      try { return [JSON.parse(line) as Message] } catch { return [] }
    })
    persistedCount = messages.length  // 已加载的不重复写
    return messages
  } catch {
    return []  // 文件不存在，从空开始
  }
}

/** 持久化 messages 到 session 文件（导出供测试） */
export async function persistSession(messages: Message[], file: string): Promise<void> {
  await fs.mkdir(path.dirname(file) || '.', { recursive: true })
  const newMessages = messages.slice(persistedCount)
  for (const msg of newMessages) {
    await fs.appendFile(file, JSON.stringify(msg) + '\n', 'utf-8')
  }
  persistedCount = messages.length
}

// 只在直接运行时启动（非 import 时）。两个坑：
// 1. import.meta.url 会 percent-encode 空格等字符 → 用 pathToFileURL 对齐；
// 2. 经 npm bin 符号链接启动时 argv[1] 是链接路径，而 import.meta.url 是解析后的真实路径 → 用 realpathSync 对齐。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
