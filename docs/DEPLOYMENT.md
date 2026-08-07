# 部署指南

> 本文档描述 PaiHuo 的完整部署、升级与运维流程，并以**本机（Debian，
> 用户 `yu`）的实际部署实例**为例。实例目录 `/home/yu/paihuo`，服务以
> systemd **用户服务** `paihuo.service` 托管，监听 `0.0.0.0:8080`。

## 1. 部署形态与目录布局

单二进制 + SQLite（纯 Go 驱动，无 CGO）+ 内嵌前端 + 一个专用 tmux server。
任务在服务器本地执行，agent 直接操作服务器上已部署的项目目录。

运行目录（`/home/yu/paihuo/`）：

```
paihuo            # 服务二进制（最新构建，make build / make release 产物）
paihuo.db         # SQLite 数据库（单文件，备份 = cp）
paihuo.db-shm     # SQLite WAL 附属文件（运行中存在，停服后消失）
paihuo.db-wal
token.env         # PAIHUO_TOKEN 环境变量文件（权限 0600，勿入库/勿提交）
server.log        # 手动运行时的输出日志（systemd 托管时用 journalctl）
sessions/         # 任务 worktree、agent 会话、角色技能挂载（.role-agents/）
skills/           # 技能库（Web 页面导入/扫描的目标目录）
paihuo.pre-*      # 升级前的旧二进制备份（见 §5 升级流程）
```

数据库、会话、技能目录默认都位于二进制工作目录（`--db` 参数所在目录）旁；
`--db`、`--addr` 可用命令行参数覆盖，令牌也可用 `--token` 传入
（不推荐：会出现在进程参数与 shell 历史中）。

## 2. 本机实例的 systemd 托管

服务以 **用户级 systemd 服务** 运行（无需 root；agent CLI 与凭据都装在
同一系统用户下，任务权限边界 = 该用户权限）。

服务文件模板见仓库 `deploy/systemd/`，本机安装位置：

- `/home/yu/.config/systemd/user/paihuo.service`
- `/home/yu/.config/systemd/user/paihuo.service.d/task-safe-restart.conf`

关键点：

- **`EnvironmentFile`**：从 `token.env` 注入 `PAIHUO_TOKEN`，令牌不进
  ExecStart 命令行，也不进 shell 历史
- **Drop-in `KillMode=process`**：paihuo 重启时**不杀**其启动的任务进程
  —— 任务窗格由专用 tmux server（`tmux -L paihuo`）托管，服务重启后
  新进程会自动重新接管仍在运行的窗口；若用默认 `KillMode=control-group`
  会把运行中的 agent 任务一并杀掉
- **`Restart=on-failure`**：异常退出 3 秒后自动拉起

### 常用命令

```bash
# 安装/更新服务定义后
systemctl --user daemon-reload

# 开机自启 + 立即启动（首次）
systemctl --user enable --now paihuo.service

# 日常
systemctl --user status paihuo.service   # 状态
systemctl --user restart paihuo.service  # 重启（任务窗格不中断）
systemctl --user stop paihuo.service     # 停止

# 日志
journalctl --user -u paihuo.service -f
```

> 用户级服务需要登录会话才能随开机自启；桌面/服务器环境请执行
> `loginctl enable-linger yu` 让服务在无人登录时也保持运行。

## 3. 首次部署（从零）

```bash
# 1) 构建（仓库目录）
cd /home/yu/Agents/paihuo
make build VERSION=v0.1.0          # 或 make release 产出更小的剥离二进制

# 2) 准备运行目录与令牌
mkdir -p /home/yu/paihuo
cp bin/paihuo /home/yu/paihuo/
umask 077
printf 'PAIHUO_TOKEN=%s\n' "$(openssl rand -hex 32)" > /home/yu/paihuo/token.env

# 3) 安装 systemd 用户服务
mkdir -p /home/yu/.config/systemd/user/paihuo.service.d
cp deploy/systemd/paihuo.service /home/yu/.config/systemd/user/
cp deploy/systemd/paihuo.service.d/task-safe-restart.conf \
   /home/yu/.config/systemd/user/paihuo.service.d/
systemctl --user daemon-reload
systemctl --user enable --now paihuo.service

# 4) 验证
systemctl --user status paihuo.service
curl -s http://127.0.0.1:8080/login | head -5   # 或浏览器访问 http://服务器IP:8080
```

浏览器访问 `http://服务器IP:8080`，输入 `token.env` 中的令牌完成一次性登录。

> 公开监听（`--addr 0.0.0.0:8080`）未设置令牌时程序会**拒绝启动**；
> 若经 HTTPS 反向代理暴露，追加 `--secure-cookie`。

## 4. 备份与恢复

数据库是单文件 SQLite（WAL 模式），执行日志全在库内：

```bash
# 在线备份（推荐：WAL 模式下 cp 安全；更稳妥可用 sqlite3 .backup）
cp /home/yu/paihuo/paihuo.db /backup/paihuo-$(date +%F).db

# 恢复
systemctl --user stop paihuo.service
cp /backup/paihuo-XXXX.db /home/yu/paihuo/paihuo.db
systemctl --user start paihuo.service
```

建议：定期备份；升级前先验证备份可恢复；老库在启动时自动迁移（新增列/表，
无需手工操作）。

## 5. 升级流程（本机实践）

升级 = 换二进制 + 重启服务。**升级前备份当前二进制**（保留回滚点），
本机惯例命名为 `paihuo.pre-<commit>-<时间戳>`：

```bash
cd /home/yu/Agents/paihuo
git pull --rebase

# 构建并核对版本
make build VERSION=vX.Y.Z
./bin/paihuo --version

# 备份当前线上二进制
CUR=/home/yu/paihuo/paihuo
PRE="$CUR.pre-$(git rev-parse --short HEAD)-$(date +%Y%m%d-%H%M%S)"
cp "$CUR" "$PRE" && chmod +x "$PRE"

# 替换并重启（任务窗格由 tmux 托管，重启不中断运行中的任务）
cp bin/paihuo "$CUR"
systemctl --user restart paihuo.service

# 验证
journalctl --user -u paihuo.service -n 5
curl -s http://127.0.0.1:8080/api/tasks -o /dev/null -w '%{http_code}\n'   # 401 即服务正常（需令牌）

# 回滚（如遇问题）
cp "$PRE" "$CUR" && systemctl --user restart paihuo.service
```

**清理策略**：`.pre-*` 旧备份只保留最近一份作为回滚点，其余删除：

```bash
ls -t /home/yu/paihuo/paihuo.pre-* | tail -n +2 | xargs -r rm -f
```

## 6. 观察与运维

- **任务执行**：所有任务运行在专用 tmux server（`tmux -L paihuo`）的
  `paihuo` session 中，活动任务各占 `task-<id>` window。服务重启会重新
  接管仍在运行的 window；如需在服务器上直接观察：

  ```bash
  tmux -L paihuo attach -t paihuo
  ```

- **自动清理**：服务每小时执行一次——按 `retention_days` 删除超期历史、
  按 `worktree_retention_days`（默认 7 天）清理过期 worktree、清理孤儿
  agent 会话（仅当前数据库的任务，不影响同机其他实例）
- **模型目录**：服务启动时从本机各 CLI 探测模型/能力，之后每 7 天刷新；
  也可在 Web 角色页手动刷新
- **磁盘**：任务日志/会话/worktree 都在 `sessions/` 下，随自动清理与
  任务删除回收；`skills/` 为技能库副本

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 启动报「拒绝在公开地址无鉴权启动」 | 检查 `token.env` 是否存在且 `PAIHUO_TOKEN` 非空 |
| `restart` 后端口被占 | 有手动启动的旧进程占用 8080（`ss -tlnp | grep 8080`），停掉后重启服务 |
| 任务在服务重启后消失/中断 | 检查 drop-in `KillMode=process` 是否生效（`systemctl --user show paihuo -p KillMode`）；tmux 窗格在重启后会被自动接管 |
| 令牌忘了 | 查看 `/home/yu/paihuo/token.env`；或重新生成后 `systemctl --user restart paihuo` |
| 升级后数据库报错 | 数据库自动迁移，先确认备份可恢复再继续排查 |

## 8. 安全边界

PaiHuo 是**受信任管理员使用的宿主机控制台**，不是多租户沙箱：获授权用户
可以创建任务、浏览目录、安装 CLI，并让 agent 以服务进程的系统权限执行
命令。请只部署给受信任的管理员，完整威胁模型见仓库 [SECURITY.md](../SECURITY.md)。
