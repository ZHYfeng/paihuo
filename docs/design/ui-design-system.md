# UI 设计系统（2026-08 高端化改版）

本轮目标：在不改功能与信息架构的前提下，把整个前端打磨为「高端精致」的
Agent 运维控制台质感。所有改动集中在设计令牌与共享组件，页面结构未变。

## 设计决策

- **延续品牌色系**：保持蓝色家族，不换品牌色；通过"品牌渐变 + 辉光"建立
  高级感，而不是引入新色系。`--brand-grad` 用于主按钮、Logo、导航指示条。
- **层次靠阴影而非边框堆叠**：`--shadow-card`（常态）、`--shadow-pop`
  （悬浮/浮层）、`--shadow-glow`（主按钮/品牌元素）三层阴影体系，配合
  hairline 边框与 1px 内高光（`inset 0 1px 0`），卡片呈"浮起"而非"平贴"。
- **字体自托管**：Inter 可变字体（latin 子集，woff2，共 ~100KB）经
  `@font-face` 内嵌，中文回退 PingFang/雅黑。CSP `font-src 'self'` 下不依赖
  外网。正文启用 Inter `cv11`（单层 a）字形。
- **状态可感知**：状态点加同色 3px 辉光圈；看板列保留语义色顶边并加柔和
  渐变底；活动坞 active 态加外辉光。
- **微交互**：卡片悬浮 -1px 上浮 + 阴影加深；主按钮按下 -1px；折叠区
  悬浮轻微右移；统计条悬浮上浮。全部遵守 `prefers-reduced-motion`。

## 令牌（frontend/src/styles.css）

明暗两套，均在 `:root` / `.dark`：

| 令牌 | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--canvas` | `#eef1f6` | `#070d18` | 页面底色 |
| `--surface` | `#ffffff` | `#0d1524` | 卡片/面板 |
| `--elevated` | `#f6f8fc` | `#131d30` | 次级底 |
| `--hover` | `#edf1f8` | `#1a2740` | 悬浮底 |
| `--line` | `#dbe2ec` | `#223252` | 边框 |
| `--ink` / `--muted` / `--faint` | `#101828` / `#55617a` / `#8492a8` | `#e9eef9` / `#9aa8c4` / `#68789b` | 文字三级 |
| `--brand` | `#3a63e8` | `#5b82f5` | 品牌主色 |
| `--brand-strong` | `#2b4ecb` | `#7d9cf8` | hover/按下 |
| `--brand-soft` | `#3d63e0` | `#9db6ff` | 品牌文字强调 |
| `--brand-grad` | 上亮下深蓝渐变 | 同 | 主按钮/Logo/指示条 |
| `--shadow-card/pop/glow` | 见 styles.css | 同 | 三层阴影 |
| `--success/warning/danger` | `#0d9f6e` / `#b06a1f` / `#d13b5c` | `#3dd68c` / `#f2b45c` / `#ff8193` | 语义色 |

## 组件落点

- `components/shell.tsx`：渐变 Logo（内高光 + 辉光）、导航激活指示条、
  连接状态胶囊（呼吸点）、页头 kicker 渐变短线。
- `components/ui.tsx`：主按钮渐变 + 辉光；次级按钮白底 + 悬浮描边；
  对话框 `shadow-pop` + 毛玻璃遮罩；输入焦点 4px 品牌晕圈；Toast 状态点。
- `styles.css`：统计条/工作台卡/看板列/消息卡/折叠面板/日志面板/开关/
  状态点/chips/进度条/活动坞等全部组件按上表令牌重写。
- 登录页（`public/login.css` + `templates/login.html`）：品牌渐变 Logo 与
  按钮、玻璃拟态登录卡、轨道动画环、点阵网格背景；favicon 同步为品牌蓝。

## 顺手修复（非视觉）

- 看板页移动端横向溢出：`grid` 单列轨道改 `grid-cols-1`（`minmax(0,1fr)`），
  看板列在容器内滚动而非撑破页面。
- 表格卡片 `overflow-hidden` → `overflow-x-auto`：移动端表格可横滚不裁切。
- `npm run dev` 路由 404：router 按 `import.meta.env.DEV` 追加
  `BASENAME=/static/`，dev 下 `/static/...` 深链接可用，生产行为不变。
- 示例数据验证时发现 `datetime('now','-1 min')` 中 `min` 是非法修饰符
  （应写 `minute`）——仅影响测试脚本，未改产品代码。

## 验证

- `npm run typecheck` / `lint` / `test`、`make build` 全绿。
- `scripts/e2e.sh`（13 路由 + API 并发契约 + 390px 移动端响应式）通过。
- 明暗两套主题、13 个页面 + 登录页逐页 DOM/计算样式核对，无横向溢出。
- 截图存档见 `/tmp/paihuo-design/shots/`（16 张，含登录页与亮色工作台）。

---

# 二轮：布局精简（同日）

在高端化改版之后按「运维控制台」方向收敛：保留全部页面与导航项（信息架构
不动），去装饰、收留白、压密度。可逆，改动集中在 shell / ui / styles / 登录页。

## 移除的装饰

- 导航：激活渐变指示条、条目右侧 ChevronRight、Logo 辉光/内高光/渐变底
  （纯色 `bg-brand`）、连接状态胶囊 → 纯文字行（去呼吸点动画）。
- 页头：kicker（英文小标签 + 渐变短线）整体删除，`PageHeader` 去掉
  `kicker` 属性，13 处调用同步清理。
- 品牌渐变：`--brand-grad`、`--shadow-glow` 令牌删除（全库无引用）；
  主按钮/管理页 Tab 激活态由渐变+辉光改为纯色 `bg-brand`。
- 辉光圈：状态点（`.st-dot`）、看板列头点、`task-meta-accent`、
  `dash-empty-mark`、`prov-chip.login`、`rail-marker`、登录卡点全部去掉
  同色 halo。
- 悬浮微交互：卡片/统计条 -1px 上浮、折叠区/子任务右移、阴影加深全部移除，
  仅保留边框色变化。
- 登录页：轨道动画环（orbit + flow 节点 + core）、eyebrow、card kicker、
  hero-foot 删除；Logo 与主按钮纯色；点阵网格背景保留。

## 收紧的密度

- 侧栏 `w-52` → `w-48`，导航条目 `min-h-9` → `min-h-8`、图标 18 → 16；
  移动端顶栏 `h-16` → `h-14`；主内容 `p-4/6/8` → `p-4/5/6`。
- 页头标题 `28/30px` → `20/24px`，`mb-7` → `mb-5`。
- 按钮 `min-h-10` → `min-h-9`（sm 9 → 8）、圆角 2xl → lg；输入
  `min-h-11` → `min-h-10`、去 shadow-card；卡片 `p-5` → `p-4`、2xl → xl；
  对话框 `p-6` → `p-5`、标题 xl → lg；Empty/Spinner 高度同步收紧。
- 阴影降级为单层 1px（`--shadow-card` / `--shadow-pop` 各减一层大半径扩散）。
- 组件内边距：统计条（12/15 → 10/12、数字 23 → 20px）、消息卡、看板列、
  日志面板、折叠面板、子任务、提示/告警/驳回块等统一 2xl→xl 圆角与收窄。
- 页面网格 `gap-6/7` → `gap-5`，内联卡片 `rounded-2xl p-5` → `rounded-xl p-4`。

## 验证

- `npm run typecheck` / `lint` / `vitest` / `npm run build:frontend` /
  `make build` 全绿；`scripts/e2e.sh`（13 路由 + API 契约 + 390px）通过。
- 浏览器逐页 DOM/计算样式核对：9 个页面无横向溢出、无 kicker/渐变/辉光
  残留；侧栏 192px、导航条目 32px、页头 24px、统计条纯色 12px 圆角；
  登录页无 orbit/eyebrow/kicker/foot；移动端 390px 顶栏可见、侧栏隐藏。

