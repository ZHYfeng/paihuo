# PaiHuo 技术架构

> 当前架构基线，更新日期：2026-08-24。

PaiHuo 是面向可信管理员的个人自托管 Agent 调度平台。它保持 Go 单二进制、SQLite、tmux 与 Git worktree 的本机部署优势，同时用稳定应用边界、Runtime capability、声明式 Workflow 和类型化 React 前端承载后续演进。

## 技术栈

| 层 | 当前实现 |
|---|---|
| 服务端 | Go、`net/http`、应用服务与领域模块 |
| 数据 | SQLite + WAL；采用 `PRAGMA user_version` 的编号迁移，schema 变更失败即拒绝启动 |
| 执行 | RuntimeService、tmux、Git worktree |
| 事件 | 持久 `EventStream` + SSE 序号续传 |
| API | `/api/v1`、部分 OpenAPI 3.1 描述、统一错误、幂等键、revision |
| 前端 | React 19、TypeScript、Vite、React Router、TanStack Query、Tailwind、Radix |
| 终端与内容 | xterm.js adapter；Marked + DOMPurify 单一审计渲染器 |
| 测试 | Go test、Vitest、Testing Library、Playwright |
| 交付 | 构建时生成 Vite hashed assets，再由 `go:embed` 嵌入单二进制；生成物不入 Git，生产不运行 Node |

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

HTTP handler 只负责 decode、认证、`If-Match` revision 解析以及 HTTP 状态/错误
映射，不定义 Runtime 命令、不直接拥有 Workflow 策略，也不实现工作区规则。
Application 负责 Task 用例、状态机和跨 Store/Executor/Workspace/Session/EventStream
的副作用编排；领域模块负责状态与不变量；Store 提供事务边界和持久化能力。
简单 Role/Project/Skill CRUD、普通 Task 字段 PATCH 和纯读取不强行增加 application
薄包装。该边界由 [ADR-0002](adr/0002-application-use-case-boundary.md) 确立。

## 领域边界

- `TaskLifecycle` 校验任务目标、Role、Project、权限、运行方式和依赖，并统一编排创建、审批、驳回/重排、取消、续跑和删除；它在副作用前检查 revision/当前状态，状态变化后按既定顺序发布事件、管理 Runtime Session/Workspace 并唤醒执行器。
- `WorkflowService` 管理工作流定义（增删查改）、确定性 Policy 和 Run。Run 在同一事务内创建全部 Task 与多边依赖，执行器不会观察到半张图。
- `RuntimeService` 通过 capability 选择执行提供者。`ExecutionRequest` 被翻译为可审计 `CommandSpec`；Task 与 Workflow 不理解厂商 flag。
- `SessionDriver` 只由支持结构化多轮消息的 Runtime 实现。Pi 与 OMP 用 `--mode rpc` 的 stdin/stdout JSONL 通道（rpcProc）；DSH 用其原生 HTTP ApiProxy——常驻 `dsh --profile web` 宿主（full/review 两个权限模式宿主），会话经 `session.create/prompt/history/cancel` 驱动、SSE 事件流订阅，事件在服务端归一化为统一 rpcEvent 形状；其他 Runtime 保持批处理。
- `WorkspaceService` 管理状态查询、丢弃和 Git 初始化；Git 项目中的 Task/Session 使用独占 worktree。
- `EventStream` 先持久化再发布，事件具有稳定 `seq`。浏览器用 `Last-Event-ID` 或 `after` 补拉断线区间。
- `ArtifactStore` 以 SHA-256 内容寻址保存不可变内容；SQLite 只保存归属、媒体类型、hash、大小、locator 与保留策略。

## Runtime 模型

Role 表达责任、指令、技能和并发策略；Runtime 表达执行能力。数据库和 API 使用 `role_id` 与 `runtime_id`，二者不互为别名。

每个 Runtime 分成窄接口：

- `CommandRuntime`：描述能力并生成批处理/交互命令。
- `SessionDriver`：准备结构化会话并声明退出语义。
- `Provisioner`：检查安装、版本、登录状态和安装命令。

内置 Runtime 为 OMP、OpenCode、Pi、Claude Code、Codex、DSH。FakeRuntime 可独立验证 TaskLifecycle 与 Workflow，不需要真实 CLI 或 tmux。

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

API 只暴露 `/api/v1`，资源路径段使用复数名称。完整替换使用 `PUT`，局部修改
使用 `PATCH`；同一操作不以多个 method 或 path 提供别名。
[`internal/server/openapi.yaml`](../internal/server/openapi.yaml) 是可由
`GET /api/v1/openapi.yaml` 读取的权威 OpenAPI 3.1 HTTP 合同。所有 86 个
`/api/v1` operation（63 个 path）在注册时由同一个 registrar 记录，测试将注册
集合与 OpenAPI 集合双向比较；任一侧遗漏或多写 operation 都会阻断门禁。登录、
静态资源和 React 页面 fallback 不属于 OpenAPI 集合。

错误统一为：

```json
{"error":{"code":"conflict","message":"资源已被其他操作修改"}}
```

所有 mutation 可携带 `Idempotency-Key`；服务按 key、method、path 原子保留并重放首次完成的响应。Task、Role、Project、Schedule 和 Workflow 的用户修改使用 `If-Match: "<revision>"`，陈旧写入返回 `409`，缺少前置条件返回 `428`。

列表与大内容分离：任务日志使用分页查询；artifact 内容通过独立下载端点读取；SSE 仅传增量事件。

## 前端

认证后只有一个 React root 和 BrowserRouter。页面按领域懒加载；TanStack Query 管服务端状态，持久 SSE hook 统一失效相关 query。Role 表单直接消费 Runtime schema、逐模型思考档位、已安装扩展和技能库候选。路由包括工作台、任务板、历史、项目、Role、Runtime、技能、模板、定时、Session、Workflow 与设置。

技能库以「分类（文件夹）+ 标签」组织：导入/扫描时分类从源目录父文件夹名推断（frontmatter `category` 优先），可单独或批量调整；技能页支持按文件夹分组、批量打标签/移动分类/删除。角色表单的技能选择器按分类分组展示，标签 chip 点击一键选取/取消该标签的全部技能，值仍是 `role_config.skills` 目录数组（保持注册顺序）。

设计使用 primitive → semantic → component 的语义 token，支持亮/暗主题、响应式导航、键盘焦点、reduced motion 与移动端触控尺寸。Dialog 基于 Radix。Workflow 图总有表格等价视图，状态不只依赖颜色。

前端定义了 `VisualizationSpec` 联合类型和本地 renderer，支持 metric、table、timeline、
task graph、diff summary 和 series；当前工作流页面直接以本地类型化数据调用其中的
`TaskGraph`。服务端尚未接入 Role 产出 spec 的调用方，也不验证 Agent 输出，因此这套
前端类型与 renderer 不是服务端安全边界，不得直接用来渲染未受信任的 Role 输出。

## 数据与安全

SQLite schema 按 [ADR-0003](adr/0003-numbered-sqlite-migrations.md) 编号。空数据库直接
创建最新 schema；非空数据库从 `PRAGMA user_version` 标明的版本顺序迁移。当前最低
支持版本为 v1，原有 8 个幂等增量固定映射为 v2–v9，Task 形态 `CHECK` 约束是 v10。
迁移和版本推进共享事务，失败即回滚并拒绝启动；版本超出支持范围与受支持版本的
schema shape 损坏分别报告。迁移不提供 downgrade。

schema 发布保留真实 Task、Session、Workflow 与 Artifact 状态，不再默认清库。发布必须
停止写入，整体备份 SQLite 与 Artifact，在副本上演练逐版本路径，并通过业务数据、外键和
完整性对账；恢复单位是“旧 binary + 整体备份”。部署命令以
[部署指南](DEPLOYMENT.md) 为准。

默认 profile 是 `trusted-host`：Runtime 以 PaiHuo 服务用户权限访问主机、项目和凭据。默认浏览器鉴权中，令牌只用于登录，随后使用带 HMAC 的 HttpOnly session cookie；MCP 始终使用独立 Bearer 令牌。公开监听必须配置令牌，TLS 反向代理部署启用 Secure cookie。受信网络部署可显式使用 `--no-browser-auth` 关闭页面与普通 API 的会话鉴权，但不得据此开放给不受信任客户端。

这不是多租户沙箱。不要把不可信用户或仓库放入同一权限域，也不要把 Docker socket 或额外宿主机权限交给 Runtime。

## 构建与质量门禁

```bash
npm ci
make check
make test-race
```

`make check` 覆盖 Go 格式与依赖、TypeScript、ESLint、Vitest、一次 Vite 构建、Go vet、Go tests 和二进制构建。`scripts/e2e.sh` 验证 React 路由、API revision 合同和桌面/移动端布局。
