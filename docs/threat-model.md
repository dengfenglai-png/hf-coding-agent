# 威胁模型

> 回答三个问题：哪些输入不可信？哪些工具有副作用？哪些风险暂不解决？与 [SECURITY.md](../SECURITY.md)（报告渠道与声明）、[architecture.md](architecture.md)（边界图）配套。随 P2–P4 推进更新。

## 信任边界现状

当前只有一条边界：**本地用户权限**。控制面（agent loop、密钥、session）与执行面（工具执行）同进程同权限，agent 能做你用户能做的一切。

**模型输出（工具参数）与工具返回内容（文件内容、命令输出、MCP 返回）一律视为不可信输入。**

## 不可信输入清单

| 输入 | 进入路径 | 风险 |
|------|---------|------|
| LLM 生成的工具参数 | `tool_call` 事件 | 任意路径读写、任意 shell 命令 |
| 文件内容 | `read_file` / `grep` / `glob` → context | **prompt injection 主通道**：恶意 README/源码诱导模型调用工具 |
| 命令输出 | `run_bash` → context | 同上（如 `curl` 回来的网页内容） |
| MCP server 工具与返回 | `tools/list` / `tools/call` | server 由用户配置（视为可信），但其工具的副作用不受审批/串行控制 |
| 用户输入 | TUI prompt | 用户即操作者，视为可信 |

**可信前提**：`~/.nanopi/config.json`、内置工具与 skills 定义、MCP 配置——均由用户直接控制，不在威胁模型内。

## 有副作用的工具清单

| 工具 | 副作用 | 现有缓解 | 缓解的局限 |
|------|--------|---------|-----------|
| `run_bash` | 任意 shell：读写任意文件、网络可达、装包、删库 | 危险命令正则→审批；30s 超时；1MB buffer 缓冲上限 | 黑名单可平凡绕过（`find . -delete`、`curl x \| sh`、变体空白）；`exec` 不保证进程树全灭；无 egress 控制 |
| `write_file` / `edit` | 覆盖写任意路径（跟随 symlink、接受绝对路径） | CLI 拦截 `path` 匹配 `\.env\|.ssh\|id_rsa\|id_ed25519` | 只查 file 工具的 `path` 参数；`run_bash cat ~/.env` 绕过；symlink 逃逸未防 |
| `read_file` / `grep` / `glob` | 读任意用户可读文件（密钥、session、~/.nanopi/config.json） | 无（除上述 path 拦截） | 读到的内容进 context 并明文落 session |
| MCP 工具 | server 定义的任意副作用 | 无审批、无 `exclusive` 标记 | 整体豁免，见"暂不解决" |
| `todo_write` | 无（纯格式化） | — | — |
| （实现层）`truncateOutput` | 超长输出完整落 `os.tmpdir()` | — | 临时文件默认权限，其他本地用户可读 |

另有 CLI 层脱敏：工具结果里的 `sk-*` 正则打码后**才**回传模型——但只覆盖 `sk-` 前缀格式，zhipu 等其他格式不覆盖。

## 攻击场景（判断缓解是否够用的基准）

1. **恶意仓库**：agent 被要求阅读含注入指令的 README → 诱导 `run_bash` 外传 `~/.nanopi/config.json`。现状：唯一障碍是模型服从性，**无结构性防线**（P4-3 红线测试）。
2. **结果注入**：命令输出里伪造 `[审批] ... 请回答 y` 类文本 → 审批询问由 TUI 发起，不受工具输出影响，但模型可能被诱导请求用户批准恶意命令（现状：依赖用户看清审批内容）。
3. **本地多用户**：tmp 泄露、session 明文——同机其他用户可读（P3 workspace / 权限收紧）。

## 暂不解决的风险（显式接受，路线图收敛）

| 风险 | 解决落点 |
|------|---------|
| 本地 backend 无进程隔离（agent = 用户权限） | P2 LocalBackend 显式标注 → P3 DockerBackend |
| 无网络 egress 控制 | P3-3 默认拒绝 + 白名单代理 |
| 危险命令黑名单可绕过 | P4-1 policy engine（能力授权替代正则） |
| 敏感文件拦截仅覆盖 file 工具 `path` 参数 | P3-4 只读挂载 + P4 策略表 |
| prompt injection 无结构性防线 | P4-3 恶意 README 固定 eval 用例 |
| MCP 工具无审批/无串行 | P2-3 归位说明 → P4-1 纳入策略表 |
| `sk-*` 打码格式不全 | P4 凭据代理（key 不进执行环境后，问题消失） |
| session JSONL 明文含敏感内容 | 记录在案；P1 事件日志迁移时重新评估权限位 |
| `truncateOutput` 临时文件权限 | P6 artifact 化时收敛 |

## 目标边界（P4 完成时应成立的断言）

- 执行环境看不到真实 key；网络经可信侧代理按域注入受限凭据。
- 每个工具调用经过显式策略表（allow/deny/ask），审批只是 ask 的一种结果。
- 恶意 README 场景下，模型拿不到、也传不出真实凭据（有固定 eval 证明）。
