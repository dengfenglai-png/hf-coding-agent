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

  it('interactive 下超长 tool_result 显示层截断（头 2 + 提示 + 尾 1）', () => {
    setInteractive(true)
    const tui = new Tui()
    const result = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
    tui.printToolResult('read_file', result)
    const out = writes.join('')
    expect(out).toContain('line1')
    expect(out).toContain('line2')
    expect(out).toContain('已折叠 7 行')
    expect(out).toContain('line10')
    expect(out).not.toContain('line5')  // 中间行不显示

    writes = []
    tui.printToolResult('read_file', 'short')  // 短结果不截断
    expect(writes.join('')).toContain('short')
    expect(writes.join('')).not.toContain('已折叠')
  })

  it('非 interactive 下 tool_result 直出完整内容', () => {
    setInteractive(false)
    const tui = new Tui()
    const result = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
    tui.printToolResult('read_file', result)
    expect(writes.join('')).toContain('line5')
    expect(writes.join('')).not.toContain('已折叠')
  })

  it('foldTurn：≥3 个工具调用时区域收成一行摘要（上移 + 重写 + DL 删行）', () => {
    vi.useFakeTimers()
    setInteractive(true)
    const tui = new Tui()
    tui.printText('思考中…\n')
    for (let i = 0; i < 3; i++) {
      tui.printToolCall('read_file', { path: `f${i}.txt` })
      tui.printToolResult('read_file', `内容${i}\n第二行`)
    }
    tui.printText('最终回答\n')
    writes = []
    tui.foldTurn()
    const out = writes.join('')
    // 区域 = 3×(call 标签+前置空行) + 3×(2 行 result)，含 call 间空行共 11 行；
    // delta 12 = 区域 11 行 + 下方「最终回答」1 行
    expect(out).toContain('\x1b[12A')
    expect(out).toContain('⋮ 已折叠 3 个工具调用（read_file×3）')
    expect(out).toContain('\x1b[10M')     // 删除摘要行之外的 10 行旧区域，下方内容上移
  })

  it('foldTurn：事件不足 3 个时不折叠', () => {
    setInteractive(true)
    const tui = new Tui()
    tui.printToolCall('read_file', { path: 'a.txt' })
    tui.printToolResult('read_file', 'hi')
    writes = []
    tui.foldTurn()
    expect(writes).toEqual([])
  })

  it('foldTurn：非 interactive 时 no-op', () => {
    setInteractive(false)
    const tui = new Tui()
    for (let i = 0; i < 3; i++) {
      tui.printToolCall('grep', { pattern: 'x' })
      tui.printToolResult('grep', 'm1\nm2')
    }
    writes = []
    tui.foldTurn()
    expect(writes).toEqual([])
  })

  it('setBusy(true) 重置折叠状态：新回合重新计数', () => {
    setInteractive(true)
    const tui = new Tui()
    tui.setBusy(true)
    for (let i = 0; i < 3; i++) {
      tui.printToolCall('grep', { pattern: 'x' })
      tui.printToolResult('grep', 'm')
    }
    tui.foldTurn()  // 本轮折叠发生
    tui.setBusy(false)

    tui.setBusy(true)  // 新回合：折叠状态已重置，不会把旧区域二次折叠
    tui.printToolCall('grep', { pattern: 'y' })
    writes = []
    tui.foldTurn()  // 只有 1 个事件 → 不折叠
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
