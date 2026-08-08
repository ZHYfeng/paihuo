# PaiHuo 设计文档

paihuo 会话与工作区重构的设计文档集。从"我如何使用 agent 干活"出发，逐步细化到可实现的规格。

## 文档索引

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 00 | [scenarios.md](00-scenarios.md) | 场景分析：8 种干活场景 + 工具匹配矩阵 + 甜蜜区定位 | ✅ 已确认 |
| 01 | [requirements.md](01-requirements.md) | 需求分析 v2：产品定义 + 需求全景（S1-S5 / R1-R7 / N2 / N4） | ✅ 已确认 |
| 02 | [session-entity.md](02-session-entity.md) | S1 会话实体设计：状态机 / 数据模型 / 双执行通道 | ✅ 已确认 |
| 03 | [session-backend.md](03-session-backend.md) | S-1 技术设计：模块 / 进程模型 / 事件通道 / API / 风险 | ✅ 已确认 |
| 04 | [session-message-stream.md](04-session-message-stream.md) | S-3 消息流渲染规格：渲染模型 / 组件映射 / 流式渲染 | ✅ 已确认 |
| 05 | [frontend-components.md](05-frontend-components.md) | S-2 前端组件规格：页面布局 / 逐组件 props-状态-交互 | ✅ 已细化 |
| 06 | [delivery-bridge.md](06-delivery-bridge.md) | 交付桥接流程：用户流程 / 后端事务 / worktree 复用 / 边界 | ✅ 已细化 |
| 07 | [fallback-cli.md](07-fallback-cli.md) | codex/claude 降级视图：tmux 复用 / 终端式 UI / 状态机差异 | ✅ 已细化 |
| 08 | [implementation.md](08-implementation.md) | 实现路线图：阶段 A-F / 依赖关系 / 建议执行顺序 | ✅ 已细化 |

## 阅读顺序建议

1. 先读 00（场景）→ 01（需求），建立产品上下文
2. 会话主线：02 → 03 → 04（实体 → 后端 → 渲染）
3. UI 规格：05 → 06（组件 → 交付闭环）
4. 降级与落地：07 → 08

## 关键决策速览

- **一个平台两种模式**：简单问题→批量任务；复杂问题→常驻交互会话（worktree 隔离，交付转任务）
- **pi 为核心 agent**：RPC 模式深度集成（结构化消息流 UI）；codex/claude 终端式降级
- **会话与任务平行**：挂起/恢复/交付状态机；交付复用 worktree，合并流程零改动
- **前端 lit 重写**：渐进式，任务详情页与会话页先行，高度参考 pi-web
- **skills 三级加载**：按 tags 添加 / agent 辅助推荐 / 人工调整
