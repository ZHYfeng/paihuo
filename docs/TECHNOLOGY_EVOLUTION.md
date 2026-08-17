# PaiHuo 技术架构

> 当前架构基线，更新日期：2026-08-13。

PaiHuo 是面向可信管理员的个人自托管 Agent 调度平台。它保持 Go 单二进制、SQLite、tmux 与 Git worktree 的本机部署优势，同时用稳定应用边界、Runtime capability、声明式 Workflow 和类型化 React 前端承载后续演进。

## 技术栈

| 层 | 当前实现 |
|---|---|
| 服务端 | Go、`net/http`、应用服务与领域模块 |
| 数据 | SQLite + WAL，当前 schema 是唯一支持形态 |
| 执行 | RuntimeService、tmux、Git worktree |
| 事件 | 持久 `EventStream` + SSE 序号续传 |
| API | `/api/v1`、OpenAPI 3.1、统一错误、幂等键、revision |
| 前端 | React 19、TypeScript、Vite、React Router、TanStack Query、Tailwind、Radix |
| 终端与内容 | xterm.js adapter；Marked + DOMPurify 单一审计渲染器 |
| 测试 | Go test、Vitest、Testing Library、Playwright |
| 交付 | Vite hashed assets 由 `go:embed` 嵌入单二进制；生产不运行 Node |

## 模块方向

```text
React / API clients
        │
        ▼
HTTP transport ── authentication / protocol / error envelope
        │
        ▼
Application ── TaskLifecycle / WorkflowService / Session / WorkspaceService
        │
        ├── RuntimeService ── CommandRuntime / SessionDriver / Provisioner
        ├── EventStream
        ├── ArtifactStore
        ├── SQLite Store
        └── Workspace / tmux
```

HTTP handler 不定义 Runtime 命令、不直接拥有 Workflow 策略，也不实现工作区规则。应用服务负责用例编排；领域模块负责状态与不变量；Store 提供事务边界和持久化能力。

## 领域边界

- `TaskLifecycle` 校验任务目标、Role、Project、权限、运行方式和依赖，创建后唤醒执行器。人工状态变更必须符合状态机。
- `WorkflowService` 管理工作流定义（增删查改）、确定性 Policy 和 Run。Run 在同一事务内创建全部 Task 与多边依赖，执行器不会观察到半张图。
- `RuntimeService` 通过 capability 选择执行提供者。`ExecutionRequest` 被翻译为可审计 `CommandSpec`；Task 与 Workflow 不理解厂商 flag。
- `SessionDriver` 只由支持结构化多轮消息的 Runtime 实现。当前 Pi 与 OMP 支持 session，其他 Runtime 保持批处理。
- `WorkspaceService` 管理状态查询、丢弃和 Git 初始化；Git 项目中的 Task/Session 使用独占 worktree。
- `EventStream` 先持久化再发布，事件具有稳定 `seq`。浏览器用 `Last-Event-ID` 或 `after` 补拉断线区间。
- `ArtifactStore` 以 SHA-256 内容寻址保存不可变内容；SQLite 只保存归属、媒体类型、hash、大小、locator 与保留策略。

## Runtime 模型

Role 表达责任、指令、技能和并发策略；Runtime 表达执行能力。数据库和 API 使用 `role_id` 与 `runtime_id`，二者不互为别名。

每个 Runtime 分成窄接口：

- `CommandRuntime`：描述能力并生成批处理/交互命令。
- `SessionDriver`：准备结构化会话并声明退出语义。
- `Provisioner`：检查安装、版本、登录状态和安装命令。

内置 Runtime 为 OMP、OpenCode、Pi、Claude Code、Codex。FakeRuntime 可独立验证 TaskLifecycle 与 Workflow，不需要真实 CLI 或 tmux。

## Workflow

Workflow spec 只包含声明式 JSON：目标、预算与图限制，以及节点的 intent、Role selector、依赖、权限、允许动作、输入引用、输出 schema、超时和失败策略。Edge 不包含代码。spec 不绑定 Project——启动 Run 时选择具体项目。

Policy 在创建时同步校验，拒绝即不落库：

- 空目标、节点重复或依赖缺失；
- 图循环、深度/节点/并发/预算/超时越界；
- Role 不存在、停用或 Runtime capability 不足；
- 非 `node:` / `artifact:` 受控引用；
- 危险动作没有显式审批。

通过校验后，Workflow 成为带 canonical hash 的 adopted 定义，可被多次启动；
定义可整体替换（重新校验、重写 spec_hash）或删除，均受 revision 保护。
启动 Run 时绑定具体 Project，Run 中每个 Task 持有 `workflow_run_id`；执行器
跨 Role 强制执行 Workflow 的并发上限，并以包含代码整合子任务在内的 Delivery
状态结算 Run。删除定义只移除定义与 Run 书签，节点任务保留为任务历史。

## HTTP 合同

API 只暴露 `/api/v1`。权威合同位于 [`internal/server/openapi.yaml`](../internal/server/openapi.yaml)，运行时也可读取 `GET /api/v1/openapi.yaml`。

错误统一为：

```json
{"error":{"code":"conflict","message":"资源已被其他操作修改"}}
```

所有 mutation 可携带 `Idempotency-Key`；服务按 key、method、path 原子保留并重放首次完成的响应。Task、Role、Project、Schedule 和 Workflow 的用户修改使用 `If-Match: "<revision>"`，陈旧写入返回 `409`，缺少前置条件返回 `428`。

列表与大内容分离：任务日志使用分页查询；artifact 内容通过独立下载端点读取；SSE 仅传增量事件。

## 前端

认证后只有一个 React root 和 BrowserRouter。页面按领域懒加载；TanStack Query 管服务端状态，持久 SSE hook 统一失效相关 query。Role 表单直接消费 Runtime schema、逐模型思考档位、已安装扩展和技能库候选。路由包括工作台、任务板、历史、项目、Role、Runtime、技能、模板、定时、Session、Workflow 与设置。

设计使用 primitive → semantic → component 的语义 token，支持亮/暗主题、响应式导航、键盘焦点、reduced motion 与移动端触控尺寸。Dialog 基于 Radix。Workflow 图总有表格等价视图，状态不只依赖颜色。

Agent 输出不能生成可执行 HTML/JS。`VisualizationSpec` 只允许 metric、table、timeline、task graph、diff summary 和 series；服务端验证版本与类型，前端选择本地 renderer。

## 数据与安全

当前 schema 在空数据库上一次创建，不包含数据库升级链。更换到本版本时应使用全新数据库并重新配置；启动检测到其他 schema 会直接拒绝。

当前生产基线为 `/home/yu/paihuo` 中的 `v2026.08.17-4`，由
`paihuo.service` 用户服务托管。架构或 schema 发布采用干净部署：清空数据库、
Session/worktree 和 Artifact，保留访问令牌与独立技能库。部署命令以
[部署指南](DEPLOYMENT.md) 为准。

默认 profile 是 `trusted-host`：Runtime 以 PaiHuo 服务用户权限访问主机、项目和凭据。令牌只用于登录，随后使用带 HMAC 的 HttpOnly session cookie。公开监听必须配置令牌；TLS 反向代理部署启用 Secure cookie。

这不是多租户沙箱。不要把不可信用户或仓库放入同一权限域，也不要把 Docker socket 或额外宿主机权限交给 Runtime。

## 构建与质量门禁

```bash
npm ci
make check
make test-race
```

`make check` 覆盖 Go 格式与依赖、TypeScript、ESLint、Vitest、Vite 产物同步、Go vet、Go tests 和二进制构建。`scripts/e2e.sh` 验证 React 路由、API revision 合同和桌面/移动端布局。
