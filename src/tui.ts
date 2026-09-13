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
      process.stdout.write(`\r${dimText(`${frame} ${this.spinnerLabel} ${secs}s`)}\x1b[K`)
    }, 80)
  }

  /** 清除状态行（无 spinner 时 no-op） */
  stopSpinner(): void {
    if (!this.spinnerTimer) return
    clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
    if (interactive) process.stdout.write('\r\x1b[K')
  }

  /** 流式打印 assistant 文本 delta */
  printText(delta: string): void {
    this.stopSpinner()
    process.stdout.write(delta)
  }

  /** 打印 tool 调用 */
  printToolCall(name: string, args: unknown): void {
    this.stopSpinner()
    process.stdout.write(`\n${dimText(`[tool: ${name}]`)} ${JSON.stringify(args)}\n`)
  }

  /** 打印 tool 结果 */
  printToolResult(name: string, result: string): void {
    this.stopSpinner()
    process.stdout.write(`${dimText(`[result: ${name}]`)} ${result}\n`)
  }

  /** 回合结束：换行 */
  printTurnEnd(): void {
    process.stdout.write('\n')
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
    process.stdout.write('\x1b[2J\x1b[H')
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
