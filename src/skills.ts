// src/skills.ts
// Skill 机制（deepseek-harness 三阶段渐进披露的教学化实现）：
// 1. 目录阶段：所有 skill 的 name/description 常驻 system prompt（<available_skills> 块）
// 2. 判断阶段：模型根据任务与目录描述的匹配度自主决定加载哪个 skill（语义路由，非关键词）
// 3. 加载阶段：模型调 load_skill 工具，按需把该 skill 的完整指令取进上下文
// 指令只在用到时进上下文（省 token）；加载结果留在 messages 里，后续轮次无需重载。

import { promises as fs } from 'node:fs'
import type { AgentTool } from './agent.js'

/** Skill：目录摘要 + 完整指令 + 可选工具 */
export type Skill = {
  name: string
  description: string  // 目录里展示的一句话摘要（模型据此判断是否相关）
  prompt: string       // 完整指令，模型通过 load_skill 按需加载
  tools?: AgentTool[]  // 随 skill 常驻注册的工具
}

/** 生成 system prompt 的 skill 目录（无 skill 返回空串） */
export function buildSkillCatalog(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  const entries = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  return [
    '',
    '<available_skills>',
    entries,
    '</available_skills>',
    '任务与某个 skill 的描述匹配时，先用 load_skill 工具加载其完整指令再行动。目录只有摘要，未加载前不要推断 skill 的具体指令。',
  ].join('\n')
}

/** 造出 load_skill 工具：模型自主决定加载哪个 skill 的完整指令 */
export function createLoadSkillTool(skills: readonly Skill[]): AgentTool {
  return {
    name: 'load_skill',
    description: '加载指定 skill 的完整指令。任务与可用 skill 列表中的某个匹配时，先调用本工具。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill 名（来自 available_skills 列表）' } },
      required: ['name'],
    },
    execute: async (args) => {
      const { name } = args as { name: string }
      const skill = skills.find((s) => s.name === name)
      if (!skill) {
        return `error: skill "${name}" not found，可用: ${skills.map((s) => s.name).join(', ')}`
      }
      return `<skill_content name="${skill.name}">\n${skill.prompt}\n</skill_content>`
    },
  }
}

/** 汇总所有 skills 的工具（同名去重，保留先注册的） */
export function collectSkillTools(skills: readonly Skill[]): AgentTool[] {
  const seen = new Set<string>()
  const tools: AgentTool[] = []
  for (const s of skills) {
    for (const t of s.tools ?? []) {
      if (seen.has(t.name)) continue
      seen.add(t.name)
      tools.push(t)
    }
  }
  return tools
}

/** review_file 启发式检查的规则（label 供展示，re 必须带 g 标志供 matchAll） */
const REVIEW_PATTERNS = [
  { label: 'TODO/FIXME', re: /\b(TODO|FIXME|HACK|XXX)\b/g },
  { label: 'console.log 调试输出', re: /console\.(log|debug)\(/g },
  { label: '疑似硬编码密钥', re: /(sk-[a-zA-Z0-9]{8,}|AKIA[A-Z0-9]{16}|password\s*[:=]\s*['"][^'"]{4,}['"])/gi },
]

/** code-review skill 自带工具：读文件做启发式检查（纯函数式，读文件不碰 agent 状态） */
const reviewFileTool: AgentTool = {
  name: 'review_file',
  description: '对文件做启发式代码审查：统计 TODO/FIXME、console.log、疑似硬编码密钥',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '要审查的文件路径' } },
    required: ['path'],
  },
  timeoutMs: 10_000,
  execute: async (args) => {
    const { path } = args as { path: string }
    const content = await fs.readFile(path, 'utf-8')
    const lines = content.split('\n')
    const hits: string[] = []
    for (const { label, re } of REVIEW_PATTERNS) {
      for (const m of content.matchAll(re)) {
        const lineNo = content.slice(0, m.index).split('\n').length
        hits.push(`- [${label}] ${path}:${lineNo} ${lines[lineNo - 1]?.trim().slice(0, 100)}`)
      }
    }
    if (hits.length === 0) return `${path}: ${lines.length} 行，未发现明显问题`
    return `${path}: ${lines.length} 行，${hits.length} 处可疑\n${hits.join('\n')}`
  },
}

/** 内置教学示例 skill：演示「指令 + 工具」与「纯指令」两种形态 */
export function builtinSkills(): Skill[] {
  return [
    {
      name: 'code-review',
      description: '以严格代码审查者身份检查代码',
      prompt: '现在切换到代码审查者角色。用 review_file 工具逐文件检查，重点：1) 安全性（注入、路径遍历、密钥硬编码）2) 边界条件与错误处理 3) 性能与资源泄漏 4) 可读性与命名。最后按严重程度输出问题清单并给出修改建议。',
      tools: [reviewFileTool],
    },
    {
      name: 'react-style',
      description: '编写 React 组件时遵守团队规范',
      prompt: '编写 React 代码时遵守：组件/文件用 PascalCase；hooks 用 use 前缀；状态提升到需要它的最上层；避免内联对象/函数造成不必要重渲染；列表 key 用稳定唯一值。',
    },
  ]
}
