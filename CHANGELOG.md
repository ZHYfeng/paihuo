# Changelog

This file records notable user-facing and maintainer-facing changes. The format follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are added when releases are tagged.

## Unreleased

### Added

- **codex 会话不再弹目录信任确认**：codex 交互 TUI 每次新进程都会对不在 `~/.codex/config.toml` 信任列表的工作目录弹出「Press enter to continue」确认（且 `--skip-git-repo-check` 仅限 exec 子命令，TUI 无命令行开关），恢复会话时重新 spawn 就会卡在确认画面，看起来像显示异常。现在 spawn 前把会话 worktree 目录预写入 codex 信任列表（`[projects."<dir>"] trust_level = "trusted"`，文件锁防并发双写、已存在跳过），直接进入 TUI；会话目录是 paihuo 管理的隔离 worktree，与批处理任务同权。
- **新建会话不再默认绑定项目**：此前「项目」下拉默认选中第一个项目，不手动选择也会实际归属该项目；现在默认「（无项目）」，不选择即不关联任何项目——会话在独立目录（`sessions/session-N`）运行，头部/列表不再显示项目名。无项目会话无法交付为任务（任务必须在项目目录执行，后端显式拒绝并提示）。
- **会话统一自动启动，去掉「启动」按钮**：打开会话视图时 `created` 状态自动启动、终端式（codex/claude）`suspended` 状态自动恢复（pi/omp 挂起会话仍由发送消息触发恢复，不提前拉起）；新建会话带初始指令时等待自动启动完成后自动发送，不再重复调用 start。
- **会话支持 omp（Oh My Pi）agent**：omp 与 pi 同族 RPC 协议（`--mode rpc`，实测 `ready` 握手、`get_state`/`prompt`/`abort`/`switch_session` 命令与事件流兼容），会话走与 pi 相同的消息流视图（思考/文本/工具卡片/提问卡片），支持挂起恢复（`switch_session` 接续会话文件）与角色参数映射（`--model`/`--append-system-prompt`/`--thinking`/`--skills` 或角色级 overlay `--config`/`--tools`/`--max-time`/`--profile`/`--provider`/plugins）。差异点已适配：omp 回合结束用 `agent_end`+`turn_end`（pi 用 `agent_settled`），前端按同一语义清空挂起状态。
- **终端式会话（codex/claude）实时输出修复**：三处根因——① xterm 初始化时机错误（Lit 的 `connectedCallback` 先于首次 render，`.term-wrap` 还不存在，`_init` 静默退出，终端永远空白）；② tmux `capture-pane` 按字节 offset 截增量，TUI 原地重绘/清屏/随尺寸重排时必然错位累积垃圾，改为全量帧 + 前端行级 diff（纯追加增量写入、等行数重绘只重写变化行、清屏/重排整帧 ANSI 重写，不再整屏 `reset` 导致 DOM renderer 渲染丢失）；③ xterm 的 Enter 键在 onData 里是 `\r` 字面量，`send-keys -l` 会把它当普通字符输入而不是回车键，TUI（如 codex 的目录信任确认）会卡在等待回车——现在 `\r` 拆出转 `Enter` 键，且字符与回车之间留 120ms 事件循环时间（过早的回车会被 TUI 丢弃）。
- **会话消息 markdown 渲染修复**：`md()` 生成的 HTML 此前以字符串插值进 Lit 模板，被当作纯文本转义，带列表/行内代码/加粗的消息（如 pi 的问候语 `<ul><li>`、`<code>`）全部以字面量显示。改用 `unsafeHTML` 渲染 markdown 输出，并加固链接：剥除引号/空白、仅放行 http/https/mailto/锚点/相对路径，其余协议（如 `javascript:`）落为 `#`。
- **会话页修复 pi agent 交互式提问的显示与应答**：此前 `ask_user` 等扩展的提问（RPC `extension_ui_request`，select/confirm/input/editor）字段在后端 JSON 解析边界被丢弃、前端也不渲染，提问完全不可见、无法作答（`prompt` 只会被 pi 当作新回合，对话卡死单向）。现在提问以问答卡片实时渲染（选项按钮/确认/输入），应答走新增的 `POST /api/sessions/{id}/ask`（`extension_ui_response`）；回合结束时未应答的提问自动标记「已跳过」，输入框不会永久冻结。历史回看同样补全：transcript 里的 `custom_message`（`pi-web.ask.answers` 提问-回答记录，按题目/选项渲染）与 `custom`（如 `web-search-results`）条目不再被丢弃。
- **已结束交互任务的终端画面按录制尺寸重放并缩放适配容器**：运行中打开过终端的任务会在数据库记录最后同步的 tmux 窗口尺寸（`terminal_cols`/`terminal_rows`，Start 与每次 resize 持久化）；任务结束后详情页/全屏终端按该尺寸重放最后画面，并用 transform 缩放居中完整显示，不再按浏览器容器 fit 重排——录制帧无法 reflow，fit 只会造成长行错误换行、TUI 状态栏错位与大屏大片留白。未记录尺寸的任务回退 80×24。运行中的任务仍保持 fit + resize 同步 tmux（agent 收到 SIGWINCH 按新画布重绘）。
- 修复 xterm 在终端被快速重建（任务 SSE 触发详情页重渲染）时的未捕获异常：`Terminal.open()` 内部 `setTimeout(syncScrollArea)` 在旧终端 dispose 后触发会读取已清空的 renderer 抛 TypeError，现在旧终端延迟到下一个宏任务再 dispose。
- 交互终端尺寸标签不再硬编码 80×24：运行中显示「实时画面 · 跟随浏览器尺寸」，已结束显示「已归档画面 · <录制尺寸>」。
- 终端输入提示的退出命令按 CLI 显示：pi 显示 `/quit`，其余 CLI 显示 `/exit`（此前提示一律 `/exit`，与「结束会话」按钮的实际行为不一致）。

- Reproducible frontend tooling through `package.json` and `package-lock.json`.
- `make` targets for build, test, race detection, frontend synchronization, and the full quality gate.
- GitHub CI, CodeQL, Dependabot, issue forms, and a pull-request checklist.
- Contribution, support, security, and community conduct documentation.
- `--version` and `--secure-cookie` runtime flags.

### Changed

- **测试执行器改用独立 tmux socket**（`exec.NewForTest`）：此前 `internal/server` 测试经 `exec.New` 创建的执行器与生产共用同一个 tmux server（`-L paihuo` / session `paihuo`），测试删除任务（`DELETE /api/tasks/{id}`）会真实执行 `kill-window -t paihuo:task-<测试ID>`，经 tmux 窗口名前缀匹配误杀线上存活任务窗口（任务 113/116 的多次失败均源于此——后两次甚至是 OMP agent 自己运行 `go test ./...` 所致）；现在 12 处测试调用点全部切到独立 socket，对生产 tmux 零接触。
- **任务 tmux 窗口名加 `ph-` 前缀**（`ph-task-<ID>`）：tmux 对窗口名做唯一前缀匹配，外部命令 `kill-window -t paihuo:task-1` 会因 `task-1` 是 `task-116` 等的前缀而误杀任务窗口（任务 116/123 因此两次失败）；加前缀后此类输入不再匹配任务窗口（报错或仅命中 control 回退）。运行目录仍为 `task-<ID>`，与历史任务目录/归档兼容。
- 任务窗口创建后切回 control 为会话当前窗口：外部 kill-window 目标解析回退时不再以任务窗口为靶。
- 窗口消失且无退出码时增加 3 秒宽限重读：正常完成的短任务不再因退出码落盘竞态被误判为窗口丢失。
- 「结束会话」按 CLI 发送正确的退出命令：pi 为 `/quit`（`/exit` 只会被当普通对话消息，pi 不会退出），其余 CLI（omp/opencode/claude/codex）为 `/exit`。新增 `POST /api/tasks/{id}/end-session` 由后端按角色 CLI 决定命令，前端不再硬编码。
- 交互式任务终端不再固定 80×24：浏览器 xterm 按容器自适应（FitAddon），尺寸经新增的 `POST /api/tasks/{id}/resize` 同步给 tmux 窗口，agent 收到 SIGWINCH 后按新画布重绘 TUI（任务启动默认仍为 80×24，打开终端后即跟随浏览器）。
- 移除已废弃的 `POST /api/workspace/{id}/merge` 手工合并端点（代码合并在合并任务成功结算时自动执行，前端早已不再调用）。
- 清理静态检查发现的死代码：`ompModelsProbe`、`importSkill` 包装、`nullStr`、`terminalStats` 常量、`Scheduler.stopped` 字段、测试内未用的 `execGit` 等。
- 修复 tmux 3.5 的格式变量兼容性：交互终端尺寸断言改用 `#{window-size}`（旧 `window_size_option` 已移除），测试恢复通过。
- 新增部署文档 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 与 systemd 服务文件模板（`deploy/systemd/`），记录本机部署实例（用户服务 + `token.env` + `KillMode=process`）。
- `.gitignore` 增加 `.tmp/`（测试临时目录）；README 运行环境更新为 Go 1.25+。
- 角色技能物化重构：技能改为**角色级常驻挂载**（`<sessionsRoot>/.role-agents/<agentID>/`，symlink 零复制 + 幂等对账），不再逐任务复制到 worktree/项目目录——结构性消灭 git 提交污染与目录污染，崩溃/重启自动对账恢复
- 各 CLI 技能加载方式：pi `--skill` 逐目录、omp `--config overlay.yml`（自动合并全局 `customDirectories`）、opencode 注入 `OPENCODE_CONFIG_CONTENT`（弃用无效的 `--config` 字段；与项目 `opencode.json` 的 `skills.paths` 深合并已实测）、claude `--plugin-dir`、codex 任务级 symlink 到 `$CODEX_HOME/skills`（未设置时回退 `$HOME/.agents/skills`；只被 codex 扫描，不污染 pi/omp 上下文，结束即删，manifest 兜底）
- 非 git 项目 + codex（safe 模式）自动注入 `--skip-git-repo-check`，不再依赖 yolo 或临时 git init（角色工作台同步切换）
- 角色技能变更保存后立即对账；角色删除后技能目录进 `.stale` 保留 7 天；启动时一次性清理旧机制残留在 worktree 的 `paihuo-*` 副本（仅该前缀，不碰用户技能）
- 技能 frontmatter `name` 与目录名不一致/非法时回退为副本并改写 name；缺 description 仅告警（omp 下不可见）；任务提示词技能名与各 CLI 实际可见名统一（codex 按 frontmatter name/目标目录名显示，已实测）

- The default listen address is now `127.0.0.1:8080`; binding a non-loopback address without an access token is rejected.
- Session cookies use a cryptographically random nonce and complete HMAC signature.
- HTTP responses include a browser-security baseline, dynamic responses are not cached, and JSON request bodies are bounded and strictly parsed.
