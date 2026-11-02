# 安全政策

## 报告漏洞

请使用 GitHub 的 [私有漏洞报告](https://github.com/dengfenglai-png/hf-coding-agent/security/advisories/new)（Private vulnerability reporting），不要在公开 issue 里描述可利用细节。

- 支持版本：`main` 分支（项目处于 0.x，不为旧 commit 提供补丁）。
- 响应目标：3 个自然日内确认，7 个自然日内给出评估结论。

## ⚠️ 最重要的声明：当前形态不构成隔离

**hf-coding-agent 的 local 模式下，agent 以你登录用户的全部权限在宿主机上执行操作。** 这意味着：

- `run_bash` 执行任意 shell 命令，可以读写你用户可读写的一切文件、访问网络。
- 危险命令审批（`rm -rf`、`sudo` 等）与敏感文件拦截是**启发式黑名单**，不是安全边界——存在平凡绕过（如 `find . -delete`、`run_bash` 读 `~/.env`）。
- 模型输出的工具参数、工具返回的文件内容都属于**不可信输入**：把 agent 指向恶意仓库/网页时，prompt injection 可能诱导它做出危险动作。

因此：**不要把 agent 指向你不信任的内容后放任其自动审批**；密钥类文件不要放在 agent 工作区内。隔离执行环境是路线图 P2（ExecutionBackend 脚手架）→ P3（Sandbox）→ P4（凭据与策略）的目标，落地前本声明持续有效。详见 [docs/threat-model.md](docs/threat-model.md)。

## 什么算漏洞（接受报告）

- API key 意外进入不该在的地方：工具结果回传给模型时的泄漏路径、配置文件权限、session 文件越权读取。
- 审批机制本身被绕过：`needsApproval` 返回 true 却未询问用户就执行。
- 工具调用配对/上下文压缩逻辑被恶意内容破坏，导致注入任意 tool_call。
- 超出声明的启发式局限之外的保护失效。

## 什么不算漏洞（已知局限，路线图解决）

- 危险命令黑名单的绕过变体（P4 升级为 policy engine）。
- 本地 backend 无进程隔离、无网络 egress 控制（P3）。
- MCP server 工具未经审批执行（P2-3 / P4-1）。
- prompt injection 诱导模型调用合法工具（P4-3 红线测试）。
- session JSONL 明文存储完整上下文（含工具读到的内容）。
