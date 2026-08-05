# 派活（paihuo）

个人自托管的 agent 调度平台：把各类任务派给你指定的 agent 角色（omp / opencode / pi / claude / codex），看板实时跟踪进度，审批关卡、定时任务、技能模板、数据可删，全部装在一个单二进制里。

**部署形态**：服务运行在你的常开 Linux 机器（服务器 / NAS / 家里的主机）上，浏览器从任何设备访问操作。任务直接在服务器本地执行，agent 直接操作服务器上**已部署运行的项目目录**——无需重新部署环境。

## 快速开始

```bash
# 构建（需要 Go 1.24+）
cd paihuo && go build -o paihuo ./cmd/paihuo

# 部署到服务器：上传二进制，然后
./paihuo --addr 0.0.0.0:8080 --token 你的访问令牌
# 或 export PAIHUO_TOKEN=xxx 后直接 ./paihuo
```

- 浏览器访问 `http://服务器IP:8080`，**输入令牌登录**（一次性验证：令牌只用于登录这一次，之后浏览器持有 HttpOnly 会话 cookie，30 天滑动有效；顶栏可登出。服务重启不丢会话）
- 数据库默认 `paihuo.db`（单文件，直接 `cp` 即可备份）；老库自动迁移（新增项目列/表，无需手工操作）
- **务必设置 `--token`**：服务暴露在网络上时没有令牌等于裸奔

## 使用流程

**Dashboard 为默认首页**，按功能逻辑分区：统计条 → 任务执行区（进行中 / 待审批，待审批卡片可直接通过/驳回）→ 项目区（活跃项目进度）→ Agent 区（各 CLI 安装/登录状态、角色健康）。低频管理收纳在侧边栏：工作区（Dashboard / Board / History）、管理（Agents / Roles / Skills / Schedules）、系统（Settings）。

1. **Dashboard**：一屏完成高频操作——看任务、快捷审批、新建任务（`N` 快捷键）、看项目进度、CLI 状态；空数据时显示快速开始引导
2. **Board**：任务卡片按排队 / 执行中 / 待审批三列展示（状态色条 + 项目 chip + 审批/轮次标签），可切换**列表视图**；点击卡片进入**详情两栏页**（主区：描述 + 工作空间 + 终端式实时对话；侧栏：属性 + 操作）
3. **Agents**：本机 coding agent 安装管理——官方命令一键安装/重装（输出实时显示）、登录状态检测与引导、版本查看、一键创建默认 Role
4. **Roles**：卡片/表格双视图列出所有角色，详情分 tab（Overview / Config / Environment / Stats）——**配置按该 CLI 的官方文档深度定制**；模型候选探测自本机实例实际配置；Skills 按名称勾选技能库；instructions 字段注入任务指令模板
5. **Skills**：技能库（定向添加含 SKILL.md 的目录，复制到工作目录登记，按名称/描述勾选）+ Pi Extensions 管理（pi install/list/remove 的 Web 封装）
6. **Projects**：卡片网格（git 徽标标注是否支持隔离）；详情含进度环、统计、任务清单、成员统计
7. **任务工作空间**：git 项目下每个任务自动获得独立 worktree（`paihuo/task-<id>` 分支），审批通过可**一键 squash 合并/丢弃**；非 git 项目可直接 git init；过期 worktree 按设置自动清理
8. **任务续跑**：终态任务「继续对话」创建续跑任务并复用原会话（pi/omp 真实续对话）；全屏终端 xterm.js 渲染（ANSI 颜色）
9. **Schedules / History / Settings**：定时任务、历史筛选批量管理、数据/工作空间保留策略

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

### 维度二：任务管理（项目进度 + agent 统计）

- **项目**：`/projects` 建项目（绑定工作目录），看板任务可归入项目（新建、详情属性、筛选均可）；git 仓库自动获得 worktree 任务隔离
- **任务工作空间**：git 项目下每个任务自动创建独立 worktree（分支 `paihuo/task-<id>`，目录 `<db>/sessions/<项目>/task-<id>`），互不污染；任务详情显示分支/HEAD/改动状态，终态后**合并回主分支**（squash，冲突自动中止并提示）或**丢弃**；设置页配置保留天数自动清理
- **项目进度**：完成度进度环、状态分布、近 14 天每日完成柱状图、任务清单（重试/删除/看对话）
- **agent 统计**：角色详情「概况」与「统计」tab——总任务 / 进行中 / 完成 / 失败 / 取消 / 成功率 / 平均耗时 / 审批轮次，**分项目产出表**（这个 agent 在每个项目上干了多少、什么结果），近 14 天完成柱状图；项目详情的「成员统计」反查每个在此工作的 agent

## Agent 安装与管理（/agents）

- 状态探测：版本（`--version`）与登录态（各 CLI 凭据文件），60s 缓存
- 一键安装/重装：官方安装命令（claude 官方脚本、codex/opencode/pi 走 npm、omp 官方脚本）流式执行，输出实时显示
- 登录引导：检测到未登录时展示官方登录方式，复制指引后一键重新检测
- 安装完成可一键创建默认 Role

## 权限模式（每个任务单独配置）

| 模式 | 行为 |
|---|---|
| `完整` | agent 一次性执行到底，直接记成功 |
| `完成后审批` | agent 一次性执行到底，然后进入「待审批」：展示完整输出 + `git diff` 文件改动，由你 **审批通过**（记成功）、**驳回重做**（填写修改意见，自动追加到提示词后重新执行）或取消 |

> 审批发生在**任务完整执行之后**，不是执行中途暂停：agent 一口气干完，你看结果决定收不收。审批不是沙箱——agent CLI 是你的进程，审查靠"结果 + diff"。驳回重做是全新会话干净重跑（带修改意见），不是续跑上次对话。

## 定时任务

设置页配置 cron 表达式（支持秒级，如 `0 9 * * *` 每天 9 点）。标题/提示词支持模板变量：

- `{{.date}}` 今天日期、`{{.time}}` 当前时间、`{{.name}}` 定时任务名

## 多 agent 协作

任务详情点「拆分子任务」：不同角色的子任务并行执行，同一角色串行（避免项目目录冲突）。父任务不执行，只聚合展示。删除父任务级联删除子任务。

## 数据与隐私

- 单条：任务详情 → 删除（级联删除执行日志与会话目录）
- 批量：设置页 → 数据清理（按角色 / 按时间范围）
- 自动：设置 `retention_days` 保留天数，每小时清理一次超期终态历史
- 备份：`cp paihuo.db` 即可（执行日志全在里面）

## 开发

产品规划与分阶段实施计划见 [docs/PLAN.md](docs/PLAN.md)（Agent 安装管理 / worktree 任务空间 / 终端式观察）。

```bash
go build -o paihuo ./cmd/paihuo
```

架构：Go 单二进制 + SQLite（纯 Go 驱动，无 CGO）+ 内嵌前端（Go 模板 + 原生 JS + SSE 实时推送）。执行器每角色串行、跨角色并行，取消按进程组击杀。

关键模块：

- `internal/exec/adapters.go`、`fields.go`：CLI 适配器 + 按文档声明的配置 schema（维度一的核心）
- `internal/store/store.go`：项目 / 任务 / 统计查询（维度二的核心）
- `internal/server/handlers.go`：`/api/projects`、`/api/agents/schema`、`/api/stats/*`
- `internal/web/`：前端（模板 + app.js + app.css）
