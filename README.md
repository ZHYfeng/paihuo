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

界面高度复刻 multica（开源 agent 管理平台）：**左侧分组导航（工作区 / 智能体 / 配置）+ 页头面包屑 + 统计条 + 内容区**，暗色主题。

1. **侧边栏**：工作区（看板 / 项目 / 历史）、智能体（角色 / 定时任务 / 技能模板）、配置（设置）；随时右上角「＋新建任务」
2. **看板**：任务卡片按排队 / 执行中 / 待审批三列展示（状态色条 + 项目 chip + 审批/轮次标签），可切换**列表视图**（表格 + 项目/角色/状态筛选）；顶部统计条实时显示进行中 / 待审批 / 今日完成 / 完成率 / 平均耗时 / 项目数；点击卡片进入**详情两栏页**（主区：描述 + 终端式实时对话；侧栏：属性 + 操作，属性可改项目）
3. **项目页**：卡片网格列出所有项目（进度条 + 任务数 + 参与角色数）；点进**项目详情**：完成度进度环 + 统计 chips + 近 14 天完成柱状图 + 任务清单 + **成员统计表**（每个在此项目工作的 agent：任务数 / 完成 / 失败 / 审批轮次 / 成功率 / 平均耗时）
4. **角色页**：Linear 风格表格列出所有角色，点开详情分 tab（概况 / 配置 / 环境变量 / 统计）——**配置按该 CLI 的官方文档深度定制**（见下）
5. **定时任务页**：cron 表达式 + 模板变量，启停开关
6. **技能模板页**：从任务详情「保存为模板」沉淀的提示词，新建任务一键套用
7. **历史页**：终态任务筛选（角色/状态/天数）/ 批量删除 / 单条重试，点标题回看完整终端对话

## 派活的两个维度

派活 = **角色定制 × 任务管理**：

### 维度一：多 agent 多高度自定义角色（按文档深度定制）

每个 CLI 适配器在自己的**官方文档**基础上声明一份**配置 schema**（`internal/exec/fields.go` + 各适配器），前端 `/agents` 页按 schema 渲染**该角色自己的表单**——不是所有角色共用一套字段：

| CLI | 深度定制字段（来自官方文档） | 文档 |
|---|---|---|
| omp | model、system_prompt、thinking(`--smol/--slow`)、skills(`--add-dir`)、plugins(`--config`)、extra_args、env | [github.com/ohmygpt/omp](https://github.com/ohmygpt/omp) |
| opencode | model、thinking(`--variant`)、**agent**（opencode agent 定义）、**config**（配置文件叠加）、extra_args、env | [opencode.ai/docs](https://opencode.ai/docs) |
| pi | model、system_prompt、extra_args、env（其余字段不在表单里出现） | [github.com/askpi/pi](https://github.com/askpi/pi) |
| claude | model、system_prompt、skills、**permission_mode**（default / acceptEdits / plan / bypassPermissions）、**settings.json**、extra_args、env | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code/overview) |
| codex | model、system_prompt、thinking(`reasoning_effort`)、**temperature**、**mcp_config_file**、extra_args、env | [developers.openai.com/codex](https://developers.openai.com/codex/) |

- 角色详情「配置」tab 与「新建角色」弹窗都按所选 CLI 的 schema 渲染：分组表单 + 字段说明 + 官方文档链接
- CLI 特有参数存在 `role_config.custom`（如 opencode 的 `agent`、claude 的 `permission_mode`、codex 的 `temperature`），执行时翻译为该 CLI 的原生参数
- 不支持的字段不出现在表单里；执行时会以 `⚠` 警告提示无法映射的配置
- 通用逃生舱：`extra_args`（原样追加）、`env`（环境变量覆盖）

### 维度二：任务管理（项目进度 + agent 统计）

- **项目**：`/projects` 建项目，看板任务可归入项目（新建、详情属性、筛选均可）
- **项目进度**：完成度进度环、状态分布、近 14 天每日完成柱状图、任务清单（重试/删除/看对话）
- **agent 统计**：角色详情「概况」与「统计」tab——总任务 / 进行中 / 完成 / 失败 / 取消 / 成功率 / 平均耗时 / 审批轮次，**分项目产出表**（这个 agent 在每个项目上干了多少、什么结果），近 14 天完成柱状图；项目详情的「成员统计」反查每个在此工作的 agent

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

```bash
go build -o paihuo ./cmd/paihuo
```

架构：Go 单二进制 + SQLite（纯 Go 驱动，无 CGO）+ 内嵌前端（Go 模板 + 原生 JS + SSE 实时推送）。执行器每角色串行、跨角色并行，取消按进程组击杀。

关键模块：

- `internal/exec/adapters.go`、`fields.go`：CLI 适配器 + 按文档声明的配置 schema（维度一的核心）
- `internal/store/store.go`：项目 / 任务 / 统计查询（维度二的核心）
- `internal/server/handlers.go`：`/api/projects`、`/api/agents/schema`、`/api/stats/*`
- `internal/web/`：前端（模板 + app.js + app.css）
