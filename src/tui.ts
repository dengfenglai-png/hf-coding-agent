// src/tui.ts
// 极简终端界面 —— 单行输入 + 流式输出 + Ctrl+C 打断。
// 不做 differential renderer、不做 component 树、不做 markdown 渲染。
// 这些是"终端 UI 框架"的功课，不是"手撕 agent"的灵魂。

import * as readline from 'readline'

// ===== 终端交互能力 =====
// interactive 控制"原地更新"类效果（颜色 / spinner）。TTY 且未设 NO_COLOR 时开启，
// 管道/重定向输出保持纯文本（日志与测试友好）。测试用 setInteractive 手动切换。

let interactive = !!process.stdout.isTTY && !process.env.NO_COLOR

/** 测试与 NO_COLOR 场景的开关（导出供测试） */
export function setInteractive(v: boolean): void {
  interactive = v
}

/** 暗色强调（导出供测试） */
export function dimText(s: string): string {
  return interactive ? `\x1b[2m${s}\x1b[0m` : s
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** tool_result 显示上限：超过则头 2 行 + 折叠提示 + 尾 1 行（错误在尾部，保留） */
const RESULT_DISPLAY_LINES = 4

/** 显示层折叠：长工具结果收成头尾 + 提示行（完整内容仍进 context / session） */
function foldLongResult(result: string): string {
  const lines = result.split('\n')
  if (lines.length <= RESULT_DISPLAY_LINES + 1) return result
  const hidden = lines.length - 3
  return [...lines.slice(0, 2), dimText(`… 已折叠 ${hidden} 行`), lines[lines.length - 1]].join('\n')
}

export class Tui {
  private rl: readline.Interface | null = null
  private onPromptCb: ((text: string) => void) | null = null
  private onAbortCb: (() => void) | null = null
  private onQuitCb: (() => void) | null = null
  private aborted = false
  private busy = false  // agent 运行中时为 true，阻止并发输入
  private closed = false  // stdin 关闭（EOF/管道耗尽）后为 true，禁止再 prompt
  private spinnerTimer: NodeJS.Timeout | null = null
  private spinnerLabel = ''
  private spinnerStart = 0

  // ===== 回合末工具区折叠 =====
  // lineNo = 已写入的 \n 总数（当前行号，0 基）。折叠用相对 delta 定位，
  // 不受 readline 提示行/长输入换行影响；状态在 setBusy(true) 与 /clear 时重置。
  private lineNo = 0
  private foldStart: number | null = null  // 本轮首个 tool_call 标签所在行
  private foldEnd = 0                      // 区域结束行（半开区间 [foldStart, foldEnd)）
  private toolKinds = new Map<string, number>()
  private folded = false

  /** 所有显示写入的统一出口：附带 \n 行号计数，供折叠做光标定位 */
  private write(s: string): void {
    process.stdout.write(s)
    this.lineNo += (s.match(/\n/g) ?? []).length
  }

  private resetFoldState(): void {
    this.foldStart = null
    this.foldEnd = 0
    this.toolKinds.clear()
  }

  /** 注册 prompt 回调 */
  onPrompt(cb: (text: string) => void): void {
    this.onPromptCb = cb
  }

  /** 注册 Ctrl+C 中断回调（agent 运行中） */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb
  }

  /** 注册退出回调：空闲 Ctrl+C / Ctrl+D / stdin 关闭时触发 */
  onQuit(cb: () => void): void {
    this.onQuitCb = cb
  }

  /** 启动 TUI，开始读输入 */
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    this.rl.on('close', () => {
      this.closed = true
      if (!this.busy) this.onQuitCb?.()  // EOF（Ctrl+D / 管道耗尽）空闲时 = 退出
    })
    // 注册了 SIGINT 监听后，readline 不再默认关闭，Ctrl+C 语义由这里定义
    this.rl.on('SIGINT', () => {
      if (!this.busy) this.onQuitCb?.()  // 空闲 Ctrl+C = 退出；busy 时 abort 由 keypress 处理
    })
    process.stdin.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
      if (this.busy && key?.ctrl && key?.name === 'c') {
        if (!this.aborted) {
          this.aborted = true
          this.onAbortCb?.()  // 第一次：中断当前回合
        } else {
          this.onQuitCb?.()   // 已中断再按 = 强制退出
        }
      }
    })

    this.prompt()
  }
  private prompt(): void {
    if (!this.rl) return
    if (this.closed) return  // stdin 已关闭（如管道输入耗尽），静默退出重提示循环，事件循环自然排空
    if (this.busy) return  // agent 运行中，不显示 prompt
    this.aborted = false
    this.rl.question('> ', (answer) => {
      const text = answer.trim()
      if (text) {
        this.onPromptCb?.(text)
        // 不立即递归 prompt()——等 setBusy(false) 时再调
      } else {
        this.prompt()  // 空输入：重新提示，不触发回调
      }
    })
  }

  /** agent 开始运行时调用，阻止新输入 */
  setBusy(busy: boolean): void {
    this.busy = busy
    if (busy) {
      this.resetFoldState()
      this.folded = false
    }
    if (!busy) this.prompt()  // agent 结束，恢复输入
  }

  /**
   * 状态行：单行 \r 覆写 spinner + 阶段文案 + 已耗时（thinking… / tool: grep）。
   * 非 interactive（管道/测试）时什么都不写，保持输出干净；首个输出事件会清掉状态行。
   */
  startSpinner(label: string): void {
    this.stopSpinner()
    this.spinnerLabel = label
    this.spinnerStart = Date.now()
    if (!interactive) return
    let i = 0
    this.spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]
      const secs = ((Date.now() - this.spinnerStart) / 1000).toFixed(0)
      this.write(`\r${dimText(`${frame} ${this.spinnerLabel} ${secs}s`)}\x1b[K`)
    }, 80)
  }

  /** 清除状态行（无 spinner 时 no-op） */
  stopSpinner(): void {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
    if (interactive) this.write('\r\x1b[K')
  }

  /** 流式打印 assistant 文本 delta */
  printText(delta: string): void {
    this.stopSpinner()
    this.write(delta)
  }

  /** 打印 tool 调用 */
  printToolCall(name: string, args: unknown): void {
    this.stopSpinner()
    this.write('\n')
    if (this.foldStart === null) this.foldStart = this.lineNo  // 标签所在行
    this.write(`${dimText(`[tool: ${name}]`)} ${JSON.stringify(args)}\n`)
    this.foldEnd = this.lineNo
    this.toolKinds.set(name, (this.toolKinds.get(name) ?? 0) + 1)
  }

  /** 打印 tool 结果（显示层超长截断，进 context 的完整内容不受影响） */
  printToolResult(name: string, result: string): void {
    this.stopSpinner()
    this.write(`${dimText(`[result: ${name}]`)} ${interactive ? foldLongResult(result) : result}\n`)
    this.foldEnd = this.lineNo
  }

  /**
   * 回合末折叠：把本轮 [首个 tool_call 行, 最后 tool_result 行) 区域收成一行摘要。
   * 光标上移到区域首行 → 重写摘要行 → DL 删除剩余区域行（下方内容自动上移）。
   * 事件过少或区域已滚出屏幕则放弃折叠（输出保持原样），非 interactive 时 no-op。
   */
  foldTurn(): void {
    if (!interactive || this.folded || this.foldStart === null) { this.resetFoldState(); return }
    const region = this.foldEnd - this.foldStart
    const delta = this.lineNo - this.foldStart
    const rows = process.stdout.rows || 24  // 无尺寸 pty（CI/script）报 0，需兜底
    const totalCalls = [...this.toolKinds.values()].reduce((a, b) => a + b, 0)
    if (totalCalls < 3 || region < 4 || delta > rows - 2) { this.resetFoldState(); return }

    const summary = [...this.toolKinds.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ')
    this.write(`\x1b[${delta}A`)  // 光标回到区域首行
    this.write(dimText(`⋮ 已折叠 ${totalCalls} 个工具调用（${summary}）`) + '\n')
    this.write(`\x1b[${region - 1}M`)  // 删除剩余旧区域行，下方内容上移
    this.lineNo -= region - 1
    this.resetFoldState()
    this.folded = true
  }

  /** 回合结束：换行 */
  printTurnEnd(): void {
    this.write('\n')
  }

  /** 询问用户是否允许执行某操作（审批），返回 true/false；无法询问时返回 false（fail-closed） */
  async askApproval(prompt: string): Promise<boolean> {
    if (!this.rl || this.closed) return false
    this.stopSpinner()  // 状态行会跟审批问题叠在同一行，先清掉
    return new Promise((resolve) => {
      this.rl!.question(prompt, (answer) => resolve(parseApprovalAnswer(answer)))
    })
  }

  /** 清屏并把光标归位 */
  clearScreen(): void {
    this.write('\x1b[2J\x1b[H')
    this.lineNo = 0
    this.resetFoldState()
    this.folded = false
  }

  /** 停止 TUI，清理监听器 */
  stop(): void {
    this.rl?.close()
    this.rl = null
    process.stdin.removeAllListeners('keypress')
  }
}

/** 解析审批回答：y / yes → true，其余 → false（默认拒绝） */
export function parseApprovalAnswer(answer: string): boolean {
  const a = answer.trim().toLowerCase()
  return a === 'y' || a === 'yes'
}

/** 解析 slash 命令：'/help foo' → '/help'；非 '/' 开头返回 null（导出供测试） */
export function parseSlashCommand(text: string): string | null {
  const m = /^\/(\S+)/.exec(text.trim())
  return m ? `/${m[1]}` : null
}
