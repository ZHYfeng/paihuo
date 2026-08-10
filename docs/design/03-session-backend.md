# S-1 技术设计：会话后端

> 状态：已确认 · 更新：2026-08-08
> 实体设计：`02-session-entity.md`。本文定义后端实现：模块、进程模型、事件通道、槽位、API、风险。

## 1. 模块划分（新包 `internal/session/`）

```
internal/session/
├── session.go      Session 模型 + 状态机（纯逻辑，可单测）
├── manager.go      SessionManager：CRUD + 状态迁移 + 槽位 + 事件发布
├── rpcproc.go      pi RPC 进程封装（spawn / 命令 / 事件解析）
├── rpcargs.go      RPC 启动参数构造（角色配置 → argv）
└── routes.go       HTTP API 注册
internal/exec/slots.go   （提取）SlotRegistry ← Executor 与 SessionManager 共用
```

## 2. 进程模型（每会话一个 pi RPC 进程）

```
spawn: pi --mode rpc [角色参数] --session-dir <sessionsRoot>/.agent-sessions/session-<id>/
       cwd = 会话 worktree（agent 在隔离分支里干活）
stdin  ← 命令 JSONL（prompt/steer/abort/get_messages/switch_session…）
stdout → 事件 JSONL（assistant/tool/bash/error…）→ 解析分发
stderr → 日志文件（调试）
```

| 时刻 | 行为 |
|---|---|
| start | spawn（新会话文件） |
| resume | spawn 新进程 → 发 `switch_session <最新.jsonl>` 接续旧会话 |
| suspend / deliver / discard | `SIGTERM` → 5s 超时 `SIGKILL`；transcript 由 pi 会话文件持久化 |
| 崩溃 | 进程退出且状态=active → 置 suspended + 发事件（数据不丢，随时可恢复） |

## 3. 事件通道（复用现有 Hub + SSE）

```
pi stdout JSONL → rpcproc 解析 → SessionManager
    ├─ 更新 last_message_at 等 → SQLite
    └─ events.Hub.Publish（现有 SSE /api/events 扩展类型）
         session.updated  {id, status, ...}
         session.message  {id, message}      ← AgentMessage 原样 JSON
         session.error    {id, error}
```

**增量+全量兜底**：前端打开会话 → `GET /api/sessions/{id}/messages` 拉全量（get_messages 转发）→ 再订阅 SSE 增量。SSE 丢事件不影响正确性（与现有任务日志兜底同模式）。

**命令响应同步化**：`POST prompt` 同步等待 RPC response（接受/拒绝，5s 超时）→ 返回 `{accepted: bool}`；**内容走事件流**。前端体验：发送即知成败，内容流式到达。

## 4. 槽位与调度

- **提取 SlotRegistry**：把 `executor.go` 的 `active`（角色并发）/`activeProj`（项目串行）抽为共享组件，Executor 与 SessionManager 各持引用
- 会话 start/resume → `reserveAgentSlot(agentID, role.MaxConcurrent)`；suspend/deliver → release
- **会话不套项目串行门禁**（决策）：交互会话是人在场即时操作，worktree 已隔离代码；项目门禁语义只属于批处理队列。资源由角色 MaxConcurrent 统一兜底

## 5. RPC 启动参数构造（复用 piAdapter 翻译逻辑）

```
pi --mode rpc
   [--model m] [--provider p] [--thinking t]
   [--append-system-prompt s] [--tools/--exclude-tools/--models]
   [--skill <dir>…]        ← 角色技能挂载目录（.role-agents/<id>/.agents/skills）
   [extra_args…]
   --session-dir <dir>
```

差异：`-p`/位置参数不适用（初始消息由前端 `prompt` 命令发）；env 合并复用 `mergeEnv`。

## 6. API 设计

```
POST   /api/sessions                    {project_id, agent_id} → 以 agent 名称为标题，建记录+worktree
GET    /api/sessions?project_id=&status=
GET    /api/sessions/{id}
POST   /api/sessions/{id}/start         → active（spawn）
POST   /api/sessions/{id}/suspend       → suspended
POST   /api/sessions/{id}/resume        → active（spawn+switch_session）
POST   /api/sessions/{id}/deliver       {task_title?} → delivered + task_id
DELETE /api/sessions/{id}               → deleted（清理 worktree）
POST   /api/sessions/{id}/prompt        {message, images?, streaming_behavior?} → {accepted}
POST   /api/sessions/{id}/abort
POST   /api/sessions/{id}/command       {command, args}   ← /扩展命令、set_model 等
GET    /api/sessions/{id}/messages      （get_messages 转发）
GET    /api/sessions/{id}/state         （get_state 快照）
```

## 7. 数据迁移

```
sessions 表（见 02-session-entity.md）+ tasks 表加 session_id 列（迁移版本 +1）
```

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| pi RPC 协议变动 | 启动前 `pi --version` 版本门槛检查（≥0.83），失败给可读提示 |
| 每会话一进程的内存 | 挂起即杀进程释放；MaxConcurrent 兜底；上限提示 |
| `switch_session` 恢复失败 | 降级为新会话 + 提示旧历史可读（get_messages 仍可访问旧文件） |
| SSE 丢事件 | 前端全量拉取兜底（现有模式） |
| 进程崩溃丢上下文 | transcript 由 pi 文件持久化，resume 即恢复 |

## 9. 里程碑拆分

```
S-1a   sessions 表 + CRUD + 状态机（无进程，纯后端可测）
S-1b   rpcproc 进程封装 + JSONL 解析 + 命令通道（单测 + 真实 pi 冒烟）
S-1c   管理器集成：槽位共用 + SSE 事件 + 全部 API + 交付桥接
S-1d   恢复/崩溃处理 + 挂起清理 + 版本门槛
```

## 10. 关键技术事实（2026-08-08 核实）

- pi RPC：`pi --mode rpc [options]`，JSONL over stdin/stdout，LF 唯一分隔符（不能用 readline 类按 Unicode 分隔的读取器）
- 命令：`prompt`（含 images、streamingBehavior）、`steer`、`follow_up`、`abort`、`new_session`、`switch_session`、`get_state`、`get_messages`、`set_model`、`set_thinking_level`、`compact`、`set_auto_compaction`、`get_commands`
- 事件：`agent_start/end/settled`、`turn_start/end`、`message_start/update/end`、`bash_execution_update`、`tool_execution_start/update/end`、`queue_update`、`compaction_start/end`、`auto_retry_start/end`、`extension_error` 等 20+ 种
- 启动选项：`--provider`、`--model`、`--name`、`--no-session`、`--session-dir`
- 会话文件：JSONL，version 3，entry 树（id/parentId），含 session/message/model_change/thinking_level_change/compaction/branch_summary/custom/custom_message/label/session_info 类型
- 现有复用点：`mergeEnv`（环境合并）、角色技能挂载目录（`.role-agents/<agentID>/.agents/skills`）、`events.Hub`（SSE 广播）、`workspace.Ensure`（worktree 复用兼容）
