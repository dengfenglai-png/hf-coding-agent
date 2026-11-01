# hf-coding-agent

**本地优先的终端 Coding Agent Harness**：cd 进任意项目目录，一条命令进入 agent——读写文件、改代码、执行命令，带上下文压缩、工具审批、会话持久化与项目级会话隔离。

> 从零构建、可逐步演进为安全执行平台。演进路线（P0–P8：事件日志 → 脑手分离 → Sandbox → 密钥权限 → 可观测评测…）见 [docs/roadmap.md](docs/roadmap.md)。

本项目衍生自教程 [PI from Scratch](https://github.com/SaladDay/pi-from-scratch)（MIT），保留了其完整提交历史与教学章节；内部原理想从头弄明白，教程依然是最好的入口（见下文「教程」章节）。

## 运行 hf-coding-agent

需要 Node.js 22 或更高版本，以及一个 OpenAI 兼容（或 Anthropic 协议）API。

```bash
npm install
npm run build
npm link          # 全局注册 hf-coding-agent 命令
```

之后在任意项目目录里：

```bash
cd your-project
hf-coding-agent          # 进入 harness，agent 以当前目录为工作区
hf-coding-agent -c       # 续接该目录最近一次会话
```

session 按启动目录隔离，存放在 `~/.nanopi/projects/<目录 slug>/`；不带 `-c` 时默认开新会话。

开发模式：`npm run dev`（源码直跑，等价于 hf-coding-agent）。

API key 有三种给法，按优先级：`--api-key` 参数 > `NANOPI_API_KEY` 环境变量 > `~/.nanopi/config.json`。一个都没有时，首次运行会引导你录入并保存到配置文件（权限 600）。

内置 provider 预设（自动带出接口地址和默认模型）：`zhipu`（默认）/ `zai` / `deepseek` / `openai` / `anthropic` / `openrouter`，用 `NANOPI_PROVIDER` 或配置文件的 `provider` 字段选择。

可选环境变量：

- `NANOPI_PROVIDER`：provider 预设名
- `NANOPI_MODEL`：模型名（覆盖预设默认值）
- `NANOPI_BASE_URL`：OpenAI 兼容接口地址（覆盖预设，中转站用）

会话内命令：`/help` `/clear` `/new` `/model` `/exit`；`Ctrl+C` 中断当前回合，连按两次或空闲时按下退出。

线上 trace 是预先生成的静态数据，浏览网站不会发起模型请求。

## 教程：从零手撕一个 Coding Agent（上游 PI from Scratch）

<p align="center">
  <a href="https://pi-from-scratch.vercel.app">
    <img src="./web/public/og.png" alt="PI from Scratch：从零手撕一个 Coding Agent" width="80%">
  </a>
</p>

教程沿着 [pi](https://github.com/earendil-works/pi) 的数据流拆解，需要什么、我们造什么，所有组件都是符合直觉的。删除 pi 的工程细节，留下 pi 的核心思想。放轻松，这是一篇文章，不是一本书，你会很容易看懂。

网站把文章和源码放在一起。阅读推进时，右侧编辑器会逐步补全代码，当你看完的时候，nano-pi 的代码也会全部呈现在编辑器中。同时设计了一个 Trace 跟踪，可以打断点逐行过代码，帮助理解代码执行流。

[在线阅读 PI from Scratch](https://pi-from-scratch.vercel.app) · 教程保留古法手敲，尽可能没有 ai 味。

## 本地运行教学网站

```bash
cd web
npm install
npm run dev
```

## Thanks

- 感谢 [OpenModel](https://www.openmodel.ai?ref=JGDNqZl8) 为本项目提供 API 测试支持。OpenModel 提供稳定可靠的 AI API 和生产级 SLA 保障，一个接口即可调用 50+ 主流模型，并可直接用于 Claude Code、Codex，以及你刚刚亲手做好的 nano-pi 😈。
- 感谢 [Cubence](https://cubence.com/signup?code=SC3M1CAH&source=ccscli) 对本项目的赞助。Cubence 自 2025 年 9 月起提供稳定高效的 API 中转服务，兼容 OpenAI 与 Anthropic 协议，可直接接入 Codex、Claude Code、pi 和 oh-my-pi 等主流编程工具。
- 感谢 [pi-book](https://books.antinomie.org/pi/) 带来的启发，为本项目从零实现 nano-pi 提供了不少思路和参考。如果你想在完成 nano-pi 后继续深入理解 pi，这本书很值得读。

## Star History

<p align="center">
  <a href="https://www.star-history.com/#SaladDay/pi-from-scratch&amp;Date">
    <img src="https://api.star-history.com/chart?repos=SaladDay%2Fpi-from-scratch&amp;type=date&amp;legend=top-left&amp;sealed_token=zEX_hDx767RuvD8h02AAC8PQvRcc5HyRIrKXaM5IoysJtPVPUhY8x-JjF6a1XFnUN1acFyB111JWBmLFh6yzfhmk6sbPo3EXlz2VPf6UXxM7iUtALO3wYvU3zj9u3Xmj8CleWffL6e7wzGJ7k7K2kOHcAzc8gOTwZqmrxObgmuKUJC2aEV1vygRPnnwP" width="560" alt="Star History Chart">
  </a>
</p>

## License

[MIT](LICENSE)
