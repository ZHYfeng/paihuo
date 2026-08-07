// 模块 core（由 scripts/gen-globals.py 维护导入/导出）
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
  logsTask: null,
  logsHasMore: false,
  logsLoading: false,
  logsOldestSeq: 0,
  logsTotal: 0,
  termTask: null,
  es: null,        // SSE 连接（隐藏时断开、可见时重连）
  history: [], historySel: new Set(),
  agentEditing: null,
  agentTab: "overview",
  roleStudio: null,  // 唯一角色编辑器的草稿、助手对话与测试对话
  projectView: null, // 项目详情中的项目 id
  projectReorderBusy: false,
  agentView: "grid",
  agentSort: "name-asc",
  skillLib: [],      // 注册到 paihuo 工作目录的技能库 [{id,name,description,tags,dir}]
  skillSelected: new Set(), // Skills 管理页当前勾选的技能 id
  skillDetail: null, // 当前打开的技能详情（含 SKILL.md 内容）
  skillView: "grid", // Skills 管理页显示模式：grid | list
};

export const STATUS_LABEL = {
  queued: "待执行", claimed: "领取中", running: "执行中",
  awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "已取消",
};
export const PERM_LABEL = { full: "自动派发代码合并任务", review: "审批后 Agent 合并" };

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
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  arrowDown: "M12 5v14m6-6-6 6-6-6",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
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

// 日志接口分页返回窗口；兼容旧服务端返回数组，便于前端静态资源与服务端
// 更新短暂错位时仍能显示已有日志。
export async function fetchTaskLogs(id, options = {}) {
  const params = new URLSearchParams();
  if (options.all) params.set("all", "1");
  else {
    params.set("limit", String(options.limit || 200));
    if (options.before) params.set("before", String(options.before));
  }
  const data = await api(`/api/tasks/${id}/logs?${params}`);
  if (Array.isArray(data)) return { logs: data, has_more: false, total: data.length };
  return {
    logs: Array.isArray(data?.logs) ? data.logs : [],
    has_more: Boolean(data?.has_more),
    total: Number(data?.total) || 0,
  };
}

export function activeModal() {
  const modals = document.querySelectorAll(".modal:not(.hidden)");
  return modals.length ? modals[modals.length - 1] : null;
}

function syncModalLayer() {
  const main = document.querySelector(".main");
  if (!main) return;
  // 页面内声明的弹窗位于 .main 的 isolation stacking context 中；提升
  // 这个上下文后，弹窗才能盖住桌面端侧栏，但不会影响全局弹窗的层级。
  main.classList.toggle("modal-layer", Boolean(main.querySelector(".modal:not(.hidden)")));
}

export function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  const previous = activeModal();
  if (previous && previous !== modal) {
    previous.setAttribute("aria-hidden", "true");
    previous.removeAttribute("aria-modal");
  }
  modal._returnFocus = document.activeElement;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-hidden", "false");
  const label = modal.querySelector("[data-modal-title], h1, h2, h3, .t-title");
  if (label) {
    if (!label.id) label.id = `${id}Label`;
    modal.setAttribute("aria-labelledby", label.id);
  }
  modal.classList.remove("hidden");
  syncModalLayer();
  const target = modal.querySelector("[data-autofocus], [autofocus]") ||
    modal.querySelector("input:not([type='hidden']), textarea, select, button, [href], [tabindex]:not([tabindex='-1'])");
  target?.focus({ preventScroll: true });
}

export function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add("hidden");
  syncModalLayer();
  modal.setAttribute("aria-hidden", "true");
  modal.removeAttribute("aria-modal");
  const previous = activeModal();
  if (previous) {
    previous.setAttribute("aria-hidden", "false");
    previous.setAttribute("aria-modal", "true");
  }
  const trigger = modal._returnFocus;
  modal._returnFocus = null;
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}

export async function logout() {
  try { await fetch("/logout", { method: "POST" }); } catch (_) {}
  location.href = "/login";
}

/* ============================================================
   数据加载
   ============================================================ */
