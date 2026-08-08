# S-3 消息流渲染规格（pi 会话 → 前端 UI）

> 状态：已确认 · 更新：2026-08-08
> 后端：`03-session-backend.md`。本文定义会话 UI 的渲染模型、组件映射与流式渲染。**UI 高度参考 pi-web**。

## 1. 数据源架构：全量 + 增量

**关键事实**：`get_messages` 只返回消息，**不含** model_change/compaction 等事件条目；而会话 JSONL 文件是**完整时间线**（含所有 entry 类型）。

```
全量:  GET /api/sessions/{id}/transcript
       → 后端解析 pi 会话 JSONL → entries[]（全部类型，按时间序）
       → 前端渲染完整时间线（含模型切换/压缩摘要）

增量:  pi RPC 事件流（已确认 20+ 种事件类型）
       → SSE session.message 透传 → 前端流式更新
```

## 2. 前端渲染模型

```ts
type RenderItem =
  | { kind: "user";         msg: UserMessage }
  | { kind: "assistant";    msg: AssistantMessage }      // 含 thinking/toolCall blocks
  | { kind: "tool-card";    call: ToolCall; result?: ToolResultMessage }  // 配对
  | { kind: "bash";         msg: BashExecutionMessage }
  | { kind: "custom";       msg: CustomMessage }
  | { kind: "ev-model";     provider, modelId }
  | { kind: "ev-thinking";  level }
  | { kind: "ev-compaction"; summary, tokensBefore }
  | { kind: "ev-branch";    summary }
```

**配对规则**：assistant 消息里的 `toolCall` block + 后续 `toolResult` 消息（按 `toolCallId` 匹配）→ 合并为一张工具卡片；bash 工具的 `bashExecution` 消息同样并入该卡片（输出以 bashExecution 为准）。

## 3. pi 消息类型 → 组件映射表

| pi 类型 | lit 组件 | 渲染规格 |
|---|---|---|
| `user`（string/blocks） | `<ph-msg-user>` | 用户消息气泡；markdown；`image` block → 缩略图（可点开） |
| `assistant` | `<ph-msg-assistant>` | 逐 block：`text`→markdown+代码高亮；`thinking`→**折叠思考块**（"💭 思考 N 字"）；`toolCall`→工具卡片 |
| `toolResult`（配对后） | 卡片内 | 折叠结果区（默认收折，max 截断 + 展开全文） |
| `bashExecution` | `<ph-msg-bash>` | `$ command` + 输出块（截断展开）+ `exitCode` ✓绿/✗红 + `truncated` 标记 |
| `custom` | `<ph-msg-custom>` | 通用卡片（customType 标题）；未知类型不崩 |
| `compaction` entry | `<ph-event-compaction>` | 时间线小字："🧹 上下文已压缩（-N tokens）" + 摘要可展开 |
| `model_change` | `<ph-event-model>` | "模型切换 → provider/modelId" |
| `thinking_level_change` | `<ph-event-thinking>` | "思考级别 → high" |
| `branch_summary` | `<ph-event-branch>` | "分支摘要"（可折叠） |
| `label`/`session_info` | 不渲染 | 列表标题用 session name |

## 4. 工具卡片规格（核心视觉）

```
┌────────────────────────────────────────────┐
│ ▸ read_file   src/auth.go                  │  ← 工具名 + 关键参数摘要
│   结果: 42 行 · 复制                        │
├────────────────────────────────────────────┤
│ (折叠时只有标题行；展开显示内容/输出)         │
└────────────────────────────────────────────┘
```

| 状态 | 表现 |
|---|---|
| 执行中（tool_execution_start） | 标题行 + 旋转指示器，输出流式追加 |
| 完成（tool_execution_end） | 收起为标题行，✓ 标记 |
| 出错（isError） | 红色边框 + ✗ |
| bash | 命令 + 输出 + 退出码（同 `<ph-msg-bash>`） |

关键参数摘要规则（技术设计时定表）：`read_file`→path、`edit`/`write_file`→path、`bash`→command、`grep`→pattern+path…

## 5. 流式渲染：RPC 事件 → 视图更新

| RPC 事件 | 前端行为 |
|---|---|
| `turn_start` | 新回合开始标记 |
| `message_start` | 插入占位消息（assistant 骨架） |
| `message_update` | 增量更新文本/思考/工具调用（**打字机流式**） |
| `message_end` | 定型（usage/model 附注） |
| `tool_execution_start/update/end` | 工具卡片：运行中 → 流式输出 → 完成 |
| `bash_execution_update` | bash 卡片输出追加（含原命令 id 关联） |
| `agent_start` / `agent_settled` | 头部状态：⚡思考中 ↔ 空闲（按钮区切换） |
| `queue_update` | 输入区显示排队消息数（"2 条排队中"） |
| `compaction_start/end` | 头部提示 + 完成后插入压缩条目 |

**顺序保证**：SSE 单通道保序；断线重连 → 重新拉 transcript 全量 + 丢弃旧增量（现有兜底模式）。

## 6. 特殊场景

- **流式中断**（abort/错误）：占位消息标记"已中止"，保留已输出内容
- **超长消息**：assistant 文本 > 200 行折叠"展开全文"
- **图片**：user 粘贴图片 → 缩略图；assistant 生成图片（如 SVG 预览）→ 渲染（Could）
- **compaction 期间**：输入禁用提示"正在压缩上下文…"

## 7. 与 pi-web 对齐与差异

| | pi-web | paihuo 会话 |
|---|---|---|
| 消息流结构 | 同 | **对齐**（同源数据、同类组件） |
| 工具卡片 | 同 | **对齐** |
| 流式渲染 | 同 | **对齐** |
| 事件时间线 | 同 | **对齐** |
| 会话↔任务回链 | 无 | **paihuo 独有**：交付后消息流顶部显示"✓ 已交付 → 任务 #N" |
| 审批联动 | 无 | **paihuo 独有**：交付后可从任务详情回到会话时间线 |
