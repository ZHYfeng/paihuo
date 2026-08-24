# 部署指南

> 当前生产基线：Debian，用户 `yu`，PaiHuo `v2026.08.19-2`（编排者会话 v1 增强：
> 同步/异步派活、无改动跳过合并任务）。服务以 systemd 用户服务
> `paihuo.service` 运行，目录为 `/home/yu/paihuo`，监听 `0.0.0.0:8080`。

## 部署形态

PaiHuo 以一个内嵌 React 前端的 Go 二进制运行，使用 SQLite、专用 tmux
server 和本机 Git worktree。生产环境不需要 Node.js。

```text
/home/yu/paihuo/
├── paihuo          # 当前服务二进制
├── paihuo.db       # 当前 SQLite schema
├── token.env       # PAIHUO_TOKEN，权限 0600
├── sessions/       # Task/Session worktree、Runtime 状态和 .roles/ 技能挂载
├── skills/         # 可复用技能库
└── artifacts/      # SHA-256 内容寻址制品
```

`paihuo.db-shm` 与 `paihuo.db-wal` 是服务运行期间的 SQLite 文件。日志由
systemd journal 管理，不在运行目录保存日志文件。

## SQLite 迁移发布原则

数据库升级采用 [ADR-0003](adr/0003-numbered-sqlite-migrations.md) 的编号迁移：空库直接
创建最新 schema；非空库按 `PRAGMA user_version` 从当前版本顺序升级。当前最低支持的
历史版本是 v1，原有 8 个幂等增量编号为 v2–v9；Task 形态约束作为 v10 的表重建迁移。
低于支持范围、高于当前 binary 或最终 schema 形态损坏时，服务必须拒绝启动。

迁移只向前且不提供 downgrade。schema 发布必须独立于普通功能发布：停止写入后把
SQLite（包括 WAL 中已提交内容）与 Artifact 作为一个集合备份，先在数据库副本演练并
完成行数、ID、hash、`foreign_key_check` 和 `integrity_check` 对账，再安排维护窗口。
失败时恢复“旧 binary + 整体备份”，不得让旧 binary 打开已经升级的数据库。具体版本
命令和 v10 发布 checklist 随迁移实现一同维护在本文件。

## systemd 用户服务

仓库模板与安装位置：

| 仓库文件 | 安装位置 |
|---|---|
| `deploy/systemd/paihuo.service` | `/home/yu/.config/systemd/user/paihuo.service` |
| `deploy/systemd/paihuo.service.d/task-safe-restart.conf` | `/home/yu/.config/systemd/user/paihuo.service.d/task-safe-restart.conf` |

服务从 `/home/yu/paihuo/token.env` 读取令牌。`KillMode=process` 使普通服务
重启不终止 tmux 中仍在执行的 Task；`Restart=on-failure` 在异常退出后自动
拉起服务。

```bash
systemctl --user status paihuo.service
systemctl --user restart paihuo.service
systemctl --user stop paihuo.service
journalctl --user -u paihuo.service -f
```

若需在用户退出登录后继续运行服务，为 `yu` 启用 linger：

```bash
loginctl enable-linger yu
```

## 从零安装

构建机需要 Linux、Go 1.25+、Node.js 22.12+、npm、Git 和 tmux。

```bash
cd /home/yu/Agents/paihuo
npm ci
make check
make build VERSION=v2026.08.15

install -d -m 0755 /home/yu/paihuo
install -m 0755 bin/paihuo /home/yu/paihuo/paihuo

umask 077
printf 'PAIHUO_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > /home/yu/paihuo/token.env

install -d -m 0755 /home/yu/.config/systemd/user/paihuo.service.d
install -m 0644 deploy/systemd/paihuo.service \
  /home/yu/.config/systemd/user/paihuo.service
install -m 0644 deploy/systemd/paihuo.service.d/task-safe-restart.conf \
  /home/yu/.config/systemd/user/paihuo.service.d/task-safe-restart.conf

systemctl --user daemon-reload
systemctl --user enable --now paihuo.service
```

公开监听必须配置令牌。经 HTTPS 反向代理访问时，在 systemd 的
`ExecStart` 中增加 `--secure-cookie`。

## 重新部署（默认保存数据）

PaiHuo 没有按版本编号的数据库迁移链，只支持能被校验为当前 schema 的数据库。
**同一 schema / 领域模型版本内的重新部署默认保留全部业务状态**：`paihuo.db`
（Role、Project、Task、Session、Workflow、Schedule 等）、`sessions/` worktree、
`artifacts/` 以及 tmux 中仍在执行的 Task 全部保留。

打开存量库时，`Open` 会按固定顺序执行以下 8 个幂等加列迁移，再运行
`verifyCurrentSchema`：

1. `workflow_runs.project_id`；
2. `workflow_runs.task`；
3. `skills.category`；
4. `projects.github_repo`、`github_role_id`、`github_auto_issues`、
   `github_auto_prs`、`github_auto_security`；
5. `tasks.external_key`；
6. `tasks.parent_session_id`、`parent_task_id`；
7. `roles.delegation_enabled`、`delegation_max_perm`；
8. `tasks.merge_skipped`。

这些明确覆盖的增量可保存数据部署，但它们不是从任意历史 schema 升级的通用路径。
其余涉及 schema 或领域模型变更的版本替换执行「全新部署（清空数据）」。

替换前先确认没有需要继续运行的 Task，然后执行：

```bash
cd /home/yu/Agents/paihuo
npm ci
make check
make test-race
make build VERSION=v2026.08.15
./bin/paihuo --version

systemctl --user stop paihuo.service

install -m 0755 bin/paihuo /home/yu/paihuo/paihuo
install -m 0644 deploy/systemd/paihuo.service \
  /home/yu/.config/systemd/user/paihuo.service
install -m 0644 deploy/systemd/paihuo.service.d/task-safe-restart.conf \
  /home/yu/.config/systemd/user/paihuo.service.d/task-safe-restart.conf

systemctl --user daemon-reload
systemctl --user start paihuo.service
```

此流程不删除任何业务数据，不重启 tmux server。升级前建议先按「数据保护」
备份数据库与 Artifact。若新版本 schema 不兼容，服务启动会提示 schema 不受
支持——此时停止服务并执行「全新部署（清空数据）」。

## 全新部署（清空数据）

仅用于涉及 schema 或领域模型变更的版本替换：使用全新数据库，不导入原
数据库中的 Role、Project、Task、Session、Workflow 或 Artifact metadata。
`token.env` 和独立的 `skills/` 可以保留。此流程会**永久删除当前业务状态**。

替换前先确认没有需要继续运行的 Task，然后执行：

```bash
cd /home/yu/Agents/paihuo
npm ci
make check
make test-race
make build VERSION=v2026.08.15
./bin/paihuo --version

systemctl --user stop paihuo.service
tmux -L paihuo kill-server 2>/dev/null || true

find /home/yu/paihuo/sessions -depth -delete 2>/dev/null || true
find /home/yu/paihuo/artifacts -depth -delete 2>/dev/null || true
find /home/yu/paihuo -maxdepth 1 -type f \
  \( -name 'paihuo.db' -o -name 'paihuo.db-shm' -o -name 'paihuo.db-wal' \) \
  -delete

install -m 0755 bin/paihuo /home/yu/paihuo/paihuo
install -m 0644 deploy/systemd/paihuo.service \
  /home/yu/.config/systemd/user/paihuo.service
install -m 0644 deploy/systemd/paihuo.service.d/task-safe-restart.conf \
  /home/yu/.config/systemd/user/paihuo.service.d/task-safe-restart.conf

systemctl --user daemon-reload
systemctl --user start paihuo.service
```

## 验证

```bash
/home/yu/paihuo/paihuo --version
systemctl --user status paihuo.service --no-pager
journalctl --user -u paihuo.service -n 20 --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/login
```

预期服务为 `active (running)`，登录页返回 `200`。浏览器访问
`http://服务器IP:8080`，使用 `/home/yu/paihuo/token.env` 中的令牌登录。
登录后可读取 `/api/v1/openapi.yaml` 并验证 `/api/v1/tasks`。

## 数据保护

同一版本内恢复、或执行「重新部署（保存数据）」前，数据库和 Artifact 内容
必须作为一个集合处理：

```bash
systemctl --user stop paihuo.service
cp /home/yu/paihuo/paihuo.db /backup/paihuo.db
cp -a /home/yu/paihuo/artifacts /backup/artifacts
systemctl --user start paihuo.service
```

备份只能由创建它的相同应用版本与 schema 恢复。`token.env` 应通过凭据管理
方式单独保存，不要提交到仓库。

## 日常运维

- Task 在 `tmux -L paihuo` 的 `paihuo` session 中运行。可用
  `tmux -L paihuo attach -t paihuo` 观察，但应从 Web 结束 Task，不要直接
  `kill-window` 或 `kill-pane`。
- 服务每小时根据 `retention_days` 清理终态 Task，并同步清理其 Runtime 会话、
  tmux 运行文件、worktree 和分支；根据 `worktree_retention_days` 清理过期
  worktree，并回收无引用 Artifact。代码成功合并后，源任务和合并任务的
  worktree/分支立即清理。
- 设置页的手动历史清理与自动历史清理使用同一套资源清理逻辑，不会只删除
  SQLite 任务记录而留下 `sessions/.runtime-sessions/.../task-*`。
- Runtime 模型和能力在服务启动时探测，此后每七天刷新，也可从 Web 手动刷新。
- 令牌遗失时重新生成 `token.env` 并重启服务；所有已有登录会话会失效。
- 启动提示 schema 不受支持时，停止服务并按“全新部署（清空数据）”流程创建空数据库。

## 安全边界

PaiHuo 是受信任管理员使用的宿主机控制台，不是多租户沙箱。Runtime 可以使用
服务账户能访问的项目、命令和凭据。只向受信任网络开放，远程访问应使用 HTTPS
反向代理，并遵循仓库的 [安全策略](../SECURITY.md)。
