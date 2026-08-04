# 派活（paihuo）

个人自托管的 agent 调度平台：把各类任务派给你指定的 agent 角色（omp / opencode / pi / claude / codex），看板实时跟踪进度，审批关卡、定时任务、技能模板、数据可删，全部装在一个单二进制里。

**部署形态**：服务运行在你的常开 Linux 机器（服务器 / NAS / 家里的主机）上，浏览器从任何设备访问操作。任务直接在服务器本地执行，agent 直接操作服务器上**已部署运行的项目目录**——无需重新部署环境。

## 快速开始

```bash
# 构建（需要 Go 1.24+）
cd paihuo && go build -o paihuo ./cmd/paihuo

# 部署到服务器：上传二进制，然后
./paihuo serve --addr 0.0.0.0:8080 --token 你的访问令牌
# 或 export PAIHUO_TOKEN=xxx 后直接 ./paihuo serve
```

- 浏览器访问 `http://服务器IP:8080`，输入令牌进入
- 数据库默认 `paihuo.db`（单文件，直接 `cp` 即可备份）
- **务必设置 `--token`**：服务暴露在网络上时没有令牌等于裸奔

## 使用流程

1. **设置 → 新建角色**：给角色取名（如"编码工"），选 CLI（omp/opencode/pi/claude/codex），绑定服务器上的项目目录，配置角色专属的模型、系统提示词、技能目录、思考级别、额外参数
2. **看板 → 新建任务**：填标题和提示词，指派给角色，选权限模式
3. agent 自动领取执行，日志实时流式显示；完成后可"保存为模板"复用提示词

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

## CLI 适配器

| CLI | 说明 | 角色配置支持 |
|---|---|---|
| omp | Oh My Pi，非交互 `-p` | model / system_prompt / skills(`--add-dir`) / thinking(`--smol/--slow`) / config 叠加 |
| opencode | `run --dir` | model / thinking(`--variant`)；系统提示词请用 opencode agent 定义 |
| pi | `-p` | model / system_prompt |
| claude | `-p` | model / system_prompt / skills(`--add-dir`) / 权限映射（只读→plan 模式） |
| codex | `exec` | model / system_prompt / reasoning_effort |

通用字段：`extra_args`（原样追加）、`env`（环境变量覆盖）。会话按任务隔离（`--session-dir`），同角色多任务互不干扰。

## 数据与隐私

- 单条：任务详情 → 删除（级联删除执行日志与会话目录）
- 批量：设置页 → 数据清理（按角色 / 按时间范围）
- 自动：设置 `retention_days` 保留天数，每小时清理一次超期终态历史
- 备份：`cp paihuo.db` 即可（执行日志全在里面）

## 开发

```bash
make  # 无 Makefile：直接 go build -o paihuo ./cmd/paihuo
```

架构：Go 单二进制 + SQLite（纯 Go 驱动，无 CGO）+ 内嵌前端（Go 模板 + htmx 风格原生 JS + SSE 实时推送）。执行器每角色串行、跨角色并行，取消按进程组击杀。
