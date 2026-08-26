# 部署指南

> 当前生产基线：Debian，用户 `yu`。源码位于 `/home/yu/git/paihuo`；服务以
> systemd 用户服务 `paihuo.service` 运行，运行目录为
> `/home/yu/git/paihuo/workdir`，监听 `0.0.0.0:8080`。实际版本以
> `/home/yu/git/paihuo/workdir/paihuo --version` 为准。

## 部署形态

PaiHuo 以一个内嵌 React 前端的 Go 二进制运行，使用 SQLite、专用 tmux
server 和本机 Git worktree。生产环境不需要 Node.js。

```text
/home/yu/git/paihuo/
├── ...             # Git 管理的源码
└── workdir/        # 整体由 .gitignore 排除
    ├── paihuo      # 当前服务二进制
    ├── paihuo.db   # 当前 SQLite schema
    ├── token.env   # PAIHUO_TOKEN，权限 0600
    ├── sessions/   # Task/Session worktree、Runtime 状态和 .roles/ 技能挂载
    ├── skills/     # 可复用技能库
    └── artifacts/  # SHA-256 内容寻址制品
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

服务从 `/home/yu/git/paihuo/workdir/token.env` 读取令牌。`KillMode=process` 使普通服务
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
cd /home/yu/git/paihuo
npm ci
make check
make test-race
VERSION="v$(git show -s --format=%cd --date=format:%Y.%m.%d HEAD)-$(git rev-parse --short HEAD)"
make release VERSION="$VERSION"

install -d -m 0755 /home/yu/git/paihuo/workdir
install -m 0755 bin/paihuo /home/yu/git/paihuo/workdir/paihuo

umask 077
printf 'PAIHUO_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  > /home/yu/git/paihuo/workdir/token.env

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

标准目录中的已有实例使用仓库脚本部署：

```bash
cd /home/yu/git/paihuo
git pull --ff-only
scripts/deploy-local.sh
```

脚本会运行完整门禁并构建 release binary，然后停止服务、拒绝在仍有运行中
Task/Session 时继续、checkpoint SQLite、把旧 binary/SQLite/Artifact 保存到
`/home/yu/git/paihuo/workdir/backups/`，原子替换 binary，最后验证 systemd、HTTP 和 SQLite。
默认版本由提交日期和短 SHA 生成；需要指定发布名时使用：

```bash
VERSION=v2026.08.24-1 scripts/deploy-local.sh
```

重新部署保留 `paihuo.db`、`sessions/`、`skills/` 和 `artifacts/`。当前 binary 的 schema
最新版本是 v10，支持从 v1–v10 打开；不要根据列是否存在手工修改 `user_version`。
涉及 schema 迁移的发布仍须先按下文在停止写入后的数据库副本演练并对账，再执行脚本。

首次启动在一个事务中执行全部待执行迁移，并把每个迁移与相应
`PRAGMA user_version` 推进放在同一事务里；失败会回滚整条待执行路径并拒绝启动。
启动后再次查询版本应为 v10，并按「验证」检查服务。版本低于 v1、高于 v10或 v10
关键结构损坏都不会被自动修补。发生这些错误时保持服务停止，保留错误日志并恢复
“旧 binary + 整体备份”；不得清空、改写数据或让旧 binary 打开已经升级的数据库。
编号迁移没有 downgrade。

### v10 Task 形态预检

在**停止写入后的数据库副本**上执行；结果应只有版本号、`ok`，且三个违规查询均为
空。非 Workflow 的 `violations` 允许 schema 默认值 `[]` 和既有应用写入的等价空值
`''`，其他非空载荷都视为违规。发现违规时不要改写或清空，记录 type/数量并停止发布。

```bash
sqlite3 -readonly /backup/paihuo.db <<'SQL'
PRAGMA user_version;
SELECT type, COUNT(*) FROM tasks
WHERE type NOT IN ('task', 'session', 'workflow') GROUP BY type;
SELECT type, COUNT(*) FROM tasks
WHERE type <> 'workflow'
  AND (spec <> '' OR spec_hash <> '' OR violations NOT IN ('', '[]'))
GROUP BY type;
SELECT type, COUNT(*) FROM tasks
WHERE type <> 'session'
  AND (worktree_path <> '' OR session_dir <> '' OR last_message_at <> '' OR
       message_count <> 0 OR suspended_at IS NOT NULL OR delivered_at IS NOT NULL)
GROUP BY type;
PRAGMA foreign_key_check;
PRAGMA integrity_check;
SQL
```

v10 使用 SQLite 官方 table-rebuild 顺序：创建 `tasks_new`、显式列复制、删除旧表、
改名、重建全部标准索引及原有自定义索引/触发器、恢复 `sqlite_sequence`，最后执行
`foreign_key_check`。任何预检、复制、索引、外键或提交错误都会回滚，数据库版本保持
迁移前值。

### v10 人工发布 checklist

1. 停止生产写入；确认没有需继续运行的 Task，停止服务。
2. 把 SQLite（含已 checkpoint 的 WAL）与 `artifacts/` 作为同一恢复点整体备份；记录旧
   binary 版本和 `PRAGMA user_version`。
3. 在备份副本执行上述预检；用干净构建的新 binary 指向副本启动两次，第一次完成
   v1/v9→v10，第二次验证幂等。
4. 对迁移前后业务表导出做逐表逐行比较；核对关键表行数、Task ID、Artifact
   `content_hash`、`sqlite_sequence`，并确认 `foreign_key_check` 为空、
   `integrity_check` 为 `ok`。
5. 以副本实测的 table-rebuild 时间确定维护窗口，再安装新 binary 并启动生产服务。
6. 确认生产 `user_version=10`、启动日志无迁移错误、API/浏览器验证通过后再恢复写入。
7. 任一步失败都停止发布，恢复“旧 binary + SQLite/Artifact 整体备份”；v10 无
   downgrade，旧 binary 不得打开 v10 数据库。

## 全新部署（清空数据）

仅用于涉及 schema 或领域模型变更的版本替换：使用全新数据库，不导入原
数据库中的 Role、Project、Task、Session、Workflow 或 Artifact metadata。
`token.env` 和独立的 `skills/` 可以保留。此流程会**永久删除当前业务状态**。

替换前先确认没有需要继续运行的 Task，然后执行：

```bash
cd /home/yu/git/paihuo
npm ci
make check
make test-race
VERSION="v$(git show -s --format=%cd --date=format:%Y.%m.%d HEAD)-$(git rev-parse --short HEAD)"
make release VERSION="$VERSION"
./bin/paihuo --version

systemctl --user stop paihuo.service
tmux -L paihuo kill-server 2>/dev/null || true

find /home/yu/git/paihuo/workdir/sessions -depth -delete 2>/dev/null || true
find /home/yu/git/paihuo/workdir/artifacts -depth -delete 2>/dev/null || true
find /home/yu/git/paihuo/workdir -maxdepth 1 -type f \
  \( -name 'paihuo.db' -o -name 'paihuo.db-shm' -o -name 'paihuo.db-wal' \) \
  -delete

install -m 0755 bin/paihuo /home/yu/git/paihuo/workdir/paihuo
install -m 0644 deploy/systemd/paihuo.service \
  /home/yu/.config/systemd/user/paihuo.service
install -m 0644 deploy/systemd/paihuo.service.d/task-safe-restart.conf \
  /home/yu/.config/systemd/user/paihuo.service.d/task-safe-restart.conf

systemctl --user daemon-reload
systemctl --user start paihuo.service
```

## 验证

```bash
/home/yu/git/paihuo/workdir/paihuo --version
systemctl --user status paihuo.service --no-pager
journalctl --user -u paihuo.service -n 20 --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/login
```

预期服务为 `active (running)`，登录页返回 `200`。浏览器访问
`http://服务器IP:8080`，使用 `/home/yu/git/paihuo/workdir/token.env` 中的令牌登录。
登录后可读取 `/api/v1/openapi.yaml` 并验证 `/api/v1/tasks`。

## 数据保护

同一版本内恢复、或执行「重新部署（保存数据）」前，数据库和 Artifact 内容
必须作为一个集合处理：

```bash
systemctl --user stop paihuo.service
cp /home/yu/git/paihuo/workdir/paihuo.db /backup/paihuo.db
cp -a /home/yu/git/paihuo/workdir/artifacts /backup/artifacts
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
