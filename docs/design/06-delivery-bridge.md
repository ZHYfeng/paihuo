# 交付桥接流程（会话 → 任务）

> 状态：已细化 · 更新：2026-08-08
> 实体设计：`02-session-entity.md` §5。本文细化交付的完整流程：前端交互、后端事务、worktree 复用、边界与回链。

## 1. 用户流程

```
[会话详情 · 交付按钮]
  → 确认弹窗:
      任务标题（默认 = 会话标题，可改）
      角色 / 项目（继承，只读显示）
      权限选择: [自动派发合并（默认）| 审批后合并]
      说明（可选，预填会话标题+创建时间）
  → 提交 → 会话冻结（✓ 已交付 → 任务 #N 链接）→ 跳转任务详情 #/issue/<N>
```

## 2. 后端流程（`POST /api/sessions/{id}/deliver`，单事务）

```text
1. 校验
   - 会话存在且 status ∈ {active, suspended}（created 无对话内容 → 拒绝并提示"先启动会话"）
   - 角色存在（已停用 → 警告但仍可交付；已删除 → 拒绝）
2. 创建 Task
   - title       = 弹窗值（默认会话标题）
   - project_id  = 会话.project_id
   - agent_id    = 会话.agent_id（可被弹窗改派？→ 本期不允许，交付后任务详情可改）
   - session_id  = 会话.id        ← 新增列
   - body        = 弹窗说明（可空）
   - perm        = 弹窗选择（默认 full）
   - status      = queued
   - worktree_branch / worktree 路径 = 复用会话的（见 §3）
3. 会话 → delivered，task_id = 新任务 id
4. 事件广播：session.updated + task.created（现有任务事件）
```

## 3. worktree 复用（关键实现细节）

会话 worktree 位于 `sessions/<proj>/session-<id>`，分支 `paihuo/session-<id>`；任务系统期望 `task-<id>`。

**方案：任务创建时继承会话的 worktree 记录，不搬移。**

```text
现有逻辑: workspace.Ensure(tk)  →  worktree 不存在则创建 task-<id>
改造后:   tk.SessionID != nil 时，从 sessions 表读 worktree_branch/worktree_path
          → 传入 Ensure 的"已存在"分支（现有代码直接返回，天然兼容）
```

- 合并任务照常工作：它读取源任务（这里是交付任务）的 worktree 分支做整合
- 会话交付后其 worktree 归属任务管理（discard/清理逻辑走任务侧）
- 非 git 项目：无 worktree，任务直接在项目目录执行（现有逻辑）

## 4. 前端回链

| 位置 | 内容 |
|---|---|
| 会话列表（交付项） | `✓ 已交付 → 任务 #N`（点击跳转） |
| 会话详情头部 | 交付徽标 + [查看任务] 按钮 |
| 任务详情页 | 新增"来源会话 #id"元信息（点击回到会话时间线，只读） |
| 消息流顶部（交付后） | 提示条"✓ 已交付为任务 #N，会话已冻结" |

## 5. 边界与错误

| 场景 | 行为 |
|---|---|
| 会话已交付/已删除 | 拒绝（409） |
| 会话 created | 拒绝，提示先启动 |
| 角色已删除 | 拒绝（任务不能无角色？→ 可接受：任务 agent_id 可为 null，允许交付但提示） |
| 角色已停用 | 允许，任务 queued 会因角色停用而阻塞（现有 mergeBlockReason 逻辑），提示用户 |
| worktree 已丢失（外部删除） | 交付成功，任务 Ensure 时重建（退化为主分支基线，提示） |
| 并发交付（双击） | 事务锁 + 状态校验，第二次拒绝 |

## 6. 验收标准

- [ ] 会话交付后：任务 queued 出现在看板；会话冻结只读；两处回链可跳转
- [ ] 合并任务能正确整合会话 worktree 分支的内容（端到端）
- [ ] 交付后任务失败重试/续跑不影响会话历史
