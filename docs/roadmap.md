# hf-coding-agent 路线图（P0–P8）

> 本文是项目演进的**唯一事实来源**（AGENTS.md 只留摘要指针）。2026-11-01 与开发者确认定稿，随推进持续更新：完成一项就勾一项，顺序调整需先在此记录理由。

## 定位

> **从零构建一个本地优先、可逐步演进为安全执行平台的开源 Coding Agent Harness。**

- 本地优先：今天的默认体验是"cd 进任意目录、`hf-coding-agent` 直接干活"，这一点永远不丢。
- 可演进为安全执行平台：执行环境与可信控制面之间有明确的信任边界，边界可以逐步收紧，而不需要重写。
- 教程出身，工程长成：本项目是 [SaladDay/pi-from-scratch](https://github.com/SaladDay/pi-from-scratch)（MIT）的衍生，保留上游完整历史与教程章节（`docs/ch0*.md`、`web/`、`slides/`），在其基础上向工程级 harness 演进。P0 会修正仓库身份并正面声明这层关系。

## 核心原则

**每新增一个能力，先写清三件事：它跨过了哪个信任边界、失败后状态如何恢复、怎样被测试和观测。**

写不清就不动手。这比快速堆 30 个工具更接近"掌握 agent harness 完整技术栈"的目标。

其余沿用 AGENTS.md 既有约定：小步实现、每小步可独立提交且测试全绿、可读性优先于抽象。抽象只在出现第二个真实使用者时引入——`StreamFn` 是第一个 seam，本路线的 `ExecutionBackend`（P2）是第二个。

## 信任边界总图（P2 落成后的目标形态）

```text
可信控制面（你的机器、你的密钥）
  CLI / TUI
  Agent loop
  RunEvent log（P1：append-only 事件日志）
  API key / credential policy（P4：凭据不越过边界）
          │ ToolRequest / ToolResult
          ▼
不可信执行面（模型能触达的一切）
  LocalBackend      —— 现状直跑宿主机，显式标注 unsafe-local（P2）
  DockerBackend     —— 临时 workspace + 资源/网络限制（P3）
  MicroVMBackend    —— gVisor/Firecracker，远期 Linux 目标（P3+）
```

原则：执行环境里**永远看不到真实 key**；网络由可信侧代理并按目标域注入受限凭据（P4）；安全不依赖"模型不会泄漏"的假设。

## 现状对账（2026-11）

已有：agent loop + 流式双协议（OpenAI/Anthropic）、工具并行/审批/超时/敏感文件拦截、上下文估算 + 安全切点压缩 + 循环检测、provider 预设 + 三级 key 来源、MCP、skills、TUI（spinner/折叠）、项目级 session JSONL、122 个单测、`scripts/generate-traces.ts`（fixture 跑 `runAgent` 产出步骤化 trace——P2/P5 的现成地基）。

关键缺口：`run_bash` 与文件工具**直接操作宿主机**（无信任边界）；session 只存 messages（kill 后无法恢复到完整工具状态）；无 CI、无安全披露渠道；仓库身份仍指上游。

旧演进路线（AGENTS.md 原 P1–P6）→ 新路线映射：旧 P1/P2/P3 已完成；旧 P4 剩余项（markdown 渲染/语法高亮）**降级为可选**（原帖判断"不要先做花哨 TUI"，认同）；旧 P5 剩余插件机制并入 P2/P5；旧 P6 编排 → 新 P7。

## 阶段总览

| 阶段 | 主题 | 关键技术 | 交付能力 |
|------|------|---------|---------|
| **P0** | 开源地基 | 版本化、CI、安全披露、贡献协作 | 仓库身份修正、Actions、SECURITY/CONTRIBUTING/架构文档 |
| **P1** | 事件与可恢复状态 | Event sourcing、schema version、snapshot/replay | append-only RunEvent 日志；崩溃恢复、重放、trace 可视化 |
| **P2** | 脑手分离 | Ports/adapters、进程生命周期 | `ExecutionBackend` seam；local 标注 unsafe-local；fake backend 可测 |
| **P3** | Sandbox 与策略 | 容器、cgroup、网络 egress、只读挂载 | 临时 workspace、CPU/内存/时间限制、进程树 kill、默认拒绝网络 |
| **P4** | 密钥与权限 | least privilege、credential proxy、policy engine | key 不进执行环境；能力授权替代正则黑名单 |
| **P5** | 可观测与评测 | trace、metrics、cost、evals | 每次调用有 run ID/耗时/token/成本/失败原因；可回归任务集 |
| **P6** | 长程任务 | artifact spill、memory、tokenizer | 大输出落外部 artifact；真实 tokenizer 计量；恢复不丢工具状态 |
| **P7** | 多 agent | worktree、任务图、租约、结构化交接 | lead 拆任务、子 agent 隔离工作、明确冲突策略 |
| **P8** | 远程平台 | service、queue、worker、多租户 | 控制面上服务端、worker 只执行；排队/重试/恢复/限额/审计 |

**关键路径：P0 → P1 → P2 → P3**，P4 与 P3 并行。P1 排在 P2 前：P2 的验收标准（local 与 fake backend 跑出**等价 event log**）以 P1 的事件日志为前提，且崩溃恢复独立有价值。

---

## P0：开源地基

**小步拆分**（每步可独立提交）：

- [ ] **P0-1 身份修正**：`package.json` name/description/keywords/repository 改为 `hf-coding-agent` / `dengfenglai-png/hf-coding-agent`；README 改题为 hf-coding-agent，加定位段与上游 fork 声明（保留 MIT attribution 与 Thanks 章节）
- [ ] **P0-2 CI**：GitHub Actions——Node 20/22 矩阵跑 `tsc --noEmit` + `vitest run`
- [ ] **P0-3 SECURITY.md**：漏洞报告渠道；**明确声明 local backend 不构成隔离**，勿在不可信输入下使用
- [ ] **P0-4 CONTRIBUTING.md**：小步提交约定、测试要求、答疑日志入档规则
- [ ] **P0-5 docs/architecture.md + docs/threat-model.md 骨架**：信任边界图（上文）；不可信输入清单、有副作用工具清单、暂不解决的风险清单

**验收**：CI 在 push/PR 上绿；GitHub 仓库页能看清 hf-coding-agent 身份与上游关系；`npm pack` 的包名正确。

## P1：事件与可恢复状态

**思路**：从"只存 messages 的 JSONL"升级为 append-only `RunEvent` 日志。事件即事实：`turn_started / text_delta(聚合) / tool_call / tool_result / turn_end / error / checkpoint`，带 `schema_version`。context 是事件重放的投影——重放 = 重建，恢复 = 重放到最后一个完整 tool_result。

**小步拆分**：

- [ ] **P1-1 RunEvent schema + 双写**：新事件日志与现有 session JSONL 并行写，互不破坏；`schema_version` 字段先行
- [ ] **P1-2 崩溃恢复**：启动时重放事件日志到最后一个完整 tool_result；悬空 tool_call 补 error result（复用现有 abort 配对逻辑）
- [ ] **P1-3 重放重建**：从事件流重建 context，替代 messages 加载（`-c` 语义不变）
- [ ] **P1-4 trace 可视化**：复用 `generate-traces.ts` 的 TraceStep 形态，从真实 RunEvent 导出可浏览 trace

**验收**：`kill -9` 一个执行到一半的回合，重启 `-c` 后 agent 能继续该回合且 API 不报 400（tool_call/result 配对完整）；固定 fixture 事件流重放出字节级一致的 context。

## P2：脑手分离（最重要的架构跃迁）

**思路**：`AgentTool.execute` 背后的执行拆为 `ExecutionBackend` seam。`agent.ts` 不再知道 shell 在哪里跑；文件工具与 `run_bash` 走同一 ToolRequest/ToolResult 协议。

```text
ExecutionBackend {
  exec(req: ToolRequest, signal): Promise<ToolResult>
  // LocalBackend：现状行为（child_process + fs），名字与输出显式标注 unsafe-local
  // FakeBackend：确定性实现，测试与 evals 用
  // DockerBackend：P3 落点
}
```

动手前按仓库规则先调研三个参考项目：`pi`（agent runtime 的工具执行层）、`deepseek-harness`（能力 seam）、`orca`（进程/编排生命周期），产出接口与文件拆分设计后再写码。

**小步拆分**：

- [ ] **P2-1 接口 + LocalBackend 抽取**：纯搬运不改行为，122 个测试全绿
- [ ] **P2-2 FakeBackend + 等价性测试**：同一任务、同一 LLM fixture，local 与 fake 产出等价 event log
- [ ] **P2-3 MCP 归位**：MCP server 属可信控制面的本地扩展，在 threat-model 里写明（暂不进 sandbox）

**验收**：`agent.ts` 不再 import `child_process`；等价 event log 测试通过；欢迎横幅在 local 模式显示 `unsafe-local` 标注。

## P3：Sandbox 与策略

**平台现实**（写清，不做错配的承诺）：开发机是 macOS——Docker Desktop/colima 本身就是 VM；gVisor/Firecracker 是 Linux-only。因此：**行为以 Docker 容器定义**（mac 上验证、CI 的 Linux runner 上跑测试），MicroVM 是远期 Linux 目标；macOS `sandbox-exec` 已 deprecated，仅作参考不作依赖。

**小步拆分**：

- [ ] **P3-1 DockerBackend**：一次性临时 workspace、超时、进程树 kill（不留孤儿）
- [ ] **P3-2 资源限制**：CPU/内存/时间上限
- [ ] **P3-3 网络策略**：默认拒绝，白名单经可信侧 egress 代理
- [ ] **P3-4 只读挂载**：源码只读进容器，写操作只落 workspace；`~/.nanopi`、`~/.ssh` 永不挂载

**验收**：sandbox 内 `cat ~/.nanopi/config.json` 失败；禁网时 `curl` 失败；超时任务的子进程全部消失；`DockerBackend` 与 `LocalBackend` 通过同一等价 event log 测试。

## P4：密钥与权限（与 P3 并行）

**思路**：现在 key 只活在控制面进程（已对），但正则黑名单（`rm -rf`、敏感文件名）是启发式不是策略。升级为能力授权：工具×参数 → allow/deny/ask 的显式策略表。

**小步拆分**：

- [ ] **P4-1 policy engine 最小版**：声明式策略表，审批 hook 变为其一种策略结果
- [ ] **P4-2 凭据代理**：egress proxy 按目标域注入受限凭据（如 GitHub token 只对 api.github.com）
- [ ] **P4-3 注入红线测试**：恶意 README（prompt injection）作为固定 eval 用例

**验收**：模型读到恶意 README 时，仍不能读取或外传真实凭据；策略表可被用户覆盖且有审计记录。

## P5：可观测与评测

**思路**：先自产 JSONL trace（每个模型/工具调用：run ID、耗时、token、成本、失败原因），OTel exporter 作为可选依赖默认关闭——不违背极简原则。评测复用 P1 事件回放 + P2 FakeBackend + fixture。

**小步拆分**：

- [ ] **P5-1 trace/metrics 落盘**（RunEvent 之上派生，不新造日志）
- [ ] **P5-2 成本核算**（per-provider 单价表）
- [ ] **P5-3 evals 任务集 + docs/evals.md**（任务、成功标准、回归方式；固定 fixture 稳定回放比较 run trace）

**验收**：给定固定模型响应 fixture，可稳定回放并 diff 两份 run trace；evals 集在 CI 里跑出成功率。

## P6：长程任务

- [ ] **P6-1 大输出 artifact 化**：超长工具输出落外部 artifact，context 留 locator，模型按需取回片段
- [ ] **P6-2 真实 tokenizer 计量**（按 provider/model 对应 tokenizer，替代估算）
- [ ] **P6-3 摘要可追溯**：压缩摘要关联其来源消息区间（事件日志让这变得可查）

**验收**：超长构建日志不污染 context，但模型能按 artifact locator 取回所需片段；恢复会话后工具状态不丢。

## P7：多 agent

依赖 P2 的 backend 边界（worktree/sandbox 隔离）与 P1 的事件日志（任务图状态）。

- [ ] **P7-1 lead/worker 拆分 + worktree 隔离**
- [ ] **P7-2 任务图与租约**（谁在做什么、超时接管）
- [ ] **P7-3 结构化交接**（父 agent 只接收结构化结果与 diff）

**验收**：两个子 agent 同时修改同一文件时有**明确的冲突策略**，不是随机覆盖。

## P8：远程平台

控制面（harness/state/credential）上可信服务端，worker 只执行。API service、DB、queue、对象存储、多租户、限额、审计。这是产品化阶段，启动前需重新对齐定位。

**验收**：worker 崩溃后，调度器能超时接管并安全重试，而不是把 session 判死。

---

## 里程碑检查点

- **P0 完成**：项目以自己的名字站在 GitHub 上，CI 守护每次提交。
- **P1 完成**：kill -9 不再丢状态——这是"可靠性是前提"的第一个可验证承诺。
- **P2 完成**：脑手分离成型，之后所有隔离手段都是给同一个 seam 换实现。
- **P3+P4 完成**：模型被骗也拿不到密钥、出不了网、留不下孤儿进程——"安全执行平台"成立。
