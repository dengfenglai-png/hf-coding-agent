// test/tools.test.ts
// 测试 4 个内置工具的核心功能。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { builtinTools, validateArgs, isDangerousCommand } from '../src/tools.js'
import type { AgentTool } from '../src/agent.js'

let tmpDir: string

beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanopi-test-')) })
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

function findTool(tools: AgentTool[], name: string): AgentTool {
  return tools.find(t => t.name === name)!
}

describe('builtinTools', () => {
  it('返回 7 个工具', () => {
    expect(builtinTools().map(t => t.name).sort()).toEqual(['edit', 'glob', 'grep', 'read_file', 'run_bash', 'todo_write', 'write_file'])
  })

  it('read_file 读取文件', async () => {
    const read = findTool(builtinTools(), 'read_file')
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')
    expect(await read.execute({ path: path.join(tmpDir, 'a.txt') })).toBe('hello')
  })

  it('write_file 写入文件', async () => {
    const write = findTool(builtinTools(), 'write_file')
    await write.execute({ path: path.join(tmpDir, 'b.txt'), content: 'world' })
    expect(await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('world')
  })

  it('edit 唯一匹配时替换成功', async () => {
    const edit = findTool(builtinTools(), 'edit')
    const filePath = path.join(tmpDir, 'e.txt')
    await fs.writeFile(filePath, 'foo bar baz')
    await edit.execute({ path: filePath, old_string: 'bar', new_string: 'BAR' })
    expect(await fs.readFile(filePath, 'utf-8')).toBe('foo BAR baz')
  })

  it('edit 匹配 0 处时报错', async () => {
    const edit = findTool(builtinTools(), 'edit')
    const filePath = path.join(tmpDir, 'e2.txt')
    await fs.writeFile(filePath, 'hello')
    await expect(edit.execute({ path: filePath, old_string: 'xyz', new_string: 'XYZ' })).rejects.toThrow('not found')
  })

  it('edit 匹配多处时报错', async () => {
    const edit = findTool(builtinTools(), 'edit')
    const filePath = path.join(tmpDir, 'e3.txt')
    await fs.writeFile(filePath, 'dup dup')
    await expect(edit.execute({ path: filePath, old_string: 'dup', new_string: 'X' })).rejects.toThrow('unique')
  })

  it('run_bash 执行命令', async () => {
    const bash = findTool(builtinTools(), 'run_bash')
    expect((await bash.execute({ command: 'echo hello' })).trim()).toBe('hello')
  })
})

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      count: { type: 'number' },
      verbose: { type: 'boolean' },
    },
    required: ['path'],
  }

  it('合法参数 → 空数组', () => {
    expect(validateArgs(schema, { path: '/tmp/a', count: 1, verbose: true })).toEqual([])
  })

  it('缺少 required → 违规', () => {
    expect(validateArgs(schema, { count: 1 })).toEqual(['missing required property "path"'])
  })

  it('类型错误 → 违规', () => {
    expect(validateArgs(schema, { path: 123 })).toEqual(['"path" must be a string'])
  })

  it('非对象 args → 违规', () => {
    expect(validateArgs(schema, 'not object')).toEqual(['expected an object'])
  })
})

describe('isDangerousCommand', () => {
  it('危险命令 → true', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true)
    expect(isDangerousCommand('rm -r node_modules')).toBe(true)
    expect(isDangerousCommand('rm --recursive dist')).toBe(true)
    expect(isDangerousCommand('git push --force origin main')).toBe(true)
    expect(isDangerousCommand('git push -f')).toBe(true)
    expect(isDangerousCommand('git reset --hard HEAD')).toBe(true)
    expect(isDangerousCommand('sudo rm file')).toBe(true)
    expect(isDangerousCommand('mkfs.ext4 /dev/sda')).toBe(true)
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true)
    expect(isDangerousCommand('reboot')).toBe(true)
  })

  it('安全命令 → false', () => {
    expect(isDangerousCommand('echo hello')).toBe(false)
    expect(isDangerousCommand('git status')).toBe(false)
    expect(isDangerousCommand('ls -la')).toBe(false)
    expect(isDangerousCommand('rm file.txt')).toBe(false) // 无递归标志，不算高危
  })
})

describe('glob 和 grep', () => {
  it('glob 匹配文件', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'x')
    await fs.writeFile(path.join(tmpDir, 'src', 'b.js'), 'y')
    const result = await findTool(builtinTools(), 'glob').execute({ pattern: '**/*.ts', path: tmpDir })
    expect(result).toContain('src/a.ts')
    expect(result).not.toContain('b.js')
  })

  it('grep 匹配内容', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello world\nfoo bar\n')
    const result = await findTool(builtinTools(), 'grep').execute({ pattern: 'hello', path: tmpDir })
    expect(result).toContain('a.txt:1:hello world')
  })

  it('grep 忽略 node_modules', async () => {
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'dep'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'dep', 'x.ts'), 'secret')
    await fs.writeFile(path.join(tmpDir, 'main.ts'), 'secret')
    const result = await findTool(builtinTools(), 'grep').execute({ pattern: 'secret', path: tmpDir })
    expect(result).toContain('main.ts')
    expect(result).not.toContain('node_modules')
  })
})

describe('todo_write', () => {
  it('格式化 todo 列表（4 种状态）', async () => {
    const result = await findTool(builtinTools(), 'todo_write').execute({
      todos: [
        { content: '重构 llm.ts', status: 'completed' },
        { content: '重构 agent.ts', status: 'in_progress' },
        { content: '写测试', status: 'pending' },
        { content: '修 bug', status: 'failed' },
      ],
    })
    expect(result).toContain('✓ 1. 重构 llm.ts')
    expect(result).toContain('▶ 2. 重构 agent.ts')
    expect(result).toContain('○ 3. 写测试')
    expect(result).toContain('✗ 4. 修 bug')
  })

  it('空列表 → no todos', async () => {
    const result = await findTool(builtinTools(), 'todo_write').execute({ todos: [] })
    expect(result).toBe('no todos')
  })
})
