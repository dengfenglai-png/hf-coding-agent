# 贡献指南

## 开发方式

本项目采用**边讲解边写、小步实现**的方式（详见 [AGENTS.md](AGENTS.md)）：

- 大需求先定思路与框架，拆成一个个可独立提交的小功能。
- 每个小步：讲解思路 → 确认 → 写码 → 测试全绿 → 提交。
- 方案确认后、动手前，把「问题 + 方案」入档 `docs/答疑日志.md`。
- 演进方向以 [docs/roadmap.md](docs/roadmap.md) 为唯一事实来源，完成一项勾一项。

## 新能力三问（提交前自查）

每新增一个能力，先写清三件事——写不清就不动手：

1. 它跨过了哪个**信任边界**？
2. 失败后**状态如何恢复**？
3. 怎样被**测试和观测**？

## 环境与命令

Node.js 22+。

```bash
npm install
npm run dev          # 源码直跑
npm run build        # tsc + chmod
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

CI（GitHub Actions，Node 20/22 矩阵）跑 `typecheck` + `test`，本地先过再推。

## 代码约定

- **注释只写非显而易见的「为什么」**，不逐行走读代码。
- **命名具体**：禁止 `utils` / `helpers` / `common` / `misc` 这类杂物名，用实际内容命名（如 `session-persistence.ts`）。
- **极简**：不引入没有真实使用者的抽象；可读性优先于抽象。现有两个 seam：`StreamFn`（provider 协议）、`ExecutionBackend`（P2，规划中）。
- **测试**：每个行为改动配 vitest 用例；导出给测试用的函数加「导出供测试」注释。

## 提交规范

- commit message 用中文、一行主题（`feat:` / `fix:` / `docs:` / `chore:` / `test:` 前缀），正文可展开动机与关键决策。
- 一个 commit 只做一件事，测试全绿再提交。
- 提交即表示同意以 [MIT](LICENSE) 授权你的贡献。

## 行为边界

- 不在仓库、issue、PR 中提交真实 API key；配置与 session 均在 `~/.nanopi/` 下，勿把该目录内容贴进 issue。
- 涉及安全机制（审批/拦截/脱敏）的改动，先读 [SECURITY.md](SECURITY.md) 与 [docs/threat-model.md](docs/threat-model.md)，避免削弱已有缓解措施。
