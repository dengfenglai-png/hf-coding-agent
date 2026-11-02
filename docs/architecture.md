# 架构

> 本文描述**当前**架构与模块职责，配 [roadmap.md](roadmap.md) 的目标形态阅读。架构变化先改代码、同步改本文。

## 一句话

控制面（agent loop + 状态 + 密钥）目前与执行面（工具执行）同进程同权限，跑在用户宿主机上；演进方向是把两者用 `ExecutionBackend` seam 拆开（见下文「目标形态」）。

## 模块职责（事实来源）

| 模块 | 职责 | 关键点 |
|------|------|--------|
| `src/llm.ts` | 统一 LLM API：OpenAI 兼容 SSE → 四种事件流（text_delta / tool_call / done / error） | 重试退避（429/5xx 指数退避）；配额类错误 fail-fast（含中文模式） |
| `src/anthropic.ts` | Anthropic Messages 协议适配 | 与 llm.ts 同一事件流形状，按 preset 协议选择 |
| `src/providers.ts` | provider 预设表 | id → baseUrl + 默认模型 + 协议；`DEFAULT_PROVIDER = zhipu` |
| `src/agent.ts` | Agent loop：while 循环 + 工具执行 + 上下文压缩 | 项目灵魂。事件流出：assistant_text / tool_call / tool_result / turn_end |
| `src/context-management.ts` | token 估算、安全切点、摘要压缩、循环检测 | 压缩失败不替换 context；abort 时不压缩 |
| `src/tools.ts` | 7 个内置工具（纯函数，不碰 agent 状态） | write_file / edit / run_bash 标记 `exclusive`；run_bash 危险命令需审批 |
| `src/skills.ts` | Skill 机制：目录常驻 system prompt，`load_skill` 按需加载 | 纯函数 |
| `src/mcp.ts` | MCP client：手写 JSON-RPC 2.0 over stdio（零依赖） | spawn 子进程，工具包装成 AgentTool |
| `src/tui.ts` | 终端界面：单行输入 + 流式输出 + spinner + 回合末折叠 | 纯显示层；非 interactive 全部 no-op |
| `src/cli.ts` | 拼装层 + session 持久化 + 配置（唯一入口） | key 三级来源、按项目目录隔离 session、审批/拦截/脱敏 hook |

## 数据流

```text
用户输入（TUI prompt）
  │
  ▼
Agent loop（agent.ts）──────── while 循环，直到 end_turn / max_tokens / abort
  │
  ├─▶ context.messages ──▶ stream(model, context)      ← StreamFn seam（llm.ts 或 anthropic.ts）
  │                            │ SSE 事件流
  │                            ▼
  │                       text_delta ──▶ TUI 流式输出
  │                       tool_call  ──▶ 校验 args → 审批? → 敏感文件拦截? → 执行
  │                            │                          （并行组：exclusive 串行，其余并行）
  │                            ▼
  ├─◀────────────────── tool_result 放回 context ──▶ 下一轮循环
  │
  └─ turn_end ──▶ persistSession（append JSONL，~/.nanopi/projects/<slug>/）
```

## 现有 seams（复用点）

1. **`StreamFn`**：`(model, context, opts) => AsyncIterable<Event>`。provider 协议差异（OpenAI 兼容 / Anthropic）与包装层（401/403 友好化）都注入在这条边界上，`agent.ts` 不知道背后是谁。
2. **工具hook**：`approve`（审批）、`beforeToolCall`（拦截，如敏感文件正则）、`afterToolCall`（脱敏，如 `sk-*` 打码）、`shouldStopAfterTurn`、`detectLoop`——CLI 在拼装层注入策略，agent 只认协议。

## 状态与恢复

- **context 是唯一状态**：agent 本身无状态，`context.messages` 即一切。
- **session 持久化**：每轮结束 append 新增 messages 到 `~/.nanopi/projects/<目录 slug>/session-<ts>.jsonl`；逐行容错（跳过损坏行）；`-c` 续接最近文件。
- **abort 安全**：丢弃未完成 tool_calls 并为被跳过的补 error result，保证恢复后 tool_call/result 配对完整（API 不报 400）。
- **已知缺口**：session 只存 messages，kill -9 后无法恢复到"最后一个完整 tool result"之后的精确状态 → P1 RunEvent 事件日志解决。

## 目标形态（P1 / P2 落成后）

```text
可信控制面（本进程）
  CLI / TUI ── Agent loop ── RunEvent log（P1：append-only，context = 重放投影）
  API key / credential policy（P4）
          │ ToolRequest / ToolResult   ← ExecutionBackend seam（P2）
          ▼
不可信执行面
  LocalBackend（现状行为，标注 unsafe-local）
  DockerBackend（P3：临时 workspace + 资源/网络限制）
  MicroVMBackend（远期）
```

详细阶段拆分与验收标准见 [roadmap.md](roadmap.md)；信任边界的威胁分析见 [threat-model.md](threat-model.md)。
