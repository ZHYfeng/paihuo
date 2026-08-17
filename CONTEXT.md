# PaiHuo Domain Language

本表定义后端、前端和 Runtime 共同使用的产品术语；实现规则见代码和 `docs/TECHNOLOGY_EVOLUTION.md`。

系统只有一条主线：**项目 → 创建任务 → 执行 → 审批**。Task 是唯一实体，
四种形态（单任务/复合任务/自由探索任务/定时任务）只是创建方式的差异；
审批是主线上的一道闸口，不是另一种任务。端到端流程见
`docs/design/workflow.md`。

### Project

一个受 PaiHuo 管理的工作目标边界，绑定明确的工作目录和任务历史。

避免：Repository、folder。

### Task

一次有目标、Role、Project、权限、输入快照和终态的可审计工作分配。
系统唯一的实体，物理上只有一张 `tasks` 表，`type` 列区分四种形态：

- `task`（单任务）：一次 batch 执行（日常主力）；
- `workflow`（复合任务）：带编排 spec（节点 + 依赖边），创建/编辑经确定性策略校验，启动 Run 时绑定项目并原子实例化为子任务树，状态聚合；
- `session`（自由探索任务）：持久多轮协作，可挂起/恢复，交付后形成可结算的收编任务；
- 定时是正交属性：任何形态都可挂 `cron`，到点按形态创建实例（定时页跨形态汇总）。

避免：Prompt、tmux window、Workflow（Workflow 是复合任务，不是另一类实体）。

### Role

可复用的责任与执行约束，包括指令、允许能力和并发策略；不等于某个 CLI 或模型。

避免：Agent CLI、model preset。

### Runtime

实现 Role 所需能力的执行提供者，例如 Pi、Codex、Claude Code、OpenCode 或 OMP。

避免：Role、Agent identity。

### Session

围绕一个 Project 和 Role 的持久多轮协作，物理上是 `type=session` 的任务记录；
只有交付后才形成可结算的收编 Task。

避免：Task、terminal。

### Workspace

一个 Task 或 Session 独占的项目工作副本，用于隔离修改和形成可审查差异。

避免：Project、main working tree。

### Delivery

Session 产生的、准备进入任务审批与整合流程的版本化工作成果。

避免：Chat answer、automatic merge。

### Approval

主线上的一道闸口：对 Task 成果是否可以进入后续整合步骤的显式裁决；
它不等于 Agent 成功退出。所有待审批点聚合在同一“待审批”面。

避免：Success、merge、独立的任务类型。

### Workflow

一个可复用、可编辑的编排定义：Task 节点、依赖、限制；创建与每次编辑都经过
确定性策略校验（adopted）。
spec 不绑定 Project——在启动 Run 时选择具体项目，同一定义可复用于多个项目。
物理上是 `type=workflow` 任务处于 adopted 状态（spec + spec_hash，revision
保护并发编辑；删除只移除定义与 Run 书签，节点任务保留为任务历史）。

避免：Proposal、Prompt chain、live task list。

### Workflow Run

由一个 Workflow 定义原子实例化的执行实例，启动时绑定具体 Project，
包含节点到 Task 的稳定映射。`workflow_runs` 表保留为实例书签（非实体），
任务本身仍是 `type=task`。

避免：Workflow、临时任务集合。

### Artifact

Task 或 Workflow Run 产生的不可变内容对象，通过内容哈希寻址，数据库只保存元数据。

避免：任意宿主机路径、内联大对象。

### Runtime capability

Runtime 可审计声明的能力，例如 batch、interactive、session、skills；策略按能力选择而不是按 CLI 名称分支。

避免：厂商名称判断、隐式功能探测。
