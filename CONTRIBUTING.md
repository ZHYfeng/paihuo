# 贡献指南

感谢你愿意改进 PaiHuo。这个项目会在宿主机上调度 coding agent；每一项改动都应同时考虑模块边界、运行安全和可验证性。

## 开始前

需要以下本地工具：

- Linux、Go 1.25+、Git；完整任务执行和部分集成测试还需要 `tmux`。
- Node.js 22.12+ 与 npm，用于 React/Vite 前端；浏览器端到端测试还需要 Chromium。
- 不需要安装任何 agent CLI 才能运行大多数 Go 测试。不要在测试中访问真实项目目录、账户凭据或生产数据库。

```bash
git clone https://github.com/ZHYfeng/paihuo.git
cd paihuo
npm ci
make check
make test-race
```

`make help` 可查看全部本地命令。`make check` 是提交前的最低质量门禁：它检查 Go 格式、模块依赖整洁度、前端类型与 lint、Vitest、一次 Vite 构建、`go vet`、Go 测试和二进制构建。

真实 Runtime 不属于确定性单元门禁。已安装并登录 Pi 时，可显式运行 `make test-runtime` 做结构化 Session 冒烟。

## 工作方式

1. 从最新的 `main` 创建聚焦的分支；一个拉取请求尽量只解决一个问题。
2. 先为行为变更添加或更新测试，再实现改动。
3. 门禁（必跑，不可跳过）：**每次 `git commit` 前**运行 `make check`；**每次 `git push` 前**运行 `make check && make test-race`。门禁失败不得提交或推送——先修复并重新跑通门禁，再继续。如果某项无法在本机运行，必须在提交信息或拉取请求中说明原因与替代验证。
4. 在拉取请求中写清用户可见的结果、验证方式和安全边界。

避免把无关格式化、依赖升级和功能改动混在同一个拉取请求中；这样更容易审查和回退。

## 前端约定

前端使用 React、TypeScript、React Router、TanStack Query、Tailwind 和 Radix。源码在 `frontend/`，Vite hashed assets 构建到已忽略的 `internal/web/dist/`，由 Go 嵌入但不提交到 Git。修改源码后运行：

```bash
make frontend-check
npm test
make frontend
```

认证后只有一个 React root。服务端状态使用 Query client，SSE 使用统一 hook，终端使用 `TerminalAdapter`；不要创建全局 window API 或第二套页面实现。Markdown 必须经过现有 DOMPurify renderer。前端的 `VisualizationSpec` 目前只是本地类型化 renderer，服务端尚未验证 Role 输出；不要把未受信任的 Agent 内容接入该组件。

## 数据库和执行器改动

- 数据库由 `internal/store` 管理。项目没有按版本编号的迁移链；`Open` 现有 8 个幂等加列迁移只覆盖部署指南列出的增量。结构变更直接更新 schema 和当前形态测试；未被这些增量覆盖的版本替换按[部署指南](docs/DEPLOYMENT.md)创建全新数据库。
- 不要用测试触及用户的工作目录。优先使用 `t.TempDir()`，Git 行为在临时仓库中验证。
- Task、Workspace、tmux、Session、Workflow 与 Artifact 都有结算或清理路径。新增状态或资源时同步覆盖取消、失败、重试、恢复和删除。
- Role 配置由 Runtime 翻译成宿主机命令。新增 Runtime 通过 CommandRuntime/SessionDriver/Provisioner 注册，不把厂商 flag 泄漏到 TaskLifecycle。
- API mutation 使用幂等键；用户可编辑资源使用 revision。同步更新 OpenAPI 描述与前端类型。当前 OpenAPI 只覆盖部分 operation，在 API-1 补齐双向守卫前不能视为完整或权威合同。

## 安全与隐私

不要提交访问令牌、API key、真实任务日志、数据库、私人路径或截图中的敏感信息。安全漏洞请遵循 [SECURITY.md](SECURITY.md)，不要以公开 issue 或 pull request 的方式披露。

## 提交信息和审查

提交信息请简洁说明意图，例如 `server: reject oversized JSON bodies` 或 `docs: document reverse-proxy deployment`。拉取请求模板列出了必要检查项；请如实填写，并主动标注任何破坏性变更或需要维护者决策的事项。
