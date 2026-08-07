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
let taskTerm = null;
let taskTermTask = null;
let taskTermLogs = [];
const terminalKeyQueues = new Map();

// PaiHuo 的交互式 agent pane 使用固定画布，避免浏览器宽度变化后重放 TUI
// 控制序列时把光标、分隔线和输入区重新换行。该尺寸与执行器创建的 tmux
// window 保持一致；窄屏通过横向滚动查看，不压缩或破坏终端坐标。
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

function terminalOptions(interactive = false, running = false) {
  return {
    ...(interactive ? { cols: INTERACTIVE_TERM_COLS, rows: INTERACTIVE_TERM_ROWS } : {}),
    fontFamily: "var(--font-mono)",
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

function writeTerminalLogs(target, logs, emptyMessage = "（暂无输出）") {
  if (!target) return;
  if (!logs.length) {
    target.write(`\x1b[90m${emptyMessage}\x1b[0m\r\n`);
    return;
  }
  logs.forEach((l, index) => {
    target.write(String(l.content ?? "") + "\r\n", index === logs.length - 1
      ? () => target.scrollToBottom()
      : undefined);
  });
}

function syncFullscreenTerminalGeometry() {
  if (!term) return;
  const host = document.getElementById("termX");
  if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
  try {
    if (termInteractive) term.resize(INTERACTIVE_TERM_COLS, INTERACTIVE_TERM_ROWS);
    else termFit?.fit();
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

export function termWrite(content) {
  if (term) term.write(String(content ?? "") + "\r\n");
}

export function termAppendLog(l) {
  if (state.termTask !== l.task_id || !term) return;
  if (termLogs.some(existing => existing.id === l.id)) return;
  termLogs.push(l);
  termWrite(l.content);
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
    const older = page.logs.filter(l => !existing.has(l.id));
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
  document.getElementById("termTitle").textContent = `${t.agent_name || ""} · #${id} 对话`;
  document.getElementById("termModal")?.classList.toggle("interactive-terminal-modal", termInteractive);
  document.getElementById("termX")?.classList.toggle("interactive-term-body", termInteractive);
  openModal("termModal");
  initTerm();
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
    const byID = new Map(page.logs.map(l => [l.id, l]));
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
  configureTerminalInput(term, false);
  state.termTask = null; // 停止向已关闭的弹窗追加日志
  termLogs = [];
  termHasMore = false;
  termOldestSeq = 0;
  const bar = document.getElementById("termInputBar");
  if (bar) bar.classList.add("hidden");
  closeModal("termModal");
  document.getElementById("termModal")?.classList.remove("interactive-terminal-modal");
  document.getElementById("termX")?.classList.remove("interactive-term-body");
  termInteractive = false;
}

// 详情页中的交互式任务不能按普通日志逐行排版。TUI 输出的是带光标移动、
// 擦除和同步刷新指令的 80×24 TUI；用第二个只读 xterm 按原始尺寸重放，
// 才能得到与 tmux pane 一致的画面。
export function closeTaskTerminal() {
  if (taskTerm) {
    try { taskTerm.dispose(); } catch (_) {}
  }
  taskTerm = null;
  taskTermTask = null;
  taskTermLogs = [];
}

export function openTaskTerminal(id, logs = [], running = false) {
  const host = document.getElementById("taskTermX");
  if (!host) return;
  closeTaskTerminal();
  taskTermTask = id;
  taskTermLogs = [...logs];
  taskTerm = new Terminal(terminalOptions(true, running));
  taskTerm.open(host);
  taskTerm.resize(INTERACTIVE_TERM_COLS, INTERACTIVE_TERM_ROWS);
  taskTerm.onData(keys => queueTerminalKeystrokes(id, keys));
  configureTerminalInput(taskTerm, running);
  writeTerminalLogs(taskTerm, taskTermLogs, "（交互终端等待输出）");
}

export function focusTaskTerminal() {
  taskTerm?.focus();
}

export function taskTermAppendLog(l) {
  if (!taskTerm || taskTermTask !== l.task_id) return;
  if (taskTermLogs.some(existing => existing.id === l.id)) return;
  taskTermLogs.push(l);
  taskTerm.write(String(l.content ?? "") + "\r\n", () => taskTerm?.scrollToBottom());
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
// 原始按键，任务退出后立即收起提示栏并把终端切回只读。
export function syncTerminalInput(t) {
  const bar = document.getElementById("termInputBar");
  const enabled = t?.run_mode === "interactive" && t?.status === "running";
  bar?.classList.toggle("hidden", !enabled);
  configureTerminalInput(term, enabled);
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
