# 采用编号化 SQLite 迁移

> 状态：Accepted
> 生效：2026-08-24

## 背景

部署流程默认保留真实的 Role、Project、Task、Session、Workflow、Artifact 元数据，
Store 也已经包含 8 个按固定顺序执行的幂等增量迁移。继续把所有存量数据库都当作
“当前 schema 或清库”既不能表达这些增量的先后关系，也无法证明 schema 变更与版本标记
原子完成。

Task 形态字段的数据库约束需要重建 `tasks` 表；这是第一次会复制整表并影响全部外键的
迁移，不能再依赖列存在性猜测数据库处于哪个版本。

## 决策

使用 SQLite `PRAGMA user_version` 维护单调递增的应用 schema 版本：

- 空数据库直接创建最新 schema，并把 `user_version` 写为最新版本；
- 非空数据库先读取 `user_version`，再按版本号顺序执行所有待执行迁移；
- 当前最低支持版本为 1；现有 8 个幂等迁移依次编号为 2–9：
  1. v2：`workflow_runs.project_id`；
  2. v3：`workflow_runs.task`；
  3. v4：`skills.category`；
  4. v5：Project GitHub 配置列；
  5. v6：`tasks.external_key`；
  6. v7：Task 编排父链列；
  7. v8：Role delegation 列；
  8. v9：`tasks.merge_skipped`；
- Task 形态 `CHECK` 约束是 v10；它按 SQLite 官方 table-rebuild 流程创建新表、
  显式复制全部列、替换旧表、重建索引和触发器，并执行 `foreign_key_check`；
- 版本低于最低支持版本或高于当前 binary 最新版本时明确拒绝启动；版本号受支持但
  最终关键列缺失时报告 schema shape 损坏，不把两类错误混为一谈；
- 待执行迁移和对应的 `user_version` 更新在同一事务中；任一步失败即回滚并停止启动；
- 迁移只向前，不提供 downgrade、双写、兼容 schema 或失败后继续运行。

`user_version` 是应用拥有的版本事实；列是否存在只用于保持 v2–v9 的迁移幂等，不能替代
版本号。这样，版本仍为 1 但已经具备部分或全部增量列的现有数据库仍可安全重放并推进。

## 依据

不选择默认清库，因为 PaiHuo 的重新部署契约明确保留数据库、Session/Workspace、Artifact
和执行状态；清库会永久丢失这些可审计历史。编号迁移把已经存在的增量路径正规化，且允许
在数据库副本上逐版本演练和对账。

SQLite 不能用普通 `ALTER TABLE` 给既有表增加本次所需的表级 `CHECK`。官方建议的安全
顺序是先创建新表、复制数据、删除旧表、把新表改为正式名称，再重建相关 schema 对象；
若启用了外键，必须在事务外关闭，迁移后在提交前运行 `PRAGMA foreign_key_check`，提交后
恢复原设置。直接修改 `sqlite_schema`（`writable_schema`）不用于生产迁移。

## 后果

每个 schema 版本都有唯一升级路径，启动可以明确区分“不支持的版本”和“受支持版本的
结构损坏”。代价是 schema 变更必须增加 migration registry 条目、版本 fixture 和数据
对账测试；v10 还需要独立维护窗口、完整备份和旧 binary 不再打开新库的发布纪律。
