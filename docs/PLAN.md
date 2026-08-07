# 派活 PaiHuo — 产品规划与实施状态

> 本文档固化产品愿景与信息架构，并记录各阶段实施状态。设计原则：
> **人性化（向导引导）、自动化（能自动的绝不让手填）、智能化（探测/建议/自愈）**，
> 所有功能在 Web 页面完成，单二进制离线部署。

## 产品愿景

派活是一个**个人自托管的 Coding Agent 调度中心**，围绕四层能力展开：

1. **Agent 安装与管理**：按各 CLI 官网方案安装/配置 Claude Code、Codex、OpenCode、Pi、OMP；手动登录（OAuth/终端登录），自动化的步骤尽量自动化（下载、依赖、环境变量、登录状态检测）
2. **角色定制**：agent（CLI）× 模型 × Skills × System Prompt × Instructions 自由搭配；管理 Skills 库、Pi Extensions
3. **项目与任务**：项目绑定独立本地工作目录；任务指派角色执行；看板/审批/定时/历史
4. **任务级独立工作空间 + 终端式观察**：git worktree 隔离；ANSI 终端渲染、全屏、会话续跑（resume）

## 设计原则

1. **Web 全功能**：装 agent、登录、合并分支、清 worktree 都能在页面完成
2. **探测优先**：能探测的绝不手填（模型、CLI 状态、git 仓库、skill 内容）
3. **向导式流程**：装 Agent → 建角色 → 建项目 → 派任务 → 观察 → 收尾
4. **一次配置、处处复用**：技能/扩展/模板/角色可复用
5. **可追溯**：任务执行记录（worktree 分支、commit、diff）完整可查
6. **离线单二进制**：前端库（xterm.js 等）vendor 进 embed，不依赖 CDN

## 信息架构

默认首页 = **Dashboard 工作台**，按功能逻辑分区完成高频操作；低频管理收纳到侧边栏：

```
Dashboard（默认首页 /）
  ① 统计条   今日完成 / 进行中 / 待审批 / 成功率 / 平均耗时 / 项目数
  ② 任务执行区  进行中列 + 待审批列（实时，快捷审批/驳回）+ 新建任务
  ③ 项目区    活跃项目进度卡片 + 新建项目
  ④ Agent 区  各 CLI 安装/登录状态徽标 + 角色健康 + 低频管理快捷入口

侧边栏：
  工作区   Dashboard / Board（完整看板+列表） / History
  管理     Agents / Roles / Skills / Schedules
  系统     Settings
```

## 实施状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | Dashboard 主工作台 + Agent 安装管理（探测/安装/登录引导/默认角色） | ✅ 已实施（`internal/exec/provision.go`） |
| Phase 2 | git worktree 任务空间（Ensure/Snapshot/Integrate/Discard/Cleanup、审批 diff、子任务独立 worktree、保留策略） | ✅ 已实施（`internal/workspace`） |
| Phase 3 | 终端式观察（vendor xterm.js + fit、SSE 追加、全屏、会话续跑 resume） | ✅ 已实施 |
| Phase 4 | 角色增强（instructions 字段、Skills & Extensions tab） | ✅ 已实施（schema 见 `internal/exec/fields.go`） |
| Phase 5 | 首次使用引导（空态 → 下一步链）、项目 git 识别与分支徽标 | ✅ 已实施 |
| Phase 6 | 任务模板一键复用、worktree/会话/历史定时清理、README v2 工作流 | ✅ 已实施（每小时 autoCleanup） |

> 注：早期规划的「手工合并端点」（`POST /api/workspace/{id}/merge`）已随合并任务机制移除——
> 代码合并在合并任务成功结算时自动执行（`workspace.Integrate`），不再提供手工合并入口。

## 剩余事项

- 移动端适配复查、a11y 复查
- 安装命令随各 CLI 官方文档更新（命令变更风险：探测失败提示手动）

## 数据模型要点

- `tasks`：`worktree_branch`、`base_commit`（执行前快照）、`merge_of`（合并任务归属）
- `settings`：`retention_days`、`worktree_retention_days`、`sessions_dir`
- `agents`：安装状态实时探测，不落库；`skills`：引用计数实时算

## 关键 API

```
GET    /api/provision                    # 各 CLI 安装/登录/版本总览
POST   /api/provision/install            # {cli} → 流式安装（SSE）
GET    /api/agents/schema               # 按 CLI 文档声明的配置 schema（模型探测）
POST   /api/agents/schema/refresh       # 强制重新探测本机模型/能力
GET    /api/extensions                   # pi list；POST /api/extensions/install；DELETE /api/extensions/{name}
GET    /api/workspace/{id}               # worktree 状态
POST   /api/workspace/{id}/discard       # 丢弃 worktree
POST   /api/workspace/git-init           # 非 git 项目初始化
POST   /api/tasks/{id}/resume            # 原任务续跑（保留会话与 worktree）
POST   /api/tasks/cleanup                # 按策略清理
GET    /api/stats/overview | /api/stats/agent/{id} | /api/stats/project/{id}
```

## 风险与决策记录

| 项 | 决策 |
|---|---|
| 安装命令来源 | 实施时从官网核实后硬编码 + 文档链接；命令变更时探测失败提示手动 |
| 登录自动化程度 | 授权链接/复制命令 + 状态检测；不做账号密码自动化 |
| 非 git 项目 | 提示 git init；提供「初始化 git」按钮；codex safe 模式自动注入 `--skip-git-repo-check` |
| worktree 合并策略 | squash 合并（保留单 commit），由合并任务处理冲突；冲突时任务失败并保留 worktree |
| 技能挂载 | 角色级常驻只读视图 `<sessionsRoot>/.role-agents/<agentID>/`（symlink 零复制 + 幂等对账），不再逐任务复制 |
| xterm.js 体积 | 仅 vendor 核心 + fit（~400KB 压缩前），单二进制内嵌可接受 |
| resume 支持度 | 各 CLI 参数按官方文档映射，不支持则提示；pi/omp 用 session-dir |
