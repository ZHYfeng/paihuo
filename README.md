# 派活（paihuo）

[![CI](https://github.com/ZHYfeng/paihuo/actions/workflows/ci.yml/badge.svg)](https://github.com/ZHYfeng/paihuo/actions/workflows/ci.yml)

个人自托管的 agent 调度平台：把各类任务派给你指定的 agent 角色（omp / opencode / pi / claude / codex），看板实时跟踪进度，审批关卡、定时任务、技能模板、数据可删，全部装在一个单二进制里。

**部署形态**：服务运行在你的常开 Linux 机器（服务器 / NAS / 家里的主机）上，浏览器从任何设备访问操作。任务直接在服务器本地执行，agent 直接操作服务器上**已部署运行的项目目录**——无需重新部署环境。

任务执行依赖 `tmux`（每个任务会在 paihuo 专用 tmux server 中运行；不会复用或修改你的默认 tmux 会话）。

> **安全边界**：PaiHuo 是主机管理工具，不是多租户沙箱。获授权的用户可以创建任务、浏览目录、安装 CLI，并让 agent 以服务进程的系统权限执行命令。请只部署给受信任的管理员使用。

## 快速开始

运行环境：Linux、Go 1.24+、`tmux`；若要使用 Git worktree 隔离，还需要 `git`。各 agent CLI 可按需在 Web 的 Agents 页面安装。

```bash
# 构建
cd paihuo && go build -o paihuo ./cmd/paihuo

# 推荐：令牌不出现在进程参数或 shell 历史中
export PAIHUO_TOKEN="$(openssl rand -hex 32)"
./paihuo
```

默认仅监听 `127.0.0.1:8080`。若通过反向代理暴露服务，请在代理处配置 HTTPS，并显式监听公开地址：

```bash
./paihuo --addr 0.0.0.0:8080 --secure-cookie
```

`--secure-cookie` 适用于 TLS 在反向代理处终止的部署；直接 HTTP 本地开发不要开启它。公开监听未设置令牌会被程序拒绝启动；本机监听时不设置令牌仅适用于本机受信任的开发环境。执行 `./paihuo --version` 可查看构建版本。

- 浏览器访问 `http://服务器IP:8080`，**输入令牌登录**（一次性验证：令牌只用于登录这一次，之后浏览器持有 HttpOnly 会话 cookie，30 天滑动有效；顶栏可登出。服务重启不丢会话）
- 数据库默认 `paihuo.db`（单文件，直接 `cp` 即可备份）；老库自动迁移（新增项目列/表，无需手工操作）
- **务必设置 `PAIHUO_TOKEN`**：服务暴露在网络上时，没有令牌就不应启动

### 生产部署建议

- 将服务置于受信任网络或 TLS 反向代理之后；不要把未受保护的端口直接暴露到公网。
- 使用高熵、专用于 PaiHuo 的令牌，并以环境变量或密钥管理工具注入，而非写入 shell 历史或截图。
- 用运行 PaiHuo 的同一系统用户安装 agent CLI；它能访问的文件与凭据就是任务可触及的边界。
- 定期备份 `paihuo.db`，升级前先验证备份可恢复。更多威胁模型与披露方式见 [SECURITY.md](SECURITY.md)。

### 前端构建

前端源码位于 `internal/web/static/src/`，生成的 `app.bundle.js` 与模板、CSS、vendor 一起嵌入 Go 二进制，部署仍为单文件。开发时先安装锁定的工具链：

```bash
npm ci
scripts/build-frontend.sh        # 打包 app.bundle.js；--minify 可压缩
go build -o paihuo ./cmd/paihuo
```

构建脚本会校验模板动态事件所需的全局导出。修改前端源码后，务必提交生成的 `app.bundle.js`；`make frontend-check` 会检查二者是否同步。

## 使用流程

**Dashboard 为默认首页**，按功能逻辑分区：统计条 → 任务执行区（进行中 / 待审批，待审批卡片可直接通过/驳回）→ 项目区（活跃项目进度）→ Agent 区（各 CLI 安装/登录状态、角色健康）。低频管理收纳在侧边栏：工作区（Dashboard / Board / Projects / History）、管理（Agents / Roles / Skills / Schedules）、系统（Settings）。

1. **Dashboard**：一屏完成高频操作——看任务、快捷审批、新建任务（`N` 快捷键）、看项目进度、CLI 状态；空数据时显示快速开始引导
2. **Board**：任务卡片按排队 / 执行中 / 待审批三列展示（状态色条 + 项目 chip + 审批/轮次标签），可切换**列表视图**；点击卡片进入**详情两栏页**（主区：描述 + 工作空间 + 终端式实时对话；侧栏：属性 + 操作）
3. **Agents**：本机 coding agent 安装管理——官方命令一键安装/重装（输出实时显示）、登录状态检测与引导、版本查看、一键创建默认 Role
4. **Roles**：卡片/表格双视图列出所有角色，详情分 tab（概况 / 配置 / 统计）——**配置按该 CLI 的官方文档深度定制**（含环境变量，schema 字段与创建弹窗同源同步，新增/删除选项自动生效）；角色概况页可直接修改最大并发数，作为同一执行配置的任务池；模型候选探测自本机实例实际配置；Skills 按名称勾选技能库；instructions 字段注入任务指令模板。新建或设计角色可打开三栏「角色创建工作台」：创建助手持续保留对话，中间编辑草稿并查看差异，右侧在临时目录测试未发布 Agent；助手只能改草稿，保存才写入角色库
5. **Skills**：技能库（可定向添加，或递归扫描一个目录自动发现全部含 `SKILL.md` 的 skills；复制到工作目录登记，按名称/描述勾选）+ Pi Extensions 管理（pi install/list/remove 的 Web 封装）
6. **Projects**：卡片网格（git 徽标标注是否支持隔离）；详情含进度环、统计、任务清单、成员统计；侧边栏常驻入口，看板卡片/筛选条均可直达项目页
7. **任务工作空间**：git 项目下每个任务自动获得独立 worktree（`paihuo/task-<id>` 分支）；任务成功后自动派发同角色的代码合并任务，由它检查、整合并 squash 合并；人工审批任务仍需先通过审批；非 git 项目可直接 git init；过期 worktree 按设置自动清理
8. **任务续跑**：终态任务「继续对话」在原任务上重新入队，保留任务编号、会话目录、Git worktree 与历史日志（pi/omp 复用原会话）；全屏终端 xterm.js 渲染（ANSI 颜色）
9. **专用 tmux 执行器**：所有任务统一运行在 `tmux -L paihuo` 的 `paihuo` session 中，活动任务各占 `task-<id>` window。paihuo 重启会重新接管仍在运行的 window；如需在服务器上观察，可执行 `tmux -L paihuo attach -t paihuo`。任务结算后 window 清理，完整日志保留在数据库中。
10. **隔离的 agent 会话文件**：CLI 会话保存在数据库专属命名空间内；孤儿清理仅处理当前数据库的任务，不会触及同机其他 paihuo 实例或 smoke 测试。
11. **可选交互式 Pi**：手工任务默认仍是批处理 `pi -p`；选择“交互式 Pi 终端”后，任务会保留真实 TTY。点击终端即可直接输入，Tab 与方向键会传给 Pi 的内置命令联想；输入 `/quit`（或点击结束会话）后再结算。每个交互会话仍唯一绑定任务 ID，并与批处理任务共同占用角色的并发槽位。定时任务始终保持批处理。
12. **Schedules / History / Settings**：定时任务、历史筛选批量管理、数据/工作空间保留策略

## 派活的两个维度

派活 = **角色定制 × 任务管理**：

### 维度一：多 agent 多高度自定义角色（按文档深度定制）

每个 CLI 适配器在自己的**官方文档**基础上声明一份**配置 schema**（`internal/exec/fields.go` + 各适配器），前端 `/roles` 页按 schema 渲染**该角色自己的表单**——不是所有角色共用一套字段：

| CLI | 深度定制字段（来自官方文档） | 文档 |
|---|---|---|
| omp | model、system_prompt、instructions、thinking(`--smol/--slow`)、skills(`--add-dir`)、plugins(`--config`)、extra_args、env | [github.com/ohmygpt/omp](https://github.com/ohmygpt/omp) |
| opencode | model、thinking(`--variant`)、**agent**（opencode agent 定义）、**config**（配置文件叠加）、extra_args、env | [opencode.ai/docs](https://opencode.ai/docs) |
| pi | model、system_prompt、instructions、extra_args、env（其余字段不在表单里出现） | [github.com/askpi/pi](https://github.com/askpi/pi) |
| claude | model、system_prompt、instructions、skills、**permission_mode**（default / acceptEdits / plan / bypassPermissions）、**settings.json**、extra_args、env | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code/overview) |
| codex | model、system_prompt、instructions、thinking(`reasoning_effort`)、**temperature**、**mcp_config_file**、extra_args、env | [developers.openai.com/codex](https://developers.openai.com/codex/) |

- 角色详情「配置」tab 与「新建角色」弹窗都按所选 CLI 的 schema 渲染：分组表单 + 字段说明 + 官方文档链接
- CLI 特有参数存在 `role_config.custom`（如 opencode 的 `agent`、claude 的 `permission_mode`、codex 的 `temperature`），执行时翻译为该 CLI 的原生参数
- 不支持的字段不出现在表单里；执行时会以 `⚠` 警告提示无法映射的配置
- 通用逃生舱：`extra_args`（原样追加）、`env`（环境变量覆盖）
- **最大并发数**属于角色执行池，默认 `1`：限制同一角色同时启动的任务数，以匹配机器资源与模型/账户配额；修改后只影响后续派发，不会中断已运行任务
- **项目级串行（默认）**：每个任务新建时可勾选「并发执行」；不勾选（默认）的任务要求所在项目当前没有任何活跃任务才允许启动，同一项目一次只执行一个任务。勾选并发的任务跳过项目门禁，但仍受角色最大并发数约束，并继续阻止同项目的串行任务启动

### 维度二：任务管理（项目进度 + agent 统计）

- **项目**：`/projects` 建项目（绑定工作目录），看板任务可归入项目（新建、详情属性、筛选均可）；git 仓库自动获得 worktree 任务隔离
- **任务工作空间**：git 项目下每个任务自动创建独立 worktree（分支 `paihuo/task-<id>`，目录 `<db>/sessions/<项目>/task-<id>`），互不污染；每个普通 Git 任务成功后会自动派发专属合并 agent，后者在独立 worktree 中整合、验收并 squash 合并；人工审批任务通过后同样派发合并 agent；主工作区不干净或无法安全合并时合并任务失败并保留 worktree；设置页配置保留天数自动清理
- **项目进度**：完成度进度环、状态分布、近 14 天每日完成柱状图、任务清单（重试/删除/统一任务详情）
- **agent 统计**：角色详情「概况」与「统计」tab——总任务 / 进行中 / 完成 / 失败 / 取消 / 成功率 / 平均耗时 / 审批轮次，**分项目产出表**（这个 agent 在每个项目上干了多少、什么结果），近 14 天完成柱状图；项目详情的「成员统计」反查每个在此工作的 agent

## Agent 安装与管理（/agents）

- 状态探测：版本（`--version`）与登录态（各 CLI 凭据文件），60s 缓存
- 一键安装/重装：官方安装命令（claude 官方脚本、codex/opencode/pi 走 npm、omp 官方脚本）流式执行，输出实时显示
- 登录引导：检测到未登录时展示官方登录方式，复制指引后一键重新检测
- 安装完成可一键创建默认 Role

## 权限模式（每个任务单独配置）

| 模式 | 行为 |
|---|---|
| `自动（派发合并任务）` | agent 一次性执行到底；Git worktree 中的任务通过后自动创建专属合并任务，由该任务检查、解决冲突、跑测试后再 squash 合并到主分支 |
| `人工审批` | agent 执行后进入「待审批」：展示完整输出 + `git diff`；审批通过会自动创建一个同项目、同角色的合并任务，由 agent 处理冲突、跑测试，成功后自动 squash 合并；也可驳回重做或取消 |

> 审批发生在**任务完整执行之后**，不是执行中途暂停：agent 一口气干完，你看结果决定收不收。通过后，系统先固化审批分支，再在新的隔离 worktree 中派发合并任务；它不会让 agent 直接改主工作区。驳回重做是全新会话干净重跑（带修改意见），不是续跑上次对话。

## 定时任务

在定时任务页选择执行周期、日期和时间即可创建任务，标题/提示词支持模板变量：

- `{{.date}}` 今天日期、`{{.time}}` 当前时间、`{{.name}}` 定时任务名
- 每个定时任务可选择生成任务时的权限模式；该值写入每一条生成的任务，不属于角色配置

## 多 agent 协作

任务详情点「拆分子任务」：所有任务按各自角色的最大并发数派发；同一角色也可并行。**默认每个任务不并发**——同一项目同时只执行一个任务，除非创建时勾选了「并发执行」；勾选后可与同项目其他任务并行（仅受角色并发上限约束）。Git 项目中每个任务使用独立 worktree，运行期间互不改写工作目录；非 Git 项目会共用目录，应把相关角色并发设为 `1`。父任务不执行，只聚合展示。删除父任务级联删除子任务。

## 数据与隐私

- 单条：任务详情 → 删除（级联删除执行日志、会话目录、worktree 与任务分支）
- 批量：设置页 → 数据清理（按角色 / 按时间范围）
- 自动：设置 `retention_days` 保留天数，每小时清理一次超期终态历史
- 备份：`cp paihuo.db` 即可（执行日志全在里面）

## 开发

产品规划与分阶段实施计划见 [docs/PLAN.md](docs/PLAN.md)（Agent 安装管理 / worktree 任务空间 / 终端式观察）。

```bash
npm ci                    # 前端构建与浏览器测试工具
make check                # 格式、依赖整洁度、前端同步、vet、单测、构建
make test-race            # 并发回归
make build VERSION=dev    # 产物：bin/paihuo
```

浏览器端到端回归需要先下载 Chromium，并针对一个已启动的实例运行：

```bash
npx playwright install chromium
PAIHUO_TOKEN=t ./bin/paihuo --addr 127.0.0.1:8099
E2E_URL=http://127.0.0.1:8099 E2E_TOKEN=t make e2e
```

架构：Go 单二进制 + SQLite（纯 Go 驱动，无 CGO）+ 内嵌前端（Go 模板 + 原生 JS + SSE 实时推送）+ 一个专用 tmux server。执行器按角色最大并发数派发，并对未勾选并发的任务施加项目级串行门禁（同一项目一次一个）；任务取消时只终止对应 tmux window，服务重启不影响仍在运行的任务。

关键模块：

- `internal/exec/adapters.go`、`fields.go`：CLI 适配器 + 按文档声明的配置 schema（维度一的核心）
- `internal/store/store.go`：项目 / 任务 / 统计查询（维度二的核心）
- `internal/server/handlers.go`：`/api/projects`、`/api/agents/schema`、`/api/stats/*`
- `internal/web/`：前端（模板 + app.js + app.css）

## 参与和支持

- [贡献指南](CONTRIBUTING.md)：本地环境、质量门禁、数据库和前端改动约定
- [安全策略](SECURITY.md)：安全边界和私密漏洞披露方式
- [行为准则](CODE_OF_CONDUCT.md)：社区协作规范
- [支持指南](SUPPORT.md)：提问、问题报告与功能建议的渠道
- [变更日志](CHANGELOG.md)：版本发布时的兼容性与升级说明

## 许可证

当前仓库尚未附带开源许可证。许可证会决定代码的复用、再分发和商业使用权；维护者应在首次公开发行前明确选择并添加许可证（例如 MIT、Apache-2.0 或 GPL-3.0-only）。在此之前，请勿假定代码已获复用授权。
