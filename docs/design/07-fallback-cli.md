# codex / claude 会话降级视图

> 状态：已细化 · 更新：2026-08-08
> 定位：会话 UI 的首选形态是 pi（消息流，见 04/05 文档）；codex/claude 没有可用的结构化消息数据源，采用**终端式**降级视图。用户已确认此降级可接受。

## 1. 为什么降级

| CLI | 结构化消息可得性 | 结论 |
|---|---|---|
| pi | ✅ RPC 模式（JSONL 事件流 + get_messages） | 消息流 UI |
| codex | ❌ 无官方嵌入 SDK（npm 包只是 CLI 分发包装） | 终端式 |
| claude | 🟡 有官方 SDK（@anthropic-ai/claude-agent-sdk），但需 Node 进程、事件模型与 pi 不同 | 本期终端式；SDK 通道列入远期评估 |

## 2. 会话形态：复用现有 tmux 交互任务机制

codex/claude 会话**不是**新的执行通道——它复用现有交互任务的完整能力：

```text
现有交互任务:  tmux -L paihuo window task-<id> + 真实 TTY + 浏览器 xterm
降级会话:      tmux window session-<id>（同机制，不同命名空间）
```

| 能力 | 复用点 |
|---|---|
| 进程/窗口 | `tmuxRunner`（`internal/exec/tmux.go`） |
| 输入通道 | 现有交互输入串行队列（`sendTaskInput`） |
| 实时画面 | xterm + fit + resize 同步（`terminal.js`） |
| 归档重放 | 录制尺寸重放（terminal_cols/rows 机制） |
| 会话目录 | `.agent-sessions/<namespace>/`（CLI 各自 --session-dir / --continue 恢复） |

## 3. 状态机差异（与 pi 会话）

| 迁移 | pi 会话 | codex/claude 会话 |
|---|---|---|
| start | spawn `pi --mode rpc` | tmux 窗口 + CLI 交互模式（初始消息位置参数） |
| suspend | 杀 RPC 进程 | 发退出命令 / kill 窗口（不结算） |
| resume | spawn + `switch_session` | 重建窗口 + CLI 会话恢复（codex `--continue` / claude `--continue` / 会话目录） |
| deliver | 同上（worktree 复用） | 同上（worktree 复用） |

## 4. 前端视图（`<ph-term-panel>`）

```
┌──────────────────────────────────────────┐
│ 头部: [codex] 角色名 · 项目 · [挂起][交付]  │   ← 与 pi 会话头部一致
├──────────────────────────────────────────┤
│ xterm 终端面板（复用现有交互终端）          │
│  - 实时画面: fit + resize 同步 tmux        │
│  - 归档: 录制尺寸缩放重放                  │
│  - 输入: 点击终端直接输入（Tab/方向键原样）  │
├──────────────────────────────────────────┤
│ 提示条: 输入 /exit 结束会话 · [结束会话]    │
└──────────────────────────────────────────┘
```

- 列表项与 pi 会话一致（状态点/角色/时间）
- 消息流区整块替换为终端面板；**无** transcript/消息流/工具卡片
- 退出命令按 CLI 区分（现有逻辑：claude/codex = `/exit`）

## 5. 会话记录差异

| 数据 | pi 会话 | codex/claude 会话 |
|---|---|---|
| transcript | pi 会话文件（JSONL） | 无（终端输出） |
| 日志 | RPC 事件（可选落库） | tmux 日志同步 SQLite（现有 task_logs 机制） |
| 挂起恢复上下文 | switch_session | CLI 各自会话恢复 |

## 6. 里程碑与验收

- 里程碑：S5（排在 pi 会话 S-1a~S-1d 之后）
- 验收：
  - [ ] 会话 start/suspend/resume 全流程可用（codex、claude 各验一遍）
  - [ ] 终端实时画面 + 输入 + 尺寸同步正常
  - [ ] 交付后 worktree 复用合并正常
  - [ ] 挂起后恢复能接续 CLI 会话（各自 --continue 语义）
