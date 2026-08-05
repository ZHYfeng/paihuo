# 派活 PaiHuo — 产品规划 v2（实施计划）

> 目标文档：本文档把产品愿景固化为可执行的分阶段实施计划。
> 原则：**人性化（向导引导）、自动化（能自动的绝不让手填）、智能化（探测/建议/自愈）**，
> **所有功能必须能在 Web 页面完成**，保持单二进制离线部署。

---

## 1. 产品愿景

派活是一个**个人自托管的 Coding Agent 调度中心**，围绕四层能力展开：

### 1.1 Agent 安装与管理
- 按用户选择，**遵循各 CLI 官网方案**安装/配置 coding agent：Claude Code、Codex、OpenCode、Pi、OMP 等
- 手动登录可以接受（OAuth/终端登录），**能自动化的步骤尽量自动化**（下载、依赖、环境变量、登录状态检测）
- 安装完成后统一管理：版本、登录状态、更新

### 1.2 角色定制
- 创建自定义角色：**agent（CLI）× 模型 × Skills × System Prompt × Instructions** 自由搭配
- 管理 **Skills 库**、**Pi Extensions** 等资产（不只展示路径，按名称/描述管理）
- 配置按各 CLI 官方文档深度定制（现有 schema 机制延续）

### 1.3 项目与任务
- 每个项目绑定**独立本地工作目录**；项目内有自己的任务列表
- 任务指派不同角色执行；看板/审批/定时/历史全保留

### 1.4 任务级独立工作空间 + 终端式观察
- 每个任务通过 **git worktree** 获得独立工作空间（不污染主目录、互不冲突）
- 查看 agent 工作过程**像在终端里启动它一样**：完整输出、ANSI 样式、随时回看/全屏、
  会话可续（resume）——等价于"tmux attach 到一个过去的实例"
- 审批时看 git diff；通过后**一键合并/丢弃**任务分支

---

## 2. 现状盘点（已有能力）

| 能力 | 状态 | 说明 |
|---|---|---|
| CLI 适配器层 | ✅ | omp/opencode/pi/claude/codex，schema 按官方文档声明 |
| 模型候选（实例探测） | ✅ | opencode models 命令、pi/omp models-store、codex cache、claude settings |
| 技能库（定向添加） | ✅ | SKILL.md frontmatter 解析、复制到工作目录、按名称勾选 |
| 角色卡片/表格双视图 | ✅ | CLI 色头像、任务统计、配置 tab |
| 项目 + 工作目录 | ✅ | 项目弹窗/卡片/详情、目录选择器 |
| 任务看板/列表/详情 | ✅ | 三列看板、SSE 实时日志、审批 diff、子任务 |
| 定时任务 / 历史 / 设置 | ✅ | cron、清理、retention |
| 文件系统浏览 | ✅ | /api/fs/dirs + mkdir |

### 关键差距
1. **没有 Agent 安装/登录管理**——只适配"已装好的 CLI"
2. **没有 git worktree 任务空间**——任务直接在项目目录执行（多任务同目录会冲突）
3. **日志是纯文本流**——无 ANSI 终端渲染、无会话续跑（resume）、无"attach"体验
4. **角色缺 instructions 字段、缺 Extensions 管理**（pi extensions 有官方命令 `pi list/install/remove`，未接入）
5. **无引导式 onboarding**——新用户不知道"先装什么、再点什么"

---

## 3. 设计原则

1. **Web 全功能**：任何操作（装 agent、登录、合并分支、清 worktree）都能在页面完成，不落 CLI
2. **探测优先**：能探测的绝不手填（模型、CLI 状态、git 仓库、skill 内容）
3. **向导式流程**：按工作流编排引导：装 Agent → 建角色 → 建项目 → 派任务 → 观察 → 收尾
4. **一次配置、处处复用**：技能/扩展/模板/角色可复用
5. **可追溯**：任务执行记录（worktree 分支、commit、diff）完整可查
6. **离线单二进制**：前端库（xterm.js 等）vendor 进 embed，不依赖 CDN

---

## 4. 信息架构（按功能逻辑划分）

**原则：高频工作在前台，低频管理收纳为次级入口。**

默认首页 = **Dashboard 工作台**，一屏内按功能逻辑分区完成高频操作
（看任务/派活/审批/观察执行/看项目进度）；安装 Agent、创建角色、管理
Skills 等低频管理任务收纳到侧边栏次级分组。

```
Dashboard（默认首页 /）—— 按功能逻辑四分区：
  ① 统计条   今日完成 / 进行中 / 待审批 / 成功率 / 平均耗时 / 项目数
  ② 任务执行区  进行中列 + 待审批列（实时，卡片带快捷审批/驳回）+ 新建任务
  ③ 项目区    活跃项目进度卡片 + 新建项目（链接完整看板 /board）
  ④ Agent 区  各 CLI 安装/登录状态徽标 + 角色健康（启用/运行中/待审批）
               + 技能库计数 + 低频管理快捷入口（Agents / Roles / Skills）

侧边栏（按使用频率分组）：
  工作区   Dashboard（工作台） / Board（完整看板+列表） / History
  管理     Agents（安装/登录/更新） / Roles（角色定制） / Skills（资产库） / Schedules
  系统     Settings
```

### 工作流逻辑顺序（onboarding）
```
1. Dashboard Agent 区 → 发现未装 CLI → 安装向导（官方脚本流式执行）→ 登录引导
2. 安装完成 → 一键生成「默认角色」（按 CLI 官方推荐配置）
3. Roles 页 → 自定义角色：选 agent/模型/skills/system prompt/instructions
4. Projects 页 → 新建项目：选本地目录（自动识别 git 仓库）
5. Dashboard / Board → 派任务：选项目+角色+权限 → 自动创建 git worktree 独立空间
6. Dashboard 待审批列 / 任务详情 → 实时终端观察（ANSI 渲染）→ 审批（看 diff）→ 合并/丢弃分支
```

### 各页面功能分区设计

**Dashboard（默认首页，主工作台）**
- ① 统计条：今日完成 / 进行中 / 待审批 / 成功率 / 平均耗时 / 项目数
- ② 任务执行区（左主区）：进行中 + 待审批两列实时卡片；待审批卡片带「通过/驳回」快捷操作；顶部新建任务 + 查看完整看板
- ③ 项目区（右栏）：活跃项目卡片（进度条、任务数、进行中），新建项目入口
- ④ Agent 区（底栏）：CLI 安装/登录状态徽标（未装可点击跳安装）、角色健康计数、技能库计数、低频管理入口

**Board（完整看板，保留）**：三列看板 + 列表视图 + 筛选 + 任务详情两栏

---

## 5. 核心能力设计

### 5.1 Agent 安装与管理（新模块 `internal/provision`）

**能力**：检测 / 安装 / 登录状态 / 更新

| 功能 | 实现 |
|---|---|
| 检测 | 已有 `Detect()`；扩展：版本号（`--version`）、登录态（配置文件存在性探测） |
| 安装 | 官方方案流式执行：`npm i -g` / `curl | sh` 等，输出经 SSE 推送到页面内嵌终端；安装前展示命令与文档链接 |
| 登录检测 | 各 CLI 凭据文件：claude `~/.claude.json`+credentials、codex `~/.codex/auth.json`、opencode `~/.local/share/opencode/auth.json`、pi/omp `~/.pi/agent/auth.json` |
| 登录引导 | 展示官方登录方式（授权 URL / 终端命令），页面内提供"复制命令"与"检测登录"按钮 |
| 更新 | 官方更新命令流式执行 |
| 安装后动作 | 自动创建「默认角色」（CLI 名 + 官方推荐 model/权限），可一键跳过 |

**API**：`GET /api/provision`（状态总览）、`POST /api/provision/install`、`POST /api/provision/login-check`、`POST /api/provision/update`、`GET /api/provision/install-script`（预览）

> 安装命令实施时从各 CLI 官方文档核实（claude：`curl -fsSL https://claude.ai/install.sh | bash` 或 npm；codex：npm `@openai/codex`；opencode：npm `opencode-ai`；pi：npm；omp：官方脚本）。

### 5.2 角色定制增强

- **instructions 字段（新增）**：统一字段，按 CLI 映射到官方参数（claude `--append-system-prompt`、pi/omp `--append-system-prompt`、codex `-c system_prompt`、opencode 走 agent 定义），与 system_prompt 语义区分（instructions=任务指令模板，system_prompt=角色身份）
- **Skills & Extensions tab**：技能库勾选（已有）+ 角色级 pi extension 清单（`pi list` 按角色全局管理，展示+安装/移除链接）
- 模型候选：保持实例探测

### 5.3 Skills / Extensions 资产库

- Skills：已有（定向添加/复制/按名称勾选）；增强：**引用计数**（扫 agents role_config.skills）
- Extensions（pi）：包装 `pi list / install / remove`，Web 操作；来源：`pi install <source>`

### 5.4 项目与任务（保持 + 强化）

- 项目：已有目录绑定；增强：git 识别（`git rev-parse`），卡片显示分支/仓库徽标
- 任务：创建时**自动进入 worktree 工作空间**（见 5.5）

### 5.5 git worktree 隔离工作空间（新模块 `internal/workspace`）

**流程**：
```
创建任务(queued) → 执行前 ensure worktree:
  project_dir 是 git 仓库？
    ├─ 是 → git worktree add <sessions>/<project>/<task-id> -b paihuo/task-<id>
    │       记录 branch + commit（执行前快照）
    │       执行 agent 于 worktree 目录
    │       终态后：保留（可查看）→ 审批通过：
    │         合并：git merge --squash paihuo/task-<id>（用户确认）或 丢弃：git worktree remove
    └─ 否 → 直接在 project_dir 执行（标注"未隔离"），提示 git init 或改用 git 目录
```
- **sessions 根目录**：`<db 目录>/sessions/<project>/`（可设置）
- **清理策略**：终态任务 worktree 保留 N 天（Settings 可配，默认 7），定时清理；任务详情可手动清理
- **子任务**：继承父任务 worktree？改为每个子任务独立 worktree（同一 git 仓库并行分支）——避免目录冲突（现有"同角色串行"约束可放宽到 worktree 隔离）
- **diff 展示**：审批时 diff = worktree 相对执行前 commit（现有 diff 逻辑改为基于 worktree）

**API**：`GET /api/workspace/{task}`、`POST /api/workspace/{task}/merge`、`POST /api/workspace/{task}/discard`、`POST /api/workspace/cleanup`

### 5.6 终端式任务观察（xterm.js + SSE）

- **vendor xterm.js**（`npm pack xterm @xterm/addon-fit` → `internal/web/static/vendor/`，随 embed 分发，离线可用）
- 任务详情主区用 xterm 渲染日志流：ANSI 颜色、行内样式、滚动；SSE 实时追加
- **会话续跑（resume）**：任务详情"继续对话"→ 新建子任务，适配器层带会话参数（pi/omp `--session-dir` 已支持；claude `--resume`、codex/opencode `--continue`/`--resume` 按文档映射）——真正实现"attach 回过去的实例"
- 保留：全屏终端弹窗、复制、时间戳行（可选开关）

### 5.7 智能自动化清单

| 场景 | 自动化 |
|---|---|
| 首次使用 | Dashboard 引导：缺 CLI → 跳安装；无角色 → 一键默认角色；无项目 → 跳新建 |
| 安装完成 | 自动检测登录态、自动建默认角色 |
| 新建项目 | 自动识别 git 仓库/分支，检测目录可写 |
| 派任务 | 自动建 worktree；无角色 → 提示先建 |
| 任务完成 | 审批通过 → 提示合并；失败 → 一键重试（干净 worktree） |
| 定时清理 | worktree / 会话 / 历史按策略自动清理 |

---

## 6. 数据模型与 API

### 表变更
- `tasks`：`+ worktree_branch TEXT DEFAULT ''`、`+ base_commit TEXT DEFAULT ''`（执行前快照）
- `settings`：`+ worktree_retention_days`（默认 7）、`+ sessions_dir`（默认 `<db>/sessions`）
- `agents`：不变（安装状态实时探测，不落库）
- `skills`：不变（引用计数实时算）

### 新增 API
```
GET    /api/provision                    # 各 CLI 安装/登录/版本总览
POST   /api/provision/install            # {cli} → 流式安装（SSE）
POST   /api/provision/update             # {cli}
POST   /api/provision/login-check        # {cli}
GET    /api/provision/install-script     # {cli} → 官方命令预览

GET    /api/extensions                   # pi list 结果（若 pi 已装）
POST   /api/extensions/install           # {source}
DELETE /api/extensions/{name}            # pi remove

GET    /api/workspace/{taskId}           # worktree 状态（分支/commit/可合并）
POST   /api/workspace/{taskId}/merge     # merge --squash
POST   /api/workspace/{taskId}/discard   # worktree remove --force
POST   /api/workspace/cleanup            # 按策略清理

POST   /api/tasks/{id}/resume            # 在原任务上续跑（保留会话与 worktree）
```

### 执行器改动
- `RunOptions.Dir`：queued→running 时由 executor 解析为 worktree 路径（`workspace.Ensure(task)`）
- 非 git 项目：回退原目录 + 任务标注 `workspace: none`
- 会话参数：新增 Resume 支持（各适配器按官方文档映射）

---

## 7. 分阶段实施计划

### Phase 0 — 规划定稿（本文档）
- 产出：PLAN.md；与用户确认信息架构与优先级

### Phase 1 — Dashboard 主工作台 + Agent 安装与管理（`internal/provision`）
- [ ] **Dashboard 成为默认首页**：统计条 + 任务执行区（进行中/待审批 + 快捷审批/驳回/新建）+ 项目区 + Agent 区（CLI 安装/登录徽标、角色健康、技能库计数、管理入口）
- [ ] 原看板迁移到 /board（三列看板 + 列表 + 详情，功能不变）
- [ ] 探测扩展：版本号（--version）、登录态（各 CLI 凭据文件），GET /api/provision
- [ ] 安装向导：官方命令收集与预览、流式执行（复用 executor 的进程+SSE 模式）
- [ ] 登录引导：授权方式展示、复制命令、检测按钮
- [ ] Agents 页重构：已安装 / 安装向导 / 登录 三 tab
- [ ] 安装完成 → 一键创建默认角色
- 验收：Dashboard 一屏完成日常任务流；Web 上完成 claude/codex/pi 安装全流程（登录手动）

### Phase 2 — git worktree 任务空间（`internal/workspace`）
- [ ] workspace 包：Ensure/Create/Snapshot/Merge/Discard/Cleanup
- [ ] executor 接入：任务执行于 worktree；非 git 回退+标注
- [ ] 任务详情侧栏：分支/commit/合并/丢弃/清理
- [ ] diff 展示基于 worktree base commit
- [ ] 子任务独立 worktree（放宽同角色串行约束）
- [ ] Settings：保留天数、sessions 目录
- 验收：同一项目并行派 2 个任务互不污染；审批通过可合并、可丢弃

### Phase 3 — 终端式观察（xterm.js）
- [ ] vendor xterm + fit addon 到 static
- [ ] 任务详情/全屏弹窗改用 xterm 渲染（ANSI、滚动、样式）
- [ ] SSE 追加接 xterm 写入；时间戳开关
- [ ] 会话续跑 resume：适配器按官方文档映射参数、任务详情按钮
- 验收：任务输出带颜色/格式；可"继续对话"续跑

### Phase 4 — 角色增强（instructions + Extensions）
- [ ] instructions 字段：schema 增加，各适配器映射到官方参数
- [ ] Roles 详情新增 Skills & Extensions tab：技能勾选 + pi extensions 管理
- [ ] 引用计数（技能/扩展被哪些角色使用）
- 验收：角色可配置 instructions；角色内可安装/移除 pi extension

### Phase 5 — Dashboard 与工作流引导
- [ ] Dashboard：安装状态 + 活跃任务 + 待审批 + 今日完成 + 最近动态
- [ ] 首次使用引导（空态 → 下一步按钮链）
- [ ] 项目 git 识别与分支徽标
- 验收：新用户按引导 10 分钟内跑通首任务

### Phase 6 — 打磨与策略
- [ ] 任务模板一键复用（现有「保存为模板」→ 看板快捷入口）
- [ ] worktree/会话/历史定时清理（现有 retention 框架扩展）
- [ ] 移动端适配复查、a11y 复查
- [ ] README 更新为 v2 工作流

---

## 8. 风险与决策点

| 项 | 决策 | 备注 |
|---|---|---|
| 安装命令来源 | 实施时从官网核实后硬编码+文档链接 | 命令变更风险：探测失败提示手动 |
| 登录自动化程度 | 授权链接/复制命令 + 状态检测；不做账号密码自动化 | 用户已接受手动登录 |
| 非 git 项目 | 提示 git init；提供「初始化 git」按钮（web 可点） | Phase 2 含此按钮 |
| worktree 合并策略 | squash 合并（保留单 commit），冲突时提示手动处理 | 冲突场景：停止合并并展示冲突文件 |
| xterm.js 体积 | 仅 vendor 核心 + fit（~400KB 压缩前），可接受 | 单二进制内嵌 |
| resume 支持度 | 各 CLI 参数按官方文档尽力映射，不支持则提示 | pi/omp session-dir 已具备 |
