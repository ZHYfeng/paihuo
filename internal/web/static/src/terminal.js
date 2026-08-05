// 模块 terminal（由 scripts/split-frontend.py 生成）
import { api, closeModal, openModal, state } from "./core.js";

export let term = null, termFit = null;

export function initTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    lineHeight: 1.35,
    convertEol: true,
    scrollback: 10000,
    cursorBlink: true,
    theme: {
      background: "#060a13", foreground: "#c9d4e5", cursor: "#38bdf8",
      selectionBackground: "rgba(56, 189, 248, .3)",
      black: "#0b1019", red: "#f87171", green: "#34d399", yellow: "#fbbf24",
      blue: "#38bdf8", magenta: "#a78bfa", cyan: "#22d3ee", white: "#c9d4e5",
      brightBlack: "#5d6b84", brightRed: "#fca5a5", brightGreen: "#6ee7b7",
      brightYellow: "#fde047", brightBlue: "#7dd3fc", brightMagenta: "#c4b5fd",
      brightCyan: "#67e8f9", brightWhite: "#f1f5f9",
    },
  });
  termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open(document.getElementById("termX"));
  termFit.fit();
  window.addEventListener("resize", () => { try { termFit.fit(); } catch (_) {} });
}

export function termWrite(content) {
  if (term) term.write(String(content ?? "") + "\r\n");
}

export function openTerminal(id) {
  const t = state.tasks.find(x => x.id === id) || {};
  document.getElementById("termTitle").textContent = `${t.agent_name || ""} · #${id} 对话`;
  openModal("termModal");
  initTerm();
  setTimeout(() => { try { termFit.fit(); } catch (_) {} }, 30);
  term.clear();
  term.write("\x1b[90m# loading logs...\x1b[0m\r\n");
  state.termTask = id;
  api(`/api/tasks/${id}/logs`).then(logs => {
    if (state.termTask !== id) return;
    term.clear();
    logs.forEach(l => termWrite(l.content));
    if (!logs.length) term.write("\x1b[90m（暂无输出）\x1b[0m\r\n");
  }).catch(() => { term.write("\x1b[31m日志加载失败\x1b[0m\r\n"); });
}

export function closeTerminal() {
  state.termTask = null; // 停止向已关闭的弹窗追加日志
  closeModal("termModal");
}

/* ============================================================
   任务创建 / 模板
   ============================================================ */
