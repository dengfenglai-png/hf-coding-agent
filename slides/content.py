# -*- coding: utf-8 -*-
"""slides 内容定义（数据驱动，build_pptx.py 读取生成 PPT）。
每个 slide 一个 dict：kind 决定渲染方式。"""

# kind 取值：
#   cover   —— 封面（title + subtitle）
#   toc     —— 目录/概览（title + bullets）
#   content —— 纯要点页（title + bullets）
#   image   —— 大图页（title + image + 可选 bullets）
#   section —— 章节分隔页（title）

SLIDES = [
    # 1 封面
    {
        "kind": "cover",
        "title": "手撕一个 Agent Harness",
        "subtitle": "pi-from-scratch 技术原理汇报\n基于 docs/答疑日志.md · 从零实现一个 coding agent",
    },
    # 2 概览
    {
        "kind": "toc",
        "title": "什么是 Agent Harness",
        "bullets": [
            "给 LLM 装上「手」和「记忆」的运行框架：让模型能调用工具、管理上下文、自主完成多步任务",
            "一句话本质：一个 while 循环 + 上下文自管理 + 可插拔工具生态",
            "本汇报路线：系统架构 → Agent Loop → 上下文管理 → 工具系统 → 安全防线 → 工程地基 → 生态扩展 → 取舍",
        ],
    },
    # 3 系统架构图
    {
        "kind": "image",
        "title": "系统架构：五层分层",
        "image": "assets/architecture.png",
        "bullets": [
            "交互层（tui）→ 拼装层（cli，唯一入口）→ Agent 核心（agent + 上下文管理）→ LLM 适配 → 工具生态",
            "agent.ts 是灵魂：所有能力都汇聚到它，但核心循环极简",
        ],
    },
    # 4 Agent Loop
    {
        "kind": "image",
        "title": "核心：Agent Loop",
        "image": "assets/loop.png",
        "bullets": [
            "事件流驱动：assistant_text / tool_call / tool_result / turn_end 四类事件，UI 只消费事件",
            "无硬编码步数上限——循环到模型说停（end_turn / max_tokens）或被中断（aborted / error）",
        ],
    },
    # 5 消息模型
    {
        "kind": "content",
        "title": "消息模型与配对安全",
        "bullets": [
            "Message 三选一：user | assistant | tool（tool 是独立 role，不再塞进 user 消息）",
            "tool_call 必须有对应 tool_result，否则 session 恢复后 API 报 400",
            "abort 时丢弃未完成的 tool_calls，并为被跳过的补 error 结果——配对不破",
        ],
    },
    # 6 上下文管理（一）
    {
        "kind": "content",
        "title": "上下文管理（一）：token 估算",
        "bullets": [
            "问题：按消息条数判断「上下文快满」不准（一条 3 字 vs 3000 字）",
            "方案：固定密度启发式估算——CHARS_PER_TOKEN=2（中文≈1~2 token，不照搬 deepseek 的 /4）+ 结构开销",
            "阈值从 contextWindow 推导（contextWindow − maxTokens 再留安全余量），不写死魔法数字",
        ],
    },
    # 7 上下文管理（二）
    {
        "kind": "content",
        "title": "上下文管理（二）：压缩安全",
        "bullets": [
            "cut point：维护 tool 配对平衡计数，balance=0 的位置才可切——避免孤儿 tool_result",
            "摘要校验：摘要必须严格小于原文才替换（否则压缩反而更占空间）",
            "压缩失败或摘要为空 → 保留原文，绝不用空摘要损坏 context",
        ],
    },
    # 8 工具系统（一）
    {
        "kind": "content",
        "title": "工具系统（一）：契约与校验",
        "bullets": [
            "AgentTool 契约：name / description / parameters(JSON Schema) / execute，外加 exclusive / needsApproval / timeoutMs",
            "validateArgs 执行前校验，违规不执行、把 error 返回给模型重新生成（与「未知工具」同一条路径）",
        ],
    },
    # 9 工具系统（二）
    {
        "kind": "content",
        "title": "工具系统（二）：并行执行",
        "bullets": [
            "exclusive 分组：连续非独占 = 一个并行组；独占（写文件/执行命令）= 单独 barrier",
            "组内并行（MAX_PARALLEL=4 限流）、组间串行——既不互相踩，又能并行提速",
        ],
    },
    # 10 审批与危险检测
    {
        "kind": "content",
        "title": "审批与危险检测",
        "bullets": [
            "needsApproval 声明哪些调用需用户确认，缺审批渠道时 fail-closed（默认拒绝）",
            "isDangerousCommand 正则匹配「命令 + 高危标志」：rm -rf、git push --force、git reset --hard、sudo、mkfs、dd、shutdown…",
        ],
    },
    # 11 安全防线
    {
        "kind": "content",
        "title": "安全防线：拦截 / 脱敏 / 防循环",
        "bullets": [
            "beforeToolCall：工具执行前拦截 .env / .ssh / id_rsa 等敏感文件",
            "afterToolCall：结果脱敏（sk-*** 打码 API 密钥）",
            "detectLoop：连续相同工具调用即停，防死循环（shouldStopAfterTurn 回调）",
        ],
    },
    # 12 工程地基
    {
        "kind": "content",
        "title": "工程地基：重试退避 + 配置",
        "bullets": [
            "retryableFetch：429/5xx 指数退避重试、配额错误 fail-fast 不重试、abort 终态",
            "loadConfig：环境变量 > 配置文件 > 默认值；apiKey 只走环境变量（密钥不落盘）",
        ],
    },
    # 13 多 provider
    {
        "kind": "content",
        "title": "多 provider：StreamFn 注入",
        "bullets": [
            "StreamFn 类型 + 参数注入（默认 llm.ts 的 stream），agent 核心一行不改即支持新后端",
            "anthropic.ts：Anthropic 消息转换 + SSE 解析，契约一致——失败不 throw，编码进事件流",
        ],
    },
    # 14 MCP
    {
        "kind": "content",
        "title": "MCP：接外部工具服务",
        "bullets": [
            "手写最小 JSON-RPC client（零依赖）：spawn stdio 子进程 + NDJSON 逐行解析",
            "initialize 握手 → tools/list 发现 → tools/call 调用，MCP 工具并入 agent",
            "连接失败只警告不阻塞启动",
        ],
    },
    # 15 Skills
    {
        "kind": "content",
        "title": "Skills 机制：渐进披露",
        "bullets": [
            "三阶段：目录（name+description）常驻 → 模型自主判断 → load_skill 按需加载完整指令",
            "目录只有摘要，未加载前不推断指令（防从一句话幻觉出技能）",
            "加载结果留在 messages，后续轮次无需重载；压缩后丢失也能重新 load 自愈",
        ],
    },
    # 16 取舍
    {
        "kind": "content",
        "title": "关键取舍：教学版 vs 参考项目",
        "bullets": [
            "token 系数 /2（中文）而非 deepseek 的 /4（英文）——安全优先，高估比低估安全",
            "skill 用语义路由 + load_skill，而非 pi/deepseek 的显式 /skill 命令",
            "零依赖手写（MCP client / 校验 / 估算），而非官方 SDK——可读性优先于抽象",
        ],
    },
    # 17 演进路线
    {
        "kind": "content",
        "title": "演进路线与现状",
        "bullets": [
            "P1 上下文 ✓ · P2 工具 ✓ · P3 工程地基 ✓ · P4 交互（部分）· P5 生态 ✓ · P6 编排（待）",
            "当前：单个 agent 已「做深做全」，下一步向上叠加多 agent 编排层",
        ],
    },
    # 18 收尾
    {
        "kind": "section",
        "title": "谢谢 · Q&A",
        "subtitle": "一个 while 循环，加可靠的上下文管理，加可插拔的工具生态——就是一个能干活的手撕 agent。",
    },
]
