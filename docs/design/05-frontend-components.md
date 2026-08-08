# S-2 前端组件规格（会话 UI）

> 状态：已细化 · 更新：2026-08-08
> 渲染规格：`04-session-message-stream.md`。本文定义会话 UI 的页面布局与逐组件规格。**UI 高度参考 pi-web**。

## 1. 页面与路由

| 路由 | 页面 | 说明 |
|---|---|---|
| `#/sessions` | 会话中心 | 全局会话列表 + 详情（两栏） |
| `#/sessions/<id>` | 会话详情 | 深链直达某个会话 |
| 项目页内嵌 | 项目会话列表 | 项目详情页新增"会话"区块（与任务列表共存） |

```
┌───────────────┬───────────────────────────────────────────────┐
│ 侧栏           │ 主区                                           │
│ [会话][任务]tab │ 会话详情                                       │
│ ┌───────────┐ │ ┌───────────────────────────────────────────┐ │
│ │+ 新建会话   │ │ 头部: ◉ 活跃  修复登录失败                    │ │
│ │◉ 修复登录   │ │      [pi] [角色名] [模型] [项目A] [···]      │ │
│ │  pi·2m前    │ │      [挂起] [交付]                           │ │
│ │○ 性能调研   │ ├───────────────────────────────────────────┤ │
│ │  pi·1h前    │ │ 消息流                                       │ │
│ │✓ 重构数据层 │ │  [user]     帮我看下登录为什么失败            │ │
│ │  pi·昨天    │ │  [assistant] 我检查了 auth.go…（markdown）    │ │
│ │             │ │  [tool]     ▸ 读文件 auth.go（卡片,可折叠）    │ │
│ │ 状态筛选:    │ │  [tool]     ▸ bash: go test ./... ✓         │ │
│ │ 全部/活跃/   │ │  [assistant] 找到了：token 过期判断写反了     │ │
│ │ 挂起/已交付  │ ├───────────────────────────────────────────┤ │
│ └───────────┘ │ │ 输入: [多行输入…] [运行中:插入模式▾] [发送][中止]│ │
└───────────────┴───────────────────────────────────────────────┘
```

## 2. 组件树（lit）

```
<ph-sessions-page>
├─ <ph-session-list>        列表（状态点◉○✓、角色/项目/时间、筛选）
│   └─ <ph-session-create>  新建弹窗（项目+角色+标题；git 项目提示 worktree）
├─ <ph-session-view>
│   ├─ <ph-session-header>  状态/角色/模型/thinking + 操作按钮
│   ├─ <ph-message-stream>  虚拟滚动消息流（组件见 04 文档映射表）
│   ├─ <ph-session-input>   多行输入 + 运行中队列提示 + [发送][中止]
│   └─ <ph-session-side>    属性（worktree 分支/目录/时长/消息数）
└─ 降级视图（cli=codex/claude）: 消息流区 = <ph-term-panel>（复用 xterm）
```

## 3. 逐组件规格

### 3.1 `<ph-sessions-page>`
- 状态：`selectedId`、`filter`、`sessions[]`
- 数据：`GET /api/sessions`（含项目/角色联查）；SSE `session.updated` 实时刷新列表
- 布局：CSS grid 两栏（列表 280px + 主区自适应）；窄屏堆叠（列表→顶栏返回）
- 空态：无会话 → 引导新建卡片

### 3.2 `<ph-session-list>`
- props：`sessions`、`selectedId`、`filter`
- 列表项：
  - 状态点：◉ 活跃（绿，呼吸动画）/ ○ 挂起（灰）/ ✓ 已交付（蓝）/ 未启动（白圈）
  - 标题（截断 1 行）+ 次行：`[pi|codex|claude 徽标] 角色名 · 项目名 · 相对时间`
  - 交付项：附"→ 任务 #N"链接
- 筛选条：全部 / 活跃 / 挂起 / 已交付 + 项目下拉
- 排序：`last_message_at` 倒序（无消息按 created_at）
- 新建按钮：固定底部或顶部
- 键盘：↑↓ 移动选择，Enter 打开（Could）

### 3.3 `<ph-session-create>`（弹窗）
- 字段：
  - 项目（必选下拉）→ 选中后显示：git 项目 "将创建独立 worktree `paihuo/session-N`" / 非 git "直接在项目目录执行"
  - 角色（必选下拉，仅启用中的角色）
  - 标题（必填）
  - 说明（可选，作为会话首条 user 消息的补充？→ 不，仅标题；首条消息由用户对话时发）
- 提交：`POST /api/sessions` → 跳转 `#/sessions/<id>` 并自动 `start`

### 3.4 `<ph-session-header>`
- 数据：session 记录 + `get_state` 快照（模型/thinking/会话名）+ 运行状态（agent_start/agent_settled）
- 内容：
  - 状态徽标（created/active/suspended/delivered + 细分"思考中"）
  - 标题（可编辑？→ Could，用 `/name` 命令）
  - 元信息行：`[CLI 徽标] 角色名 · 模型 · thinking · 项目（链接）`
- 操作按钮（按状态）：
  | 状态 | 按钮 |
  |---|---|
  | created | [启动] [丢弃] |
  | active 空闲 | [挂起] [交付] |
  | active 思考中 | [中止] [挂起] [交付] |
  | suspended | [恢复] [交付] [丢弃] |
  | delivered | [查看任务 →]（只读徽标） |
- 思考中状态：`agent_start` → "⚡ 思考中"；`agent_settled` → 空闲

### 3.5 `<ph-message-stream>`
- props：`items: RenderItem[]`（见 04 文档渲染模型）
- 虚拟滚动：消息 > 100 条启用按需渲染（保留上下滚动锚点）
- 自动滚动：新消息滚到底；用户上滚 > 100px 暂停，底部浮出"↓ 回到最新"
- 渲染：消息组件序列 + 事件条目（时间线小字）
- 加载态：首次拉 transcript 显示骨架屏

### 3.6 消息组件交互细节（承接 04 文档映射）
| 组件 | 交互细节 |
|---|---|
| `<ph-msg-user>` | markdown（代码块/行内 code）；图片缩略图点击放大；可复制文本 |
| `<ph-msg-assistant>` | markdown+代码高亮；标题行附注 `model · tokens`（小字，可展开 usage）；thinking 折叠块（"💭 思考 N 字"，点击展开） |
| `<ph-msg-tool-card>` | 标题行可点展开/折叠；复制按钮；错误红框；bash 显示退出码 ✓/✗ |
| `<ph-msg-bash>` | `$ command` mono；输出 pre 块（max-height 截断 + 展开）；exitCode 徽标；truncated 提示 |
| `<ph-msg-custom>` | customType 标题 + 内容（未知类型通用渲染） |
| `<ph-event-*>` | 居中分隔线小字 + 图标（🧹 压缩 / 🔄 模型切换 / 💭 thinking） |

### 3.7 `<ph-session-input>`
- 多行 textarea：Enter 发送 / Shift+Enter 换行；自适应高度（≤6 行）
- 状态机：
  | 会话/agent 状态 | 输入行为 |
  |---|---|
  | active + 空闲 | 发送 = `prompt` |
  | active + 思考中 | 显示提示条"运行中，消息将排队" + 模式切换 [steer 插入（默认）/ follow_up 等停止] |
  | suspended | 禁用 + 提示"恢复会话后可继续对话" |
  | delivered | 禁用 + "已交付，只读" |
  | created | 禁用 + "点击启动" |
- 中止按钮：仅思考中显示（发 `abort`）
- 队列提示：`queue_update` 事件 → 输入区上方"⏳ N 条排队中"
- 命令支持：`/` 开头提示 `get_commands` 列表（Could：自动补全）
- 图片粘贴：Ctrl+V 图片 → 附加（`prompt` images 参数）（Could）
- 发送后：清空输入，乐观插入 user 消息占位（失败回滚提示）

### 3.8 `<ph-session-side>`（属性栏，可折叠）
- worktree 分支（mono，可复制）/ 路径
- 会话目录（pi transcript 位置）
- 创建/启动/挂起/交付时间
- 消息数 / tokens 合计（从 usage 累加，Could）

## 4. 前端状态管理（store 扩展）

```js
state.sessions = []            // 列表
state.sessionFilter = "all"
state.sessionDetail = null     // 当前打开会话详情（含 transcript items）
state.sessionLive = null       // 会话实时状态（agentRunning/model/thinking/queue）
```

- SSE 事件 → store 更新 → lit 响应式渲染
- 打开会话：拉 transcript → 订阅 session.message 增量 → 关闭：取消订阅（**不**自动挂起）

## 5. 移动端适配

- 两栏 → 堆叠：列表页与详情页切换（返回按钮）
- 输入区固定底部（safe-area）；消息流 padding 适配
- 工具卡片在窄屏默认折叠

## 6. 复用清单（现有代码）

| 复用 | 来源 |
|---|---|
| 交互终端 xterm + 输入队列 | `terminal.js`（降级视图） |
| SSE 连接管理（隐藏断开/可见重连） | `core.js` |
| 全局 state + toast + modal | `core.js` |
| CLI 徽标样式 av-* | `app.css` 现有 |
| markdown 渲染 | 新增（轻量实现或引入 marked，参考 pi-web 用 marked） |
| 代码高亮 | 新增（vendor 拆分，参考 pi-web CodeViewer 思路） |
