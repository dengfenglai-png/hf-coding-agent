// src/tools.ts
// 4 个内置工具 —— 能读写改代码并执行验证的最小集。
// 每个 tool 是纯函数：async (args) => string，不碰 agent 状态。
// 注意：教学版不验证 args，生产 agent 应在 execute 前用 parameters validate 参数。

import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentTool } from './agent.js'

const execAsync = promisify(exec)

/** 工具输出截取上限（行数），超过则截取尾部并提示 */
const MAX_OUTPUT_LINES = 200

let truncateCounter = 0

/**
 * 截取工具输出：超过 maxLines 行时只保留尾部，完整输出存到临时文件。
 * 尾部优先——错误信息通常在末尾。
 */
async function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): Promise<string> {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  const tmpPath = path.join(os.tmpdir(), `nanopi-output-${process.pid}-${truncateCounter++}.txt`)
  await fs.writeFile(tmpPath, content, 'utf-8')
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`
}

/** 递归搜索时忽略的目录名 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', 'out'])

/** 把 glob 通配符转成正则：* 匹配一层（不含 /），** 匹配任意层 */
function globToRegex(pattern: string): RegExp {
  let regex = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      regex += pattern[i + 1] === '*' ? '.*' : '[^/]*'
      if (pattern[i + 1] === '*') i++
    } else if (c === '?') {
      regex += '[^/]'
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += '\\' + c
    } else {
      regex += c
    }
  }
  return new RegExp(regex + '$')
}

/** 递归列出目录下所有文件（相对路径），跳过忽略目录 */
async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        await walk(path.join(current, entry.name), rel)
      } else {
        files.push(rel)
      }
    }
  }
  await walk(dir, '')
  return files
}

/** glob：查找匹配 glob 模式的文件路径 */
const glob: AgentTool = {
  name: 'glob',
  description: '查找匹配 glob 模式的文件路径。参数：pattern（如 "src/**/*.ts"）、path（搜索根目录，默认当前目录）。返回排序后的相对路径。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，* 匹配一层，** 匹配任意层' },
      path: { type: 'string', description: '搜索根目录，默认当前目录' },
    },
    required: ['pattern'],
  },
  execute: async (args) => {
    const { pattern, path: searchPath } = args as { pattern: string; path?: string }
    const root = searchPath ?? '.'
    const re = globToRegex(pattern)
    const matched = (await walkFiles(root)).filter(f => re.test(f)).sort()
    if (matched.length === 0) return 'no files matched'
    return await truncateOutput(matched.join('\n'))
  },
}

/** grep：搜索文件内容，输出 file:line:content */
const grep: AgentTool = {
  name: 'grep',
  description: '搜索文件内容（正则）。参数：pattern（正则表达式）、path（搜索根目录，默认当前目录）、include（可选 glob 过滤文件，如 "*.ts"）。返回 file:line:content。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索根目录，默认当前目录' },
      include: { type: 'string', description: '可选 glob 过滤文件，如 "*.ts"' },
    },
    required: ['pattern'],
  },
  execute: async (args) => {
    const { pattern, path: searchPath, include } = args as { pattern: string; path?: string; include?: string }
    const root = searchPath ?? '.'
    let re: RegExp
    try { re = new RegExp(pattern) } catch { return `error: invalid regex: ${pattern}` }
    const includeRe = include ? globToRegex(include) : null

    const results: string[] = []
    for (const file of await walkFiles(root)) {
      if (includeRe && !includeRe.test(file)) continue
      let content: string
      try { content = await fs.readFile(path.join(root, file), 'utf-8') } catch { continue }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) results.push(`${file}:${i + 1}:${lines[i]}`)
      }
    }
    if (results.length === 0) return 'no matches'
    return await truncateOutput(results.join('\n'))
  },
  timeoutMs: 15000, // 搜超大目录可能卡
}

/** read_file：返回文件内容（截取尾部防止超大输出） */
const readFile: AgentTool = {
  name: 'read_file',
  description: '读取文件内容。参数：path（文件路径）。大文件截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const { path: filePath } = args as { path: string }
    const content = await fs.readFile(filePath, 'utf-8')
    return await truncateOutput(content)
  },
  timeoutMs: 10000, // 读超大文件可能卡
}

/** write_file：覆盖写入文件 */
const writeFile: AgentTool = {
  name: 'write_file',
  description: '写入文件（覆盖）。参数：path（路径）、content（内容）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as { path: string; content: string }
    await fs.mkdir(path.dirname(filePath) || '.', { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `wrote ${filePath} (${content.length} chars)`
  },
  exclusive: true, // 写文件，可能与其他写操作冲突
}

/** edit：局部字符串替换（精确匹配 + 唯一性校验） */
const edit: AgentTool = {
  name: 'edit',
  description: '编辑文件：精确替换一段文本。参数：path、old_string、new_string。old_string 必须在文件中唯一匹配，否则报错。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的文本（必须唯一匹配）' },
      new_string: { type: 'string', description: '替换后的文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    const { path: filePath, old_string, new_string } = args as { path: string; old_string: string; new_string: string }
    const content = await fs.readFile(filePath, 'utf-8')
    const count = content.split(old_string).length - 1
    if (count === 0) throw new Error(`old_string not found in ${filePath}`)
    if (count > 1) throw new Error(`old_string matches ${count} places in ${filePath}, must be unique`)
    // 用函数替换避免 new_string 中的 $ 特殊字符（$& $` $' $1）被 String.replace 解释
    const newContent = content.replace(old_string, () => new_string)
    await fs.writeFile(filePath, newContent, 'utf-8')
    return `edited ${filePath}: replaced ${old_string.length} chars`
  },
  exclusive: true, // 写文件，可能与其他写操作冲突
}

/** 危险命令匹配模式（匹配"命令 + 高危标志"，而非命令名本身） */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*|--recursive)\b/i,   // rm -r / rm -rf / rm --recursive
  /\bgit\s+push\b[^\n]*(--force|-f)\b/i,      // git push --force / -f
  /\bgit\s+reset\s+--hard\b/i,                // git reset --hard
  /\bsudo\b/i,                                 // sudo 提权
  /\bmkfs\b/i,                                 // mkfs 格式化
  /\bdd\b/i,                                   // dd 覆写设备
  /\b(shutdown|reboot|halt)\b/i,               // 关机/重启
]

/** 判断命令是否危险（需用户审批） */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(command))
}

/** run_bash：执行 shell 命令（截取尾部输出防止超大输出） */
const runBash: AgentTool = {
  name: 'run_bash',
  description: '执行 shell 命令。参数：command（命令字符串）。返回 stdout+stderr，截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
  },
  execute: async (args, signal) => {
    const { command } = args as { command: string }
    try {
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024, timeout: 30000, signal })
      const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout
      return await truncateOutput(output)
    } catch (e: unknown) {
      if (signal?.aborted) return 'aborted'
      const err = e as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      return `[exit ${err.code}] ${err.stderr ?? ''}${err.stdout ?? ''}`
    }
  },
  exclusive: true, // 执行命令，有副作用
  needsApproval: (args) => {
    const { command } = args as { command?: string }
    return typeof command === 'string' && isDangerousCommand(command)
  },
}

/** todo_write：维护任务列表（无状态，agent 传完整列表，工具只格式化） */
const todoWrite: AgentTool = {
  name: 'todo_write',
  description: '维护任务列表。参数：todos（[{ content, status }]），status 为 pending/in_progress/completed/failed。返回格式化后的进度列表。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '任务内容' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  execute: async (args) => {
    const { todos } = args as { todos: { content: string; status: string }[] }
    if (todos.length === 0) return 'no todos'
    return todos.map((t, i) => {
      const mark = t.status === 'completed' ? '✓'
        : t.status === 'in_progress' ? '▶'
        : t.status === 'failed' ? '✗'
        : '○'  // pending 或未知状态
      return `${mark} ${i + 1}. ${t.content}`
    }).join('\n')
  },
}

/** 返回全部内置工具 */
export function builtinTools(): AgentTool[] {
  return [readFile, glob, grep, writeFile, edit, runBash, todoWrite]
}

/**
 * 校验 args 是否符合工具参数的 JSON Schema（简化子集：object + string/number/boolean + required）。
 * 返回违规信息数组，空数组表示通过。deepseek 用完整 JSON Schema 校验，教学版只覆盖内置工具需要的子集。
 */
export function validateArgs(schema: object, args: unknown): string[] {
  const s = schema as {
    type?: string
    properties?: Record<string, { type?: string }>
    required?: string[]
  }
  if (s.type !== 'object') return []
  if (typeof args !== 'object' || args === null) return ['expected an object']

  const violations: string[] = []
  const record = args as Record<string, unknown>

  for (const key of s.required ?? []) {
    if (!(key in record)) violations.push(`missing required property "${key}"`)
  }
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    if (!(key in record)) continue
    const value = record[key]
    const expected = prop.type
    if (expected === 'string' && typeof value !== 'string') violations.push(`"${key}" must be a string`)
    else if (expected === 'number' && typeof value !== 'number') violations.push(`"${key}" must be a number`)
    else if (expected === 'boolean' && typeof value !== 'boolean') violations.push(`"${key}" must be a boolean`)
  }
  return violations
}
