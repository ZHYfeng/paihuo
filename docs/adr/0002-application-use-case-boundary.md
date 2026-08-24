# Application 层承载 Task 用例编排

> 状态：Accepted  
> 生效：2026-08-24

## 背景

`TaskLifecycle` 已被 HTTP、GitHub 同步和 orchestrator 共同用于创建 Task；
`WorkflowService` 也同时服务 HTTP 与 scheduler。这说明 application 层不是 HTTP 的
薄包装，而是多个入口复用同一用例规则的稳定边界。

但接受本决策前，Task 的人工生命周期仍有一半留在 HTTP handler：审批、驳回重排、
取消、续跑和删除直接串联 Store、Executor、Workspace、Session 与 EventStream。
结果是状态规则、副作用顺序和 revision 检查只能通过阅读多个 transport 文件理解，
其他入口也无法安全复用。

## 决策

保留并补齐 `internal/application`。各层职责如下：

- **HTTP transport**：解码请求、认证、解析 `If-Match` revision、校验协议字段，调用
  application，并把 typed application error 集中映射为既有 HTTP 状态和错误文案。
- **Application**：承载 Task 用例和状态机入口，编排跨 Store、Executor、Workspace、
  Session、EventStream 的副作用；在任何副作用前核对 expected revision 与当前状态。
- **Store**：提供持久化和事务边界，包括 revision 条件更新、原子创建合并 Task、
  依赖保护与 Task 树删除。
- **领域模块**：表达不变量和纯规则；例如 Task 状态转换、Workflow Policy 和
  Workspace 的 Git 规则，不依赖 `net/http`。

`TaskLifecycle` 收口创建、审批、驳回/重新排队、取消、续跑和删除。它使用一个显式
依赖结构组织真实依赖；只调用 `Create` 的 orchestrator 可以只提供创建所需依赖，
不需要伪造 Session、EventStream 或 HTTP 对象。普通 Task 字段 PATCH、纯读取以及
简单 Role/Project/Skill CRUD 可以继续直接使用 Store，不为层次一致性增加薄服务。

Application 返回可由 `errors.As` 判断的 typed error，不依赖 HTTP 状态码，也不允许
transport 通过字符串匹配推断错误类型。

## 关键顺序约束

TaskLifecycle 的实现必须保持现有产品语义：

1. 审批前先校验 revision/状态，再 Snapshot；有改动时原子完成源 Task 并创建合并
   Task，无改动时标记 `merge_skipped`、清理资源并保留审批日志/事件。
2. 驳回先重置 Runtime Session，再以同一 revision 更新修改意见和排队状态；重试清空
   执行痕迹并唤醒 Executor。
3. 取消先终止运行，再持久化终态；续跑保留 Task 身份、会话目录和 Workspace。
4. 删除先检查 revision、合并义务和外部强依赖，再停止 Task 树、按叶到根清理资源，
   删除记录后清理由交付 Task 关联的 Session。
5. 所有状态更新和原子合并操作继续由 Store 的条件 SQL/事务兜底，application 不在
   内存中模拟事务。

## 依据

- orchestrator 与 HTTP 已复用 `TaskLifecycle.Create`，证明 Task 用例存在跨 transport
  调用方。
- scheduler 与 HTTP 已复用 `WorkflowService`，证明 Workflow 策略和实例化不应回流
  handler。
- 审批和删除跨越多个基础设施模块，放在 transport 会让 revision 检查与副作用之间
  产生不可见的竞态窗口。

## 非目标

- 不把简单 Role、Project、Skill CRUD 全部搬入 application。
- 不引入 repository interface、ORM 或 Web 框架。
- 不改变 HTTP method/path/status/error/JSON、Task 状态机或数据库 schema。
- 不把 Runtime 命令、Git 实现或 SQL 细节复制进 application。

## 后果

Task 的人工生命周期有一个可测试的编排入口，HTTP handler 变为协议适配器，其他入口
可以复用相同 revision 与状态规则。代价是 `TaskLifecycle` 需要显式管理多个真实依赖，
并为失败分类维护稳定的 application error 类型；这是跨模块用例本身的复杂度，不通过
薄 wrapper 或字符串错误映射隐藏。
