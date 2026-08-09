# Changelog

This file records notable user-facing and maintainer-facing changes. The format follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are added when releases are tagged.

## Unreleased

### Added
- **模板管理页（管理分组新增「模板」入口）**：任务模板此前只能从任务详情「保存为模板」沉淀、列表渲染代码指向不存在的元素（无任何管理入口，只能改数据库）。现在侧栏「管理」分组新增「模板」页：完整管理列表（名称/角色/内容预览/创建时间）+ 新建/编辑/删除（新增 `PATCH /api/templates/{id}` 与 `GET` 单条接口），弹窗可直接编辑名称、提示词与绑定角色；列表操作「新建任务」用模板直接打开新建任务弹窗并预填内容与角色，与新建任务弹窗的「从模板填充」下拉同源联动。
- **会话加载更早消息改为自动加载并修复分页**：会话页顶部「Load earlier messages」按钮此前无法加载任何更早消息——transcript 分页的 `before` 游标取的是「游标及其后」一页，而前端向上滚动要的是「游标之前」一页，两者恰好重叠导致每次请求都返回同一窗口、去重后零新增；且合并后只刷新了页面组件、消息流未重渲染，点了像没点（刷新页面才看到）。现在 `before` 游标改为返回该 entry 之前的 limit 条（不含游标），删除按钮，向上滚动自动逐页加载（滚动位置精确补偿，不再跳进新加载区），加载完自动停（「已到会话开头」），翻到底判定不再依赖「已加载数 < 文件行数」（toolResult 等不可渲染条目会让该判定永远为真、反复请求空页）。
- **会话顶部进度条与消息计数实时同步**：conversation-rail 与状态栏「N 条消息」此前只在页面刷新后同步——分页加载后 `transcriptLoaded` 从未更新（进度条永远停在首屏位置），实时消息追加也不计入计数，且消息流在 store 变化后不重渲染。现在分页合并后派发 `ph-session-transcript` 事件驱动消息流/状态栏刷新，实时追加（user_echo / message_start / 提问卡片）同步递增已加载与总数，进度条与计数随对话实时移动，无需刷新。

- **修复「进行中」计数显示全部任务数**：`ProjectStatsOf`/`OverviewStatsOf` 把 `statusCountsOf` 的第二个返回值（任务总数）误赋给 `in_flight`——项目页/全局统计条的「进行中」一直显示该范围的全部任务数（含已完成的会话交付任务及其合并任务），而不是 queued/claimed/running/awaiting_review 的实际进行中数量。现在统一用 `inflightCount` 按状态求和（与 `AgentStatsOf` 既有语义一致），交付会话后项目页「进行中」不再虚高。
- **会话交付即终态，杜绝反复交付**：交付任务此前被删除时会话自动**解冻回 suspended**——会话可恢复、修改、再次交付，反复创建新的合并任务（同一会话的成果被反复合并）。现在 `delivered` 是终态：不再解冻、不可恢复、不可再次交付；删除交付任务时会话**联动清理**（delivered → deleted，清理 worktree）；已交付会话也可手动「丢弃」（归档出口，不影响已创建的任务）。git 项目交付时（full 与 review 均）快照会话 worktree 到会话分支，最终成果落定分支，合并任务（含审批后的 review 合并）不再依赖会话 worktree 仍存在。
- **非 git 会话任务不再携带伪分支**：`workspace.Ensure` 对 SessionID 任务只要会话复制目录存在就无条件返回 `paihuo/session-<id>` 分支名（不管项目是否 git），执行器持久化后 `finishRun` 误入代码合并分支、`Snapshot` 对非 git 目录跑 git 失败（线上任务 #169「测试skills」即因此 failed）。现在非 git 项目一律返回空分支，与「非 git 项目无合并环节」语义一致；review 驳回重做的非 git 会话任务结算恢复正常。
- **会话交付直接收编，不再派 agent 重跑**：交付任务此前以 `queued` 进入批处理队列，执行器会派 agent 用「裸标题」（无任何会话上下文）在已含会话成果的 worktree 里重跑一遍——重复劳动且有改坏风险；且 git 项目交付后快照阶段因 worktree 路径错位（按 `task-<id>` 找 `session-<id>` 目录）必然失败。现在交付 = 收编已完成的工作：`review` 直接进 `awaiting_review`（第一轮成果等人工审批），`full` + git 直接快照会话分支并自动创建代码合并任务，`full` + 非 git 直接 `succeeded`——交付本身不再触发执行；任务 body 为空时预填会话摘要（角色/项目/创建与最后消息时间/消息数 + 会话回链）；workspace `Status`/`Snapshot` 按 `SessionID` 定位会话 worktree，任务详情 diff/状态与交付后的自动合并对交付任务正确工作。驳回重做（review 任务被驳回回 queued）仍会派 agent 携带修改意见在会话 worktree 里处理，是唯一的执行入口。
- **终端式会话输入框光标错位修复**：光标归位此前固定到「帧最后一行末尾」，而 TUI（codex/claude）输入框在底部提示符行（`›`/`❯`），帧尾通常是空行——用户输入时字符显示在提示符行、光标却闪烁在底部空行，看起来输入框「不对」。现在从帧尾部向上找最后一个提示符行，光标落在其内容末尾（找不到则回退到最后一个非空行末尾），行级 diff 与整帧写入两条路径统一；输入回显后光标跟随在已输入内容末尾。
- **终端式会话（codex/claude）中文/宽字符错乱修复**：帧同步的行宽截断此前按 JS 字符串长度（`slice(0, cols)`），而 CJK/全角/emoji 在终端占 2 列——含中文的行截断后实际超宽，xterm 自动折行导致后续行整体错位（交互式对话的中文消息/代码注释必触发）。现在按显示宽度截断（宽字符表：CJK 统一表意、全角符号、Hangul、emoji 等占 2 列，不拆宽字符），整帧/行级 diff 两条写入路径统一走宽度感知截断。
- **会话页移动端改为 master-detail 布局**：未选中会话时只显示全高可滚动的会话列表（不再被大块「选择或新建」空态挤压到 38vh 小条），点击会话后只显示聊天界面，会话头部新增「← 返回列表」按钮（仅 ≤860px 显示）；桌面两栏布局与行为不变。修复移动端会话列表几乎不可见的问题。
- **全站移动端体验优化**：① 定时任务页桌面表格在 ≤720px 转为带区域布局的纵向卡片（与历史/技能/角色列表一致），启用开关 44×44 触控目标、编辑/删除按钮 ≥38px，长模板文本不再截断；② 任务看板手机端车道横向滑动改为滚动吸附（scroll-snap，一屏一列、松手对齐），列宽按屏宽收缩、列高提升至 55vh 增加可见卡片；③ 全站元信息字号提升（8–9.5px → 10–10.5px：侧栏组标签/页眉小标/登录页眉/技能来源标签/列表表头等），对比度与可读性改善；④ 触控目标统一：≤640px 时 `.btn.xs` 从 34px 提至 38px（修正被基础样式覆盖的问题）；⑤ 平板端详情侧栏取消 45% 视口限高（单列自然流）；⑥ 会话页移动端重置 480px 最小高度；⑦ 合并审批备注输入框宽度自适应（`width:100%; max-width:260px`）。
- **终端式会话（codex/claude）画面错位/顶部丢失修复**：此前终端帧渲染有三处缺陷——① 整帧写入用 LF 换行，而 xterm 的 LF 只换行不归列，连续写入时每行从上一行末尾列继续，帧逐行 wrap 错乱累积；帧行数超过画布行数（resize 同步窗口期：浏览器先 fit、tmux pane 后跟上）时整帧写入还会触底滚动，把帧顶内容滚出视口，行级 diff 只改变化行、错乱永不修复；② 「纯追加」分支在 TUI 快照语义下会把帧中段改写误判为帧尾追加，错位后不可自愈；③ 帧宽于画布时 xterm 自动折行导致行号错位。现在整帧换行统一 CRLF、删除追加分支、行级 diff 按画布行数截断并清残留行、超宽帧按画布列截断、整帧写入前清空回滚区。
- **交付任务删除后会话联动清理**：会话交付的任务（`sessions.task_id` 外键引用）此前**无法删除**——硬删触发 `FOREIGN KEY constraint failed` 500，任务残留为 cancelled「任务已删除」。现在删除任务时先解除会话引用（`task_id` 置空），delivered 会话联动清理为 `deleted`（不再解冻回 suspended——见「会话交付即终态」条目），任务可正常删除。
- **活跃会话可丢弃**：codex 等终端式会话 active 状态此前只有「中止/交付」，无法丢弃；现在 header 增加「丢弃」按钮（确认后中止进程、清理 worktree、删除会话），状态机 `active → deleted` 本就允许。
- **终端式会话（codex/claude）结束后回放最后画面**：此前交付/挂起/进程退出后终端窗口消失，重新打开会话终端区域永远空白（`TermOutput` 对无活跃进程的会话返回 409，前端吞掉后停在初始空画面）。现在每次捕获帧都持久化到 `<session_dir>/term.out`，无活跃进程时回退读取：delivered/deleted 返回最后画面并停止轮询，created/suspended 保持轮询直到自动恢复拉起真实窗口（避免过早停轮询导致恢复后空白）。
- **codex 会话不再卡在目录信任确认**：codex 交互 TUI 对不在信任列表的目录每次新进程都会弹「Do you trust the contents of this directory?」并等回车（实测 `--skip-git-repo-check` 仅 exec 子命令可用、`skip_git_repo_check` 配置项与 `-c` 覆盖对 TUI 均无效、无环境变量，交互模式没有真正的跳过开关），会话恢复时重新 spawn 就卡在确认画面。现在 spawn 后自动检测该确认并回车选择「Yes, continue」（仅匹配 codex 专属文案，120 秒窗口、命中一次即止、窗口消失即退），等效跳过检查：paihuo 不写任何配置文件，确认由 codex 正常处理（与用户手动回车等价，codex 自行记录已确认目录）。会话目录是 paihuo 管理的隔离 worktree，与批处理任务（exec 自动跳过检查）同权。
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

- **会话页 UI 并入全站设计系统（Carbon lattice v4），消除与其余页面的割裂**：会话页此前自成一套 pi-web-dark 调色板（bg #070912 / surface #101527 / border #26304f / accent #7c3cff / success #00f0d8），与全站（碳色背景 #0c100d + lime→mint 品牌渐变）视觉不一致。现在把组件内 `--pw-*` 语义别名整体映射到 app.css 全局 token（背景/表面/边框/前景/品牌/状态色/弹窗遮罩/阴影/字体族），主题变化一处生效，pi-web 硬编码色值全部移除。配套细节对齐：页面宿主由悬浮面板（边框+圆角+固定高度）改为铺满 `.page-content` 全宽布局；字体族统一为全站 `--font-sans`/`--font-mono`；主操作按钮（发送/交付/创建/确认）改用品牌渐变（与 `.btn.primary` 一致），危险按钮沿用 danger 语义；会话状态点/徽标对齐全站任务状态色（活跃=蓝、已交付=绿、挂起/未启动=弱化）；输入框/弹窗底色、圆角、阴影、遮罩对齐 `.modal`/`.btn`/输入控件；历史边界、工具状态徽标、事件条等英文残留文案与角色标签（user/assistant→用户/助手）统一为中文，事件条移除 emoji 图标。
- **会话页 UI 一比一复刻 pi-web 当前默认主题（pi-web-dark）**：设计 token 从早前的 GitHub 暗色 classic 调色板（#0d1117/#58a6ff）整体切换为 pi-web 默认的深紫主题（bg #070912、surface #101527、border #26304f、强调 #7c3cff、成功 #00f0d8、警示 #ffb000、危险 #ff4f7b），消息卡片、聊天排版、工具卡片与输入区按 pi-web `chatStyles`/`formattedTextStyles`/`ToolExecutionView`/`promptEditorStyles` 一比一对齐：`.msg` 卡片（12px 内边距/10px 圆角/1px 边框）+ 吸顶 `msg-header`（12px 大写角色 label + 右侧 meta/复制操作，悬停渐显，meta 点击展开完整元信息）；消息头 meta 改为 pi-web 格式（时间 · 模型 · 思考级别，Intl medium）；工具卡片重写为 tool-execution-view 结构（pending/success/error 状态边框、✓/✖/○ 状态图标、大写状态徽标、Details 结果区与 diff 着色）；bash 消息改为 `.msg.bash` 成功色边框卡片；thinking 折叠为 pi-web 的 `thinking` 小写标题细节块；markdown 排版对齐 formattedTextStyles（代码块 code-block-wrapper + 右上角复制按钮、行内 code、表格、引用、标题层级）；消息流新增 pi-web 的顶部会话进度条（conversation rail）、顶部历史边界（"Load earlier messages" 药丸 + "Scroll up to load earlier messages" + "Showing messages X–Y of Z"）、右下活动药丸（idle/发送中/处理中，成功色呼吸点）与底部状态栏（活动点 + 模型 + 思考级别 + 消息数）；输入区对齐 prompt-editor（footer 网格、54px 输入框、运行中 shell-mode 成功色态 + 模式药丸、36px 图标发送按钮）；会话列表改为 pi-web 列表卡片风格（12px 大写标题、边框卡片行、选中态强调色）。复制代码块/复制消息的事件委托经 `composedPath()` 取 shadow 内部按钮（composed 事件在 shadow 边界外 `e.target` 会被 retarget 成宿主）。
- **交互式会话收窄到 pi / omp，S5 终端降级通道彻底移除**：会话页（常驻交互工作区）与任务交互式执行方式现在只支持 pi / omp 角色（两者有 RPC 消息流通道）；opencode / claude / codex 无结构化消息通道，仅批处理执行。新建会话表单只列出 pi / omp 角色（无可用角色时给出引导提示），任务弹窗的「会话」选项对其它角色置灰并回退批处理，后端在创建/改派交互式任务与创建会话时显式拒绝（「交互式任务/会话只支持 pi / omp 角色」）。会话的 S5 终端降级通道整体移除：删除 `termProc` 实现、`/api/sessions/{id}/terminal/{input,resize,output}` 端点、`BuildInteractiveArgs` 与前端终端式会话组件，会话一律为 pi/omp 消息流视图；遗留的非 pi/omp 会话无法再启动（启动报错），可在会话页删除。定时任务与批处理不受任何限制。
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
