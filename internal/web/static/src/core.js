// 模块 core（由 scripts/split-frontend.py 生成）
import { agentTab } from "./agents.js";

export const state = {
  tasks: [], agents: [], schedules: [], templates: [], projects: [],
  schema: {},        // cli -> {id, name, docs, fields}
  overview: null,    // 总览统计
  agentStats: {},    // agentId -> stats
  projectStats: {},  // projectId -> stats
  view: "board",
  selected: null,
  logs: [],
  termTask: null,
  es: null,        // SSE 连接（隐藏时断开、可见时重连）
  history: [], historySel: new Set(),
  agentEditing: null,
  agentTab: "overview",
  agentModalRC: {},  // 新建/编辑弹窗中的临时 role_config
  projectView: null, // 项目详情中的项目 id
  agentView: "grid",
  skillLib: [],      // 注册到 paihuo 工作目录的技能库 [{id,name,description,dir}]
};

export const STATUS_LABEL = {
  queued: "待执行", claimed: "领取中", running: "执行中",
  awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "已取消",
};
export const PERM_LABEL = { full: "完整", review: "完成后审批" };

export const ST_COLOR = {
  queued: "var(--st-queued)", claimed: "var(--st-claimed)", running: "var(--st-running)",
  awaiting_review: "var(--st-review)", succeeded: "var(--st-done)",
  failed: "var(--st-failed)", cancelled: "var(--st-cancel)",
};
export const BOARD_COLS = [
  ["queue", "排队", ["queued", "claimed"]],
  ["running", "执行中", ["running"]],
  ["awaiting_review", "待审批", ["awaiting_review"]],
];
export const BUILTIN_KEYS = ["model", "system_prompt", "instructions", "thinking", "skills", "plugins", "extra_args", "env"];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- 图标库（Phosphor 风格线性 SVG，stroke 由 CSS 统一） ---- */
export const ICONS = {
  plus: "M12 5v14M5 12h14",
  back: "M19 12H5M12 19l-7-7 7-7",
  retry: "M16 8H5M9 12l-4-4 4-4M5 8v5a9 9 0 0 0 14 5",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6",
  copy: "M9 9h12v12H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  expand: "M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  robot: "M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Zm5-2V6a3 3 0 0 1 6 0v2M9 15h.01M15 15h.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 3",
  bookmark: "M6 3h12v18l-6-4-6 4V3Z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
  board: "M3 3h7v8H3zM14 3h7v5h-7zM14 11h7v10h-7zM3 14h7v7H3z",
  calendar: "M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  zap: "M13 2 3 14h7l-1 8 10-12h-7l1-8Z",
  sparkle: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3Z",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 3",
  terminal: "M4 17l6-5-6-5m8 10h8",
  chevL: "M15 18l-6-6 6-6",
  alert: "M12 3 2.5 20h19L12 3Zm0 7v5m0 3.5v.5",
};
export function icon(name, cls) {
  return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ""}"/></svg>`;
}

/* ---- 字段控件：datalist 唯一 id（同页可能同时存在弹窗与配置 tab 两套表单） ---- */
export function fmtPct(x) { return (Math.round(x * 10) / 10) + "%"; }

export function fmtNum(x) { return Math.round(x * 10) / 10; }

export function fmtDur(sec) {
  if (!sec || sec <= 0) return "-";
  if (sec < 60) return Math.round(sec) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return (Math.round(sec / 360) / 10) + "h";
}

export function toast(msg, isErr) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerHTML = `${icon(isErr ? "alert" : "check")}<span>${esc(msg)}</span>`;
  t.className = "toast" + (isErr ? " error" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export function openModal(id) { document.getElementById(id).classList.remove("hidden"); }

export function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

export async function logout() {
  try { await fetch("/logout", { method: "POST" }); } catch (_) {}
  location.href = "/login";
}

/* ============================================================
   数据加载
   ============================================================ */
