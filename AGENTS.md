# 开发规则

> 本文件记录 pi-from-scratch 的演进方向与开发约定，让 AI 每次完成需求更符合预期。规则随项目推进持续补充，修改后请更新本文件。

# 开发方式（已确认）

**边讲解边写**：每次先定思路与框架，再拆成一个个小功能逐个实现；实现每个小功能之前先讲解并与开发者沟通对齐，确认后再动手。

- **先定思路与框架**：动手前先讲清楚整体设计和阶段框架，与开发者对齐。
- **小步实现**：把大需求拆成一个个小功能，逐个实现，不一次性铺开。
- **实现前先沟通**：每个小功能实现之前，先讲解思路并与开发者沟通，确认后再写代码。
- **方案入档**：每次与用户沟通确认方案后、动手写代码前，把方案写入 `docs/答疑日志.md`，格式为「问题 + 方案」，便于日后复习。

# 参考项目

实现每个新功能前，先分析以下项目的对应实现，再给出适配 pi-from-scratch 的方案，不要凭直觉直接写。

| 项目 | 路径 | 参考价值 |
|------|------|---------|
| pi | `/Users/hefeng/Desktop/vibe code/pi/` | Pi Agent Harness —— pi-from-scratch 的**完整版/目标形态**（教学版就是从它精简的）；参考 agent runtime（工具调用+状态管理）、多 provider LLM、TUI、协议等 |
| orca | `/Users/hefeng/Desktop/vibe code/orca/` | 多 agent 编排器（Electron）；参考架构、编排、代码风格与规范文档（AGENTS/STYLEGUIDE） |
| deepseek-harness | `/Users/hefeng/Desktop/vibe code/deepseek harness/` | 插件式 agent harness（Cordis）；参考 token 估算（token-meter）、上下文压缩（compaction）、工具系统、能力 seam 等核心实现 |

# 项目方向

## 目标

把 `pi-from-scratch`（从零手撕的极简 agent 框架）逐步演进成像 orca 一样的大型 agent 项目。

## 演进路线（已确认）

**先深后编** —— 先把单个 agent（Pi）做深做全，成熟后再往上叠加多 agent 编排层。

| 阶段 | 主题 | 关键内容 | 主要落点 |
|------|------|---------|---------|
| P1 | 上下文管理 | token 估算、cut point 边界、split turn | `agent.ts` / `llm.ts` |
| P2 | 工具系统 | 并行执行、args 校验、权限审批 | `tools.ts` / `agent.ts` |
| P3 | 工程地基 | 单元测试、重试退避、配置系统 | `test/` / `cli.ts` |
| P4 | 交互体验 | markdown 渲染、语法高亮、历史记录 | `tui.ts` |
| P5 | 生态扩展 | MCP、插件工具、StreamFn 注入 | `llm.ts` / 新增模块 |
| P6 | 编排层 | 多 agent 并行、worktree 隔离、分屏 | 新增模块 |

# 代码风格

## 只写简洁/简短的非显而易见注释

- **不要**：啰嗦冗长、解释显而易见的代码、逐行走读代码。
- **要**：写"为什么"，而不是"是什么"。能用一行写清楚就只用一行。

## 文件和模块命名

永远不要对文件、文件夹或模块使用模糊名称，例如 `helpers`、`utils`、`common`、`misc`。这些名称不携带信息，容易变成杂物堆。用文件**实际包含的内容**命名，优先具体的领域概念（如 `session-persistence.ts`），而不是泛化的角色名。

## 类型声明：优先 `.ts` 而不是 `.d.ts`

## 保持极简，只做必要的事

不引入不必要的框架与抽象。TUI 不做 differential renderer、component 树、markdown 渲染——这些是"终端 UI 框架"的功课，不是"手撕 agent"的灵魂。只做 agent 本质需要的东西。

## 可读性优先于抽象

让学习者一眼看到核心交互点（如 `agent.ts` 直接 import `stream` 而非依赖注入）。当抽象与可读性冲突时，选可读性；等真正需要时再抽象。

# 架构约定

## 事实来源（模块职责）

| 模块 | 职责 |
|------|------|
| `src/llm.ts` | 统一 LLM API：OpenAI 兼容 SSE → 四种事件流（text_delta / tool_call / done / error） |
| `src/agent.ts` | Agent loop：while 循环 + 工具调用 + 上下文压缩（项目灵魂） |
| `src/tui.ts` | 极简终端界面：单行输入 + 流式输出 + Ctrl+C |
| `src/tools.ts` | 内置工具（纯函数，不碰 agent 状态） |
| `src/skills.ts` | Skill 机制：name/description 目录进 system prompt，模型用 load_skill 按需加载指令（纯函数） |
| `src/cli.ts` | 拼装层 + session 持久化（唯一入口） |

## 核心机制

LLM 流式回复 → 有 `tool_call` 就执行 → 结果放回 Context → 继续流式，直到模型不再调工具（`end_turn` / `max_tokens`）或被中断（`aborted` / `error`）。

# 注意事项

## tool_call / tool_result 配对

每个 `tool_call` 必须有对应的 `tool_result`，否则 session 恢复后 API 报 400。abort 时丢弃未完成的 tool_calls，并为被跳过的补上 error 结果。

## session 持久化

`~/.nanopi/session.jsonl`，逐行容错：跳过损坏行而非丢弃全部历史（进程崩溃可能写出半行 JSON）。

## 上下文压缩安全

压缩失败时不替换 context——保留原始消息比空摘要更安全。abort 时不压缩，避免空摘要损坏 context。
