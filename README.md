# 派活（PaiHuo）

[![CI](https://github.com/ZHYfeng/paihuo/actions/workflows/ci.yml/badge.svg)](https://github.com/ZHYfeng/paihuo/actions/workflows/ci.yml)

PaiHuo 是个人自托管的 Coding Agent 调度平台。它把项目、Role、Task、审批、Workflow、结构化 Session、Skills 与五种本机 Runtime 集中在一个控制台中，并以 Go 单二进制交付。

> PaiHuo 是可信管理员使用的宿主机控制台，不是多租户沙箱。Runtime 以服务进程的系统权限执行命令；只向受信任管理员开放。

## 能力

- OMP、OpenCode、Pi、Claude Code、Codex Runtime；Role 与具体 CLI 解耦。
- Task 状态机、角色/项目并发、审批、定时、重试和持久日志。
- Git worktree 隔离与确定性代码整合任务。
- Pi/OMP 结构化 Session，支持挂起、恢复和交付为 Task。
- Workflow 定义经策略校验即可用（可编辑/删除）→ 绑定项目启动原子 Run。
- 持久 SSE 事件序号、断线补拉、mutation 幂等键与 revision 冲突保护。
- 内容寻址 ArtifactStore 与受控 VisualizationSpec。
- React + TypeScript 响应式控制台，亮/暗主题和可访问工作流表格。

## 运行

需要 Linux、Go 1.25+、tmux；Git 项目的隔离执行还需要 Git。开发前端需要 Node.js 22.12+。

```bash
npm ci
make build
export PAIHUO_TOKEN="$(openssl rand -hex 32)"
./bin/paihuo
```

浏览器访问 `http://127.0.0.1:8080`。默认数据库是当前目录的 `paihuo.db`。当前版本只接受当前 schema；从其他数据库形态切换时使用全新数据库。

公开监听必须设置令牌，并应放在 HTTPS 反向代理后：

```bash
./bin/paihuo --addr 0.0.0.0:8080 --secure-cookie
```

完整 systemd、目录和运维说明见 [部署指南](docs/DEPLOYMENT.md)。

### 当前本机部署

当前实例运行 `v2026.08.17-2`，由用户级 systemd 托管：

```bash
systemctl --user status paihuo.service
journalctl --user -u paihuo.service -f
```

- 服务目录：`/home/yu/paihuo`
- 访问地址：`http://服务器IP:8080`
- 登录令牌：`/home/yu/paihuo/token.env`
- 服务定义：`/home/yu/.config/systemd/user/paihuo.service`

本项目不维护数据库迁移链。schema 或领域模型变化时使用全新数据库，只保留
`token.env` 和独立的 `skills/`；具体替换命令见部署指南。



Git Project 中每个 Task 使用 `<db-dir>/sessions/<project>/task-<id>` worktree。Runtime 在专用 `tmux -L paihuo` server 中执行；PaiHuo 重启后会重新接管存活窗口。

## 使用路径

系统只有一条主线：**项目 → 创建任务 → 执行 → 审批**。

1. **准备（管理面）**：在 Runtime 页检查或安装执行提供者；创建 Role
   （选择 Runtime、模型、指令、Skills 和并发数）；创建 Project 并绑定主机代码目录。
2. **创建任务（四种形态）**：
   - 单任务：创建 Task，选择权限、执行方式和依赖；
   - 复合任务：多节点协作，Workflow 定义经策略校验即可用（可编辑/删除），启动 Run 时绑定项目并原子实例化节点任务；
   - 自由探索任务：复杂问题先建立结构化 Session，产生成果后交付为 Task；
   - 定时任务：创建 Schedule，到点自动生成普通任务。
3. **执行**：在任务板观察执行；Runtime 在专用 `tmux -L paihuo` server 中执行，
   Git Project 中每个 Task 使用 `<db-dir>/sessions/<project>/task-<id>` worktree。
4. **审批**：待审批交付集中出现在工作台，批准后进入代码整合，或拒绝/打回。

端到端流程详见 [docs/design/workflow.md](docs/design/workflow.md)。

## API

HTTP API 仅使用 `/api/v1`。OpenAPI 合同位于 [internal/server/openapi.yaml](internal/server/openapi.yaml)，运行实例也提供 `GET /api/v1/openapi.yaml`。

mutation 可带 `Idempotency-Key`。编辑 Task、Role、Project、Schedule 或 Workflow 时，发送资源的 revision：

```http
PATCH /api/v1/tasks/42
If-Match: "3"
Idempotency-Key: 5a909a9d-756b-4c39-a90d-24a94bf9971c
Content-Type: application/json

{"status":"cancelled"}
```

SSE 位于 `/api/v1/events`，通过 `Last-Event-ID` 或 `?after=<seq>` 恢复。

## 开发

前端源码位于 `frontend/`，Vite hashed assets 输出到 `internal/web/dist/` 并由 Go 嵌入。生产环境不运行 Node。

```bash
npm run dev             # Vite 开发服务器，代理 API 到 :8080
npm run build:frontend  # 更新内嵌产物
make check              # 完整质量门禁
make test-race          # Go 并发检查
make test-runtime       # 显式调用已安装、已登录的 Pi 做 Session 冒烟
```

端到端检查需要 Chromium 和一个运行在 `:8099` 的实例：

```bash
npx playwright install chromium
PAIHUO_TOKEN=t ./bin/paihuo --addr 127.0.0.1:8099
E2E_URL=http://127.0.0.1:8099 E2E_TOKEN=t make e2e
```

当前架构见 [技术架构](docs/TECHNOLOGY_EVOLUTION.md)，统一领域术语见 [CONTEXT.md](CONTEXT.md)，贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

仓库尚未附带开源许可证；请勿假定代码已获复用或再分发授权。
