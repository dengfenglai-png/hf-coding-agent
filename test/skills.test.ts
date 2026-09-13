// test/skills.test.ts
// 测试 Skill 机制：目录生成、load_skill 按需加载、工具汇总、内置示例与 review_file 工具。
import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSkillCatalog, createLoadSkillTool, collectSkillTools, builtinSkills, type Skill } from '../src/skills.js'
import type { AgentTool } from '../src/agent.js'

function makeTool(name: string): AgentTool {
  return { name, description: '', parameters: {}, execute: async () => '' }
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return { name: 'a', description: 'desc-a', prompt: 'prompt-a', ...overrides }
}

describe('buildSkillCatalog', () => {
  it('无 skill 返回空串', () => {
    expect(buildSkillCatalog([])).toBe('')
  })

  it('目录包含每个 skill 的 name: description', () => {
    const out = buildSkillCatalog([makeSkill(), makeSkill({ name: 'b', description: 'desc-b' })])
    expect(out).toContain('- a: desc-a')
    expect(out).toContain('- b: desc-b')
    expect(out).toContain('<available_skills>')
    expect(out).toContain('</available_skills>')
  })

  it('包含 load_skill 使用引导（防从摘要猜指令）', () => {
    expect(buildSkillCatalog([makeSkill()])).toContain('load_skill')
  })
})

describe('createLoadSkillTool', () => {
  it('加载存在的 skill → 返回 <skill_content> 包裹的完整指令', async () => {
    const tool = createLoadSkillTool([makeSkill()])
    const out = await tool.execute({ name: 'a' })
    expect(out).toContain('<skill_content name="a">')
    expect(out).toContain('prompt-a')
    expect(out).toContain('</skill_content>')
  })

  it('未知名字 → 报错并列出可用名（模型可自我纠正）', async () => {
    const tool = createLoadSkillTool([makeSkill()])
    const out = await tool.execute({ name: 'nope' })
    expect(out).toContain('error')
    expect(out).toContain('a')
  })

  it('工具名与参数 schema 符合 AgentTool 契约', () => {
    const tool = createLoadSkillTool([makeSkill()])
    expect(tool.name).toBe('load_skill')
    expect(tool.parameters).toHaveProperty('properties.name')
  })
})

describe('collectSkillTools', () => {
  it('汇总所有 skills 的工具', () => {
    const s1 = makeSkill({ tools: [makeTool('t1')] })
    const s2 = makeSkill({ name: 'b', tools: [makeTool('t2')] })
    expect(collectSkillTools([s1, s2]).map(t => t.name)).toEqual(['t1', 't2'])
  })

  it('无工具返回空数组', () => {
    expect(collectSkillTools([makeSkill()])).toEqual([])
  })

  it('同名工具去重，保留先注册的', () => {
    const s1 = makeSkill({ tools: [makeTool('dup')] })
    const s2 = makeSkill({ name: 'b', tools: [makeTool('dup')] })
    expect(collectSkillTools([s1, s2]).map(t => t.name)).toEqual(['dup'])
  })
})

describe('builtinSkills 内置示例', () => {
  it('包含两种形态：code-review（带工具）+ react-style（纯指令）', () => {
    const skills = builtinSkills()
    const review = skills.find(s => s.name === 'code-review')
    const react = skills.find(s => s.name === 'react-style')
    expect(review?.tools?.some(t => t.name === 'review_file')).toBe(true)
    expect(react?.tools).toBeUndefined()
    expect(react?.prompt).toBeTruthy()
  })

  it('目录 + 加载链路连通：目录列出所有 skill，load_skill 能取到它们的指令', async () => {
    const skills = builtinSkills()
    const catalog = buildSkillCatalog(skills)
    const loader = createLoadSkillTool(skills)
    for (const s of skills) {
      expect(catalog).toContain(s.name)
      expect(await loader.execute({ name: s.name })).toContain(s.prompt)
    }
  })
})

describe('review_file 工具', () => {
  it('检出 TODO 与 console.log，无问题文件不误报', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'))
    try {
      const dirty = path.join(dir, 'dirty.ts')
      await fs.writeFile(dirty, 'const x = 1\n// TODO: fix this\nconsole.log(x)\n')
      const clean = path.join(dir, 'clean.ts')
      await fs.writeFile(clean, 'const y = 2\n')

      const tool = builtinSkills().find(s => s.name === 'code-review')!.tools!.find(t => t.name === 'review_file')!
      const dirtyResult = await tool.execute({ path: dirty })
      expect(dirtyResult).toContain('TODO')
      expect(dirtyResult).toContain('console.log')

      const cleanResult = await tool.execute({ path: clean })
      expect(cleanResult).toContain('未发现明显问题')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
