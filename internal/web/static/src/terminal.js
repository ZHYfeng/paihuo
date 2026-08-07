// 模块 terminal（由 scripts/gen-globals.py 维护导入/导出）
import { api, closeModal, fetchTaskLogs, openModal, state, toast } from "./core.js";

export let term = null, termFit = null;
let termLogs = [];
let termHasMore = false;
let termOldestSeq = 0;
let termLoading = false;
let ignoreTopScroll = false;
let termInteractive = false;
let termGeometryObserver = null;
let termViewportResizeHandler = null;
// 全屏终端的显示模式：live=运行中（fit+resize 同步 tmux）｜replay=已结束
// （按录制尺寸重放并缩放适配容器）｜logs=批处理日志。
let termMode = "logs";
let taskTerm = null;
let taskTermTask = null;
let taskTermLogs = [];
// 详情页终端显示模式：live=运行中（fit+resize 同步）｜replay=已结束（缩放重放）。
let taskTermMode = "logs";
const terminalKeyQueues = new Map();

// PaiHuo 的交互式 agent pane 由浏览器 xterm 的实时尺寸驱动：打开终端时
// FitAddon 按容器 fit，并把 cols/rows 通过 resize API 同步给 tmux 窗口
// （agent 收到 SIGWINCH 后按新画布重绘）。这两个常量只是终端构造时的
// 初始值与 tmux 启动默认，打开后即被浏览器实际尺寸覆盖。
export const INTERACTIVE_TERM_COLS = 80;
export const INTERACTIVE_TERM_ROWS = 24;

const TERM_THEME = {
  background: "#070a08", foreground: "#c9d4e5", cursor: "#c7f36a",
  selectionBackground: "rgba(199, 243, 106, .24)",
  black: "#0b1019", red: "#f87171", green: "#34d399", yellow: "#fbbf24",
  blue: "#38bdf8", magenta: "#a78bfa", cyan: "#22d3ee", white: "#c9d4e5",
  brightBlack: "#5d6b84", brightRed: "#fca5a5", brightGreen: "#6ee7b7",
  brightYellow: "#fde047", brightBlue: "#7dd3fc", brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9", brightWhite: "#f1f5f9",
};

function terminalOptions(interactive = false, running = false, size = null) {
  return {
    ...(interactive ? { cols: size?.cols ?? INTERACTIVE_TERM_COLS, rows: size?.rows ?? INTERACTIVE_TERM_ROWS } : {}),
    // OMP and other TUIs use Nerd Fonts private-use glyphs. Keep the normal
    // monospace stack for text and use the bundled Symbols font as fallback.
    fontFamily: "var(--font-terminal)",
    fontSize: 12.5,
    lineHeight: 1.35,
    convertEol: true,
    scrollback: interactive ? 3000 : 10000,
    cursorBlink: interactive && running,
    disableStdin: !(interactive && running),
    theme: TERM_THEME,
  };
}

function interactiveTaskRunning(taskID) {
  const task = state.tasks.find(t => t.id === taskID);
  return task?.run_mode === "interactive" && task?.status === "running";
}

// 浏览器 xterm 的尺寸变化（fit 后）经 resize API 同步给 tmux 窗口。
// 任务不在运行/窗口已清理时后端返回 400，静默忽略；拖拽窗口时防抖只发最后一次。
let geometryReportTimer = null;
function reportTerminalGeometry(taskID, cols, rows) {
  if (!taskID || !cols || !rows) return;
  clearTimeout(geometryReportTimer);
  geometryReportTimer = setTimeout(() => {
    api(`/api/tasks/${taskID}/resize`, {
      method: "POST", body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  }, 150);
}

// xterm 的 onData 会为普通文字、Tab、方向键和组合键产生终端字节序列。
// 每个任务只保持一个串行请求队列，避免快速输入时多个 fetch 乱序抵达 tmux。
async function flushTerminalKeystrokes(taskID, queue) {
  queue.sending = true;
  try {
    while (queue.pending) {
      let end = Math.min(queue.pending.length, 4096);
      if (end < queue.pending.length && /[\uD800-\uDBFF]/.test(queue.pending[end - 1])) end--;
      const keys = queue.pending.slice(0, end);
      queue.pending = queue.pending.slice(end);
      try {
        await api(`/api/tasks/${taskID}/input`, {
          method: "POST", body: JSON.stringify({ keys }),
        });
      } catch (e) {
        queue.pending = "";
        if (interactiveTaskRunning(taskID)) toast(`终端输入发送失败：${e.message}`, true);
        break;
      }
    }
  } finally {
    queue.sending = false;
    if (!queue.pending && terminalKeyQueues.get(taskID) === queue) terminalKeyQueues.delete(taskID);
  }
}

function queueTerminalKeystrokes(taskID, keys) {
  if (!keys || !interactiveTaskRunning(taskID)) return;
  let queue = terminalKeyQueues.get(taskID);
  if (!queue) {
    queue = { pending: "", sending: false };
    terminalKeyQueues.set(taskID, queue);
  }
  queue.pending += keys;
  if (!queue.sending) void flushTerminalKeystrokes(taskID, queue);
}

function configureTerminalInput(target, enabled) {
  if (!target) return;
  target.options.disableStdin = !enabled;
  target.options.cursorBlink = enabled;
  target.element?.classList.toggle("terminal-writable", enabled);
  if (target.textarea) {
    target.textarea.setAttribute("aria-label", enabled ? "Agent 交互式终端输入" : "只读终端输出");
    target.textarea.setAttribute("aria-disabled", String(!enabled));
  }
  if (!enabled) target.blur();
}

function terminalRenderableLog(l) {
  // term 是新版本保存的原始交互终端字节块；out 兼容旧版本逐行归档。
  // sys/in 属于任务审计记录，混入 xterm 会改变 TUI 的光标坐标和画布。
  return l?.stream === "term" || l?.stream === "out" || !l?.stream;
}

function writeTerminalLog(target, l, callback) {
  if (!target || !terminalRenderableLog(l)) return;
  const content = String(l.content ?? "");
  target.write(l.stream === "term" ? content : content + "\r\n", callback);
}

function writeTerminalLogs(target, logs, emptyMessage = "（暂无输出）") {
  if (!target) return;
  const renderable = logs.filter(terminalRenderableLog);
  if (!renderable.length) {
    target.write(`\x1b[90m${emptyMessage}\x1b[0m\r\n`);
    return;
  }
  renderable.forEach((l, index) => {
    writeTerminalLog(target, l, index === renderable.length - 1
      ? () => target.scrollToBottom() : undefined);
  });
}

// 已结束任务的终端画面按录制尺寸重放，并用 transform 缩放适配容器：
// 录制帧无法 reflow，fit 只会造成换行错位/大片留白。缩放不改变缓冲区
// 尺寸，xterm 按原尺寸重放，视觉上整体缩放到容器内完整显示。
// 注意 .xterm 元素本身是块级盒子（宽度=容器宽度），真实帧宽高要从
// .xterm-rows（cols×cellW × rows×cellH）读取，padding 另计。
function scaleTerminalToContainer(term, host) {
  const el = term?.element;
  if (!el || !host) return;
  const rowsEl = el.querySelector(".xterm-rows");
  const natW = rowsEl?.offsetWidth || el.offsetWidth;
  const natH = rowsEl?.offsetHeight || el.offsetHeight;
  // clientWidth/clientHeight include CSS padding, so offset-client only gives
  // the border. The replay canvas has explicit xterm padding; omitting it from
  // the scale makes the glyph grid consume the entire host and pushes the
  // final column/right padding outside the clipped terminal body.
  const style = getComputedStyle(el);
  const px = value => Number.parseFloat(value) || 0;
  const padW = px(style.paddingLeft) + px(style.paddingRight) + el.offsetWidth - el.clientWidth;
  const padH = px(style.paddingTop) + px(style.paddingBottom) + el.offsetHeight - el.clientHeight;
  const cw = host.clientWidth, ch = host.clientHeight;
  if (!natW || !natH || !cw || !ch) return;
  const visW = natW + padW, visH = natH + padH;
  const s = Math.min(cw / visW, ch / visH);
  el.style.transformOrigin = "0 0";
  // translate 处于缩放后的坐标系，除以 s 得到容器像素偏移；居中留白对称。
  el.style.transform = `scale(${s}) translate(${(cw - visW * s) / 2 / s}px, ${(ch - visH * s) / 2 / s}px)`;
}

function scaleTaskTerminalToContainer() {
  const host = document.getElementById("taskTermX");
  if (!taskTerm || !host) return;
  scaleTerminalToContainer(taskTerm, host);
}

// xterm 的字体度量在首次渲染后才确定：刚 open 时的缩放可能基于未测量
// 的宽高（偏小），导致重放帧超出容器被裁掉最后一行。挂载后短暂重算
// 几次直到稳定（幂等，多余计算无害；后续窗口尺寸变化由 ResizeObserver
// 继续驱动）。
function scheduleRepeatedScale(fn) {
  for (const ms of [80, 250, 600]) setTimeout(fn, ms);
}

function syncFullscreenTerminalGeometry() {
  if (!term) return;
  const host = document.getElementById("termX");
  if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
  try {
    if (termMode === "replay") {
      scaleTerminalToContainer(term, host);
      return;
    }
    termFit?.fit();
    if (termMode === "live" && state.termTask) {
      reportTerminalGeometry(state.termTask, term.cols, term.rows);
    }
  } catch (_) {}
}

function observeFullscreenTerminalGeometry() {
  const host = document.getElementById("termX");
  if (!host || termGeometryObserver) return;

  termGeometryObserver = new ResizeObserver(() => {
    requestAnimationFrame(syncFullscreenTerminalGeometry);
  });
  termGeometryObserver.observe(host);

  termViewportResizeHandler = () => requestAnimationFrame(syncFullscreenTerminalGeometry);
  window.addEventListener("resize", termViewportResizeHandler, { passive: true });
  window.visualViewport?.addEventListener("resize", termViewportResizeHandler, { passive: true });
}

export function initTerm() {
  if (term) return;
  term = new Terminal(terminalOptions(termInteractive, false));
  termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open(document.getElementById("termX"));
  term.onData(keys => {
    if (state.termTask && termInteractive) queueTerminalKeystrokes(state.termTask, keys);
  });
  term.onScroll(event => {
    if (event.position === 0 && !ignoreTopScroll) loadOlderTerminalLogs();
  });
  observeFullscreenTerminalGeometry();
  syncFullscreenTerminalGeometry();
}

export function termWrite(content, raw = false) {
  if (term) term.write(String(content ?? "") + (raw ? "" : "\r\n"));
}

export function termAppendLog(l) {
  if (state.termTask !== l.task_id || !term) return;
  if (!terminalRenderableLog(l)) return;
  if (termLogs.some(existing => existing.id === l.id)) return;
  termLogs.push(l);
  writeTerminalLog(term, l, () => term?.scrollToBottom());
}

function renderTerminalWindow() {
  if (!term) return;
  syncFullscreenTerminalGeometry();
  term.reset();
  writeTerminalLogs(term, termLogs);
}

// xterm 本身适合渲染终端，但把数万条持久化日志一次写入仍会卡住页面。
// 首屏从末尾开始，用户滑到顶部时再把更早窗口合并后重绘一次。
async function loadOlderTerminalLogs() {
  if (!state.termTask || !termHasMore || termLoading || !termOldestSeq) return;
  const id = state.termTask;
  termLoading = true;
  try {
    const page = await fetchTaskLogs(id, { before: termOldestSeq, limit: 200 });
    if (state.termTask !== id) return;
    const existing = new Set(termLogs.map(l => l.id));
    const older = page.logs.filter(l => terminalRenderableLog(l) && !existing.has(l.id));
    if (!older.length) {
      termHasMore = false;
      return;
    }
    termLogs = [...older, ...termLogs];
    termHasMore = page.has_more;
    termOldestSeq = termLogs[0]?.seq || 0;
    ignoreTopScroll = true;
    const previousRows = term.buffer.active.length;
    renderTerminalWindow();
    term.scrollToTop();
    // 保持原来位于旧窗口顶部的内容仍在视口中；这样继续向上滑时会再次
    // 到达顶部并请求下一页，而不是停在刚加载页的最开头。
    term.scrollLines(Math.max(1, term.buffer.active.length - previousRows));
    setTimeout(() => { ignoreTopScroll = false; }, 0);
  } catch (_) {
    // 下次滑到顶部时重试。
  } finally {
    termLoading = false;
  }
}

export function openTerminal(id) {
  const t = state.tasks.find(x => x.id === id) || {};
  termInteractive = t.run_mode === "interactive";
  // 运行中的交互任务：fit + resize 同步 tmux（agent 按新画布重绘）；
  // 已结束的交互任务：按录制尺寸重放 + 缩放适配；批处理：普通日志视图。
  termMode = termInteractive
    ? (t.status === "running" ? "live" : "replay")
    : "logs";
  document.getElementById("termTitle").textContent = `${t.agent_name || ""} · #${id} 对话`;
  document.getElementById("termModal")?.classList.toggle("interactive-terminal-modal", termInteractive);
  document.getElementById("termX")?.classList.toggle("interactive-term-body", termInteractive);
  document.getElementById("termX")?.classList.toggle("interactive-term-replay", termMode === "replay");
  openModal("termModal");
  initTerm();
  if (termMode === "replay") {
    // 录制尺寸可能小于初始 80×24（打开过终端后结束的任务），先对齐再缩放。
    term.resize(t.terminal_cols || INTERACTIVE_TERM_COLS, t.terminal_rows || INTERACTIVE_TERM_ROWS);
    scheduleRepeatedScale(() => syncFullscreenTerminalGeometry());
  }
  setTimeout(syncFullscreenTerminalGeometry, 30);
  state.termTask = id;
  termLogs = [];
  termHasMore = false;
  termOldestSeq = 0;
  termLoading = false;
  ignoreTopScroll = true;
  term.reset();
  term.write("\x1b[90m# loading latest logs...\x1b[0m\r\n");
  syncTerminalInput(t);
  fetchTaskLogs(id, { limit: 200 }).then(page => {
    if (state.termTask !== id) return;
    const byID = new Map(page.logs.filter(terminalRenderableLog).map(l => [l.id, l]));
    for (const l of termLogs) if (!byID.has(l.id)) byID.set(l.id, l);
    termLogs = [...byID.values()].sort((a, b) => a.seq - b.seq);
    termHasMore = page.has_more;
    termOldestSeq = termLogs[0]?.seq || 0;
    renderTerminalWindow();
    term.scrollToBottom();
    setTimeout(() => { ignoreTopScroll = false; }, 0);
  }).catch(() => { term.write("\x1b[31m日志加载失败\x1b[0m\r\n"); });
}

export function closeTerminal() {
  clearTimeout(geometryReportTimer);
  configureTerminalInput(term, false);
  state.termTask = null; // 停止向已关闭的弹窗追加日志
  termLogs = [];
  termHasMore = false;
  termOldestSeq = 0;
  const bar = document.getElementById("termInputBar");
  if (bar) bar.classList.add("hidden");
  closeModal("termModal");
  document.getElementById("termModal")?.classList.remove("interactive-terminal-modal");
  document.getElementById("termX")?.classList.remove("interactive-term-body", "interactive-term-replay");
  termInteractive = false;
  termMode = "logs";
  // 全屏 live 终端会把 tmux pane 调整为全屏画布尺寸。关闭弹层后，详情页
  // 的容器宽高没有变化，因此它的 ResizeObserver 不会再次触发；若不主动
  // 归还尺寸，agent 会继续按全屏列数绘制，窄详情终端便会错行/截断。
  requestAnimationFrame(syncTaskTerminalGeometry);
}

// 详情页交互终端：运行中按容器 fit 并同步给 tmux（live）；已结束按录制
// 尺寸重放并缩放适配容器（replay，agent 不会再重绘，fit 只会错位/留白）。
let taskTermFit = null;
let taskTermResizeObserver = null;
function syncTaskTerminalGeometry() {
  const host = document.getElementById("taskTermX");
  if (!taskTerm || !host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
  if (taskTermMode === "replay") {
    scaleTaskTerminalToContainer();
    return;
  }
  if (!taskTermFit) return;
  try { taskTermFit.fit(); } catch (_) { return; }
  // 全屏 live 终端打开时由它独占 tmux 画布尺寸；视口变化也会让背后的
  // 详情终端 ResizeObserver 触发，不能让较小的 inline 尺寸抢写回来。
  const modal = document.getElementById("termModal");
  if (termMode === "live" && state.termTask === taskTermTask && modal && !modal.classList.contains("hidden")) return;
  reportTerminalGeometry(taskTermTask, taskTerm.cols, taskTerm.rows);
}

function observeTaskTerminalGeometry() {
  const host = document.getElementById("taskTermX");
  if (!host || taskTermResizeObserver) return;
  taskTermResizeObserver = new ResizeObserver(() => {
    // 录制帧不跟随容器尺寸，只重算缩放；live 模式则 fit 后同步给 tmux。
    requestAnimationFrame(syncTaskTerminalGeometry);
  });
  taskTermResizeObserver.observe(host);
}

// 详情页中的交互式任务不能按普通日志逐行排版。TUI 输出的是带光标移动、
// 擦除和同步刷新指令的 ANSI 控制序列流；用只读 xterm 按与 tmux 窗口同步
// 的尺寸重放，才能得到与 pane 一致的画面。
export function closeTaskTerminal() {
  const old = taskTerm;
  taskTermResizeObserver?.disconnect();
  taskTermResizeObserver = null;
  taskTermFit = null;
  taskTerm = null;
  taskTermTask = null;
  taskTermLogs = [];
  taskTermMode = "logs";
  document.getElementById("logBox")?.classList.remove("interactive-term-replay");
  // xterm 的 Viewport 在 open() 时 setTimeout(syncScrollArea)；若在下一个
  // 宏任务前 dispose，该回调会读取已清空的 _renderer.value 抛 TypeError。
  // 延迟到下一个宏任务再 dispose：旧终端的内部定时器先于 dispose 触发。
  if (old) setTimeout(() => { try { old.dispose(); } catch (_) {} }, 0);
}

export function openTaskTerminal(id, logs = [], running = false) {
  const host = document.getElementById("taskTermX");
  if (!host) return;
  const t = state.tasks.find(x => x.id === id) || {};
  closeTaskTerminal();
  taskTermTask = id;
  taskTermLogs = logs.filter(terminalRenderableLog);
  taskTermMode = running ? "live" : "replay";
  taskTerm = new Terminal(terminalOptions(true, running, running ? null : {
    cols: t.terminal_cols || INTERACTIVE_TERM_COLS,
    rows: t.terminal_rows || INTERACTIVE_TERM_ROWS,
  }));
  taskTerm.open(host);
  if (running) {
    taskTermFit = new FitAddon.FitAddon();
    taskTerm.loadAddon(taskTermFit);
    taskTermFit.fit();
    reportTerminalGeometry(id, taskTerm.cols, taskTerm.rows);
  }
  taskTerm.onData(keys => queueTerminalKeystrokes(id, keys));
  configureTerminalInput(taskTerm, running);
  observeTaskTerminalGeometry();
  document.getElementById("logBox")?.classList.toggle("interactive-term-replay", !running);
  if (!running) {
    scaleTaskTerminalToContainer();
    scheduleRepeatedScale(scaleTaskTerminalToContainer);
  }
  writeTerminalLogs(taskTerm, taskTermLogs, "（交互终端等待输出）");
}

export function focusTaskTerminal() {
  taskTerm?.focus();
}

export function taskTermAppendLog(l) {
  if (!taskTerm || taskTermTask !== l.task_id) return;
  if (!terminalRenderableLog(l)) return;
  if (taskTermLogs.some(existing => existing.id === l.id)) return;
  taskTermLogs.push(l);
  writeTerminalLog(taskTerm, l, () => taskTerm?.scrollToBottom());
}

export function taskTerminalText() {
  if (!taskTerm) return "";
  const buffer = taskTerm.buffer.active;
  const start = buffer.viewportY;
  const end = Math.min(buffer.length, start + taskTerm.rows);
  const lines = [];
  for (let row = start; row < end; row++) {
    lines.push(buffer.getLine(row)?.translateToString(true) || "");
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

// syncTerminalInput 与任务 SSE 同步：只有正在运行的交互式任务才能收到
// 原始按键，任务退出后立即收起提示栏并把终端切回只读。提示文案中的退出
// 命令按 CLI 显示（pi 为 /quit，其余 /exit）。
export function syncTerminalInput(t) {
  const bar = document.getElementById("termInputBar");
  const enabled = t?.run_mode === "interactive" && t?.status === "running";
  bar?.classList.toggle("hidden", !enabled);
  configureTerminalInput(term, enabled);
  if (t) {
    const agent = state.agents.find(a => a.id === t.agent_id);
    const exitCmd = agent?.cli === "pi" ? "/quit" : "/exit";
    const help = document.getElementById("termInputHelp");
    if (help) help.innerHTML = `点击终端直接输入 · Tab / ↑ / ↓ 由当前 CLI 处理 · <code>${exitCmd}</code> 结束`;
  }
}

// sendTaskInput 通过服务端再转交给专用 tmux；浏览器不接触 tmux socket，也不
// 能把文本解释成 shell 命令。inputID 为空时使用 explicitMessage（/exit 按钮）。
export async function sendTaskInput(id, inputID, explicitMessage) {
  const input = inputID ? document.getElementById(inputID) : null;
  const message = explicitMessage ?? input?.value ?? "";
  if (!message.trim()) {
    toast("消息不能为空", true);
    return false;
  }
  try {
    await api(`/api/tasks/${id}/input`, { method: "POST", body: JSON.stringify({ message }) });
    if (input) {
      input.value = "";
      input.focus();
    }
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

export function focusFullscreenTerminal() {
  term?.focus();
}

/* ============================================================
   任务创建 / 模板
   ============================================================ */
