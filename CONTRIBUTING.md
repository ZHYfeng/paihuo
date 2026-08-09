# 贡献指南

感谢你愿意改进 PaiHuo。这个项目会在宿主机上调度 coding agent；每一项改动都应同时考虑可维护性、数据兼容性和运行安全。

## 开始前

需要以下本地工具：

- Linux、Go 1.25+、Git；完整任务执行和部分集成测试还需要 `tmux`。
- Node.js 20+ 与 npm，用于打包嵌入式前端；浏览器端到端测试还需要 Chromium。
- 不需要安装任何 agent CLI 才能运行大多数 Go 测试。不要在测试中访问真实项目目录、账户凭据或生产数据库。

```bash
git clone https://github.com/ZHYfeng/paihuo.git
cd paihuo
npm ci
make check
make test-race
```

`make help` 可查看全部本地命令。`make check` 是提交前的最低质量门禁：它检查 Go 格式、模块依赖整洁度、前端生成物同步、`go vet`、单元测试和构建。

## 工作方式

1. 从最新的 `main` 创建聚焦的分支；一个拉取请求尽量只解决一个问题。
2. 先为行为变更添加或更新测试，再实现改动。
3. 门禁（必跑，不可跳过）：**每次 `git commit` 前**运行 `make check`；**每次 `git push` 前**运行 `make check && make test-race`。门禁失败不得提交或推送——先修复并重新跑通门禁，再继续。如果某项无法在本机运行，必须在提交信息或拉取请求中说明原因与替代验证。
4. 在拉取请求中写清用户可见的结果、验证方式、兼容性影响和回滚方式。

避免把无关格式化、依赖升级和功能改动混在同一个拉取请求中；这样更容易审查和回退。

## 前端约定

前端使用原生 ES 模块，源码在 `internal/web/static/src/`，提交产物为 `internal/web/static/app.bundle.js`。修改源码后运行：

```bash
scripts/build-frontend.sh
make frontend-check
```

模板和动态 HTML 仍使用部分内联事件处理器。`scripts/gen-globals.py` 会收集它们并生成 `main.js` 的 `window` 导出；不要手工修改该生成区间。新增动态按钮时，确认 `make frontend-check` 通过，并在可能时补充 `scripts/e2e.js` 的回归覆盖。

## 数据库和执行器改动

- 数据库由 `internal/store/store.go` 管理。已有用户的 SQLite 文件必须能平滑升级；迁移要幂等，并为旧库路径增加测试。
- 不要用测试触及用户的工作目录。优先使用 `t.TempDir()`，Git 行为在临时仓库中验证。
- 任务、worktree、tmux 和 agent 会话都有删除路径。新增状态或资源时，要同步考虑取消、失败、重试、恢复和清理。
- Agent 配置会被翻译成宿主机命令。任何新增参数都应明确参数边界、转义方式和权限影响，不要把不受信任的输入拼接进 shell 命令。

## 安全与隐私

不要提交访问令牌、API key、真实任务日志、数据库、私人路径或截图中的敏感信息。安全漏洞请遵循 [SECURITY.md](SECURITY.md)，不要以公开 issue 或 pull request 的方式披露。

## 提交信息和审查

提交信息请简洁说明意图，例如 `server: reject oversized JSON bodies` 或 `docs: document reverse-proxy deployment`。拉取请求模板列出了必要检查项；请如实填写，并主动标注任何破坏性变更或需要维护者决策的事项。
