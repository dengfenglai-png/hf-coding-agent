// test/tui.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Tui, parseApprovalAnswer, parseSlashCommand, setInteractive, dimText } from '../src/tui.js'

describe('Tui', () => {
  let writes: string[]
  let origWrite: typeof process.stdout.write

  beforeEach(() => {
    writes = []
    origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = origWrite
    setInteractive(false)
    vi.useRealTimers()
  })

  it('printText 流式追加', () => {
    const tui = new Tui()
    tui.printText('Hel')
    tui.printText('lo')
    expect(writes).toEqual(['Hel', 'lo'])
  })

  it('printToolCall 格式化工具调用', () => {
    const tui = new Tui()
    tui.printToolCall('read_file', { path: 'a.txt' })
    const out = writes.join('')
    expect(out).toContain('[tool: read_file]')
    expect(out).toContain('a.txt')
  })

  it('printToolResult 格式化工具结果', () => {
    const tui = new Tui()
    tui.printToolResult('read_file', 'hello')
    const out = writes.join('')
    expect(out).toContain('[result: read_file]')
    expect(out).toContain('hello')
  })

  it('printTurnEnd 输出换行', () => {
    const tui = new Tui()
    tui.printTurnEnd()
    expect(writes).toEqual(['\n'])
  })
})

describe('spinner 与颜色', () => {
  let writes: string[]
  let origWrite: typeof process.stdout.write

  beforeEach(() => {
    writes = []
    origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = origWrite
    setInteractive(false)
    vi.useRealTimers()
  })

  it('interactive：spinner 周期刷新，首个输出清行', () => {
    vi.useFakeTimers()
    setInteractive(true)
    const tui = new Tui()
    tui.startSpinner('thinking…')
    vi.advanceTimersByTime(200)
    expect(writes.join('')).toContain('thinking…')
    expect(writes.join('')).toContain('\x1b[K')   // 状态行带清行控制

    writes = []
    tui.printText('hi')                           // 首个 delta 清掉状态行
    expect(writes[0]).toBe('\r\x1b[K')
    expect(writes[1]).toBe('hi')

    tui.printText('!')                            // 后续 delta 不再重复清行
    expect(writes[2]).toBe('!')
  })

  it('非 interactive：spinner 不写任何字符，输出纯文本', () => {
    setInteractive(false)
    const tui = new Tui()
    tui.startSpinner('thinking…')
    expect(writes).toEqual([])

    tui.printToolCall('grep', { pattern: 'x' })
    const out = writes.join('')
    expect(out).toContain('[tool: grep]')
    expect(out).not.toContain('\x1b[')            // 无 ANSI 码
  })

  it('dimText 按 interactive 开关切换', () => {
    setInteractive(true)
    expect(dimText('x')).toBe('\x1b[2mx\x1b[0m')
    setInteractive(false)
    expect(dimText('x')).toBe('x')
  })

  it('stopSpinner 无 spinner 时 no-op', () => {
    setInteractive(true)
    const tui = new Tui()
    tui.stopSpinner()
    expect(writes).toEqual([])
  })
})

describe('parseSlashCommand', () => {
  it('/ 开头 → 提取命令 token', () => {
    expect(parseSlashCommand('/help')).toBe('/help')
    expect(parseSlashCommand('/model glm-5.2')).toBe('/model')
    expect(parseSlashCommand('  /exit  ')).toBe('/exit')
    expect(parseSlashCommand('/quit')).toBe('/quit')
  })

  it('非 / 开头 → null（进 agent）', () => {
    expect(parseSlashCommand('帮我写个函数')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()  // 裸斜杠不算命令
  })
})

describe('parseApprovalAnswer', () => {
  it('y / yes / 大写 / 带空格 → true', () => {
    expect(parseApprovalAnswer('y')).toBe(true)
    expect(parseApprovalAnswer('yes')).toBe(true)
    expect(parseApprovalAnswer('Y')).toBe(true)
    expect(parseApprovalAnswer(' y ')).toBe(true)
  })

  it('n / no / 空 / 其他 → false', () => {
    expect(parseApprovalAnswer('n')).toBe(false)
    expect(parseApprovalAnswer('no')).toBe(false)
    expect(parseApprovalAnswer('')).toBe(false)
    expect(parseApprovalAnswer('abc')).toBe(false)
  })
})
