# PaiHuo Domain Language

本表定义后端、前端和 Runtime 共同使用的产品术语；实现规则见代码和 `docs/TECHNOLOGY_EVOLUTION.md`。

### Project

一个受 PaiHuo 管理的工作目标边界，绑定明确的工作目录和任务历史。

避免：Repository、folder。

### Task

一次有目标、Role、Project、权限、输入快照和终态的可审计工作分配。

避免：Prompt、tmux window。

### Role

可复用的责任与执行约束，包括指令、允许能力和并发策略；不等于某个 CLI 或模型。

避免：Agent CLI、model preset。

### Runtime

实现 Role 所需能力的执行提供者，例如 Pi、Codex、Claude Code、OpenCode 或 OMP。

避免：Role、Agent identity。

### Session

围绕一个 Project 和 Role 的持久多轮协作，只有交付后才形成可结算 Task。

避免：Task、terminal。

### Workspace

一个 Task 或 Session 独占的项目工作副本，用于隔离修改和形成可审查差异。

避免：Project、main working tree。

### Delivery

Session 产生的、准备进入任务审批与整合流程的版本化工作成果。

避免：Chat answer、automatic merge。

### Approval

对 Task 成果是否可以进入后续整合步骤的显式裁决；它不等于 Agent 成功退出。

避免：Success、merge。

### Workflow Plan

一组冻结版本的 Task 节点、依赖、限制和采用策略，可来自固定模板或经校验的 Agent 提议。

避免：Prompt chain、live task list。

### Workflow Proposal

尚未可执行的候选 Workflow Plan，必须先通过确定性策略校验。

避免：Workflow Plan、agent command。

### Workflow Run

由一个冻结 Workflow Plan 原子实例化的执行实例，包含节点到 Task 的稳定映射。

避免：Workflow Plan、临时任务集合。

### Artifact

Task 或 Workflow Run 产生的不可变内容对象，通过内容哈希寻址，数据库只保存元数据。

避免：任意宿主机路径、内联大对象。

### Runtime capability

Runtime 可审计声明的能力，例如 batch、interactive、session、skills；策略按能力选择而不是按 CLI 名称分支。

避免：厂商名称判断、隐式功能探测。
