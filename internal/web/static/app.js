/* ============================================================
   派活 PaiHuo — 前端逻辑
   布局高度复刻 multica：侧边栏分组 + 页头面包屑 + 统计条 + 看板/列表
   两个维度：
     1) 多 agent 多高度自定义角色（schema 驱动，每个 CLI 按官方文档
        声明自己的配置字段，前端按 schema 渲染深度定制表单）
     2) 任务管理（项目进度 + 在项目上工作的 agent 统计）
   ============================================================ */

const state = {
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

const STATUS_LABEL = {
  queued: "待执行", claimed: "领取中", running: "执行中",
  awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "已取消",
};
const PERM_LABEL = { full: "完整", review: "完成后审批" };
const ST_COLOR = {
  queued: "var(--st-queued)", claimed: "var(--st-claimed)", running: "var(--st-running)",
  awaiting_review: "var(--st-review)", succeeded: "var(--st-done)",
  failed: "var(--st-failed)", cancelled: "var(--st-cancel)",
};
const BOARD_COLS = [
  ["queue", "排队", ["queued", "claimed"]],
  ["running", "执行中", ["running"]],
  ["awaiting_review", "待审批", ["awaiting_review"]],
];
const BUILTIN_KEYS = ["model", "system_prompt", "instructions", "thinking", "skills", "plugins", "extra_args", "env"];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- 图标库（Phosphor 风格线性 SVG，stroke 由 CSS 统一） ---- */
const ICONS = {
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
function icon(name, cls) {
  return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ""}"/></svg>`;
}

/* ---- 字段控件：datalist 唯一 id（同页可能同时存在弹窗与配置 tab 两套表单） ---- */
let dlSeq = 0;

function fmtPct(x) { return (Math.round(x * 10) / 10) + "%"; }
function fmtNum(x) { return Math.round(x * 10) / 10; }

function fmtDur(sec) {
  if (!sec || sec <= 0) return "-";
  if (sec < 60) return Math.round(sec) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return (Math.round(sec / 360) / 10) + "h";
}

function toast(msg, isErr) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerHTML = `${icon(isErr ? "alert" : "check")}<span>${esc(msg)}</span>`;
  t.className = "toast" + (isErr ? " error" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
}

async function api(path, opts = {}) {
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

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

async function logout() {
  try { await fetch("/logout", { method: "POST" }); } catch (_) {}
  location.href = "/login";
}

/* ============================================================
   数据加载
   ============================================================ */

async function loadAll() {
  const [tasks, agents, schedules, projects] = await Promise.all([
    api("/api/tasks"), api("/api/agents"), api("/api/schedules"), api("/api/projects"),
  ]);
  state.tasks = tasks;
  state.agents = agents;
  state.schedules = schedules;
  state.projects = projects;
  fillSelects();
}

async function loadSchema() {
  try {
    const list = await api("/api/agents/schema");
    state.schema = {};
    list.forEach(s => state.schema[s.id] = s);
    const sel = document.getElementById("aCli");
    if (sel) sel.innerHTML = list.map(s =>
      `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    if (sel && !sel.value) sel.value = list.length ? list[0].id : "";
  } catch (_) {}
}

function fillSelects() {
  const opts = a => a.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  const enOpts = state.agents.filter(a => a.enabled);
  for (const id of ["tAgent", "sAgent"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = (id === "tAgent" ? `<option value="">不指派</option>` : "") + opts(enOpts);
  }
  for (const id of ["fAgent", "hAgent", "cleanupAgent"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<option value="">全部角色</option>` + opts(state.agents);
  }
  const pOpts = state.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  for (const id of ["fProject", "tProject"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = (id === "tProject" ? `<option value="">无项目</option>` : `<option value="">全部项目</option>`) + pOpts;
  }
  const cnt = document.getElementById("sbBoardCount");
  if (cnt) cnt.textContent = state.tasks.filter(t =>
    ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
  const pc = document.getElementById("sbProjectCount");
  if (pc) pc.textContent = state.projects.filter(p => p.status === "active").length || "";
}

/* ============================================================
   统计条（看板页顶部）
   ============================================================ */

async function refreshOverview() {
  try { state.overview = await api("/api/stats/overview"); } catch (_) { return; }
  renderStatsStrip();
}

function renderStatsStrip() {
  const el = document.getElementById("dashStats");
  if (!el) return;
  const o = state.overview;
  if (!o) { el.innerHTML = ""; return; }
  const counts = o.status_counts || [];
  const review = counts.find(s => s.status === "awaiting_review");
  const today = o.daily && o.daily.length ? o.daily[o.daily.length - 1] : null;
  const chips = [
    ["进行中", o.in_flight || 0, "var(--st-running)"],
    ["待审批", review ? review.count : 0, "var(--st-review)"],
    ["今日完成", today ? today.count : 0, "var(--st-done)"],
    ["完成率", fmtPct(o.success_rate), "var(--st-done)"],
    ["平均耗时", fmtDur(o.avg_duration), "var(--fg-muted)"],
    ["项目", o.projects || 0, "var(--fg-muted)"],
  ];
  el.innerHTML = chips.map(c => `<div class="stat-chip">
    <span class="sc-dot" style="background:${c[2]}"></span>
    <b>${c[1]}</b><span>${c[0]}</span></div>`).join("");
}

/* ============================================================
   看板页：board / list 视图
   ============================================================ */

function currentFilters() {
  return {
    agent: Number(document.getElementById("fAgent")?.value) || null,
    project: Number(document.getElementById("fProject")?.value) || null,
    status: document.getElementById("fStatus")?.value || "",
  };
}

function filteredTasks() {
  const f = currentFilters();
  return state.tasks.filter(t => {
    if (f.agent && t.agent_id !== f.agent) return false;
    if (f.project && t.project_id !== f.project) return false;
    if (f.status && t.status !== f.status) return false;
    return true;
  });
}

function renderBoard() {
  const el = document.getElementById("boardView");
  if (!el) return;
  const tasks = filteredTasks();
  el.innerHTML = BOARD_COLS.map(([key, label, statuses]) => {
    const items = tasks.filter(t => statuses.includes(t.status));
    return `<div class="board-col" style="--st-color:${ST_COLOR[statuses[0]]}">
      <div class="board-col-head">
        <span class="st-dot"></span><span>${label}</span>
        <span class="count">${items.length}</span>
      </div>
      <div class="board-col-body">
        ${items.map(cardHTML).join("") || `<div class="empty">—</div>`}
      </div>
    </div>`;
  }).join("");
  const c = document.getElementById("viewCount");
  if (c) c.textContent = `${tasks.length} 个任务`;
}

function cardHTML(t) {
  return `<div class="card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span>#${t.id}</span>
      <span>${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">审批</span>` : ""}
      ${t.review_rounds > 0 ? `<span class="chip">第${t.review_rounds}轮</span>` : ""}
    </div>
    <div class="c-title">${esc(t.title)}</div>
    ${t.body ? `<div class="c-desc">${esc(t.body)}</div>` : ""}
    <div class="c-meta">
      ${t.project_name ? `<span class="chip">${esc(t.project_name)}</span>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">未指派</span>`}
        ${t.error ? `<span style="color:var(--danger)">✗</span>` : ""}
      </span>
    </div>
  </div>`;
}

function renderList() {
  const el = document.getElementById("listBody");
  if (!el) return;
  const tasks = filteredTasks();
  el.innerHTML = tasks.map(t => `
    <tr onclick="openTask(${t.id})">
      <td class="num">#${t.id}</td>
      <td class="t-title">${esc(t.title)}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${esc(t.project_name || "-")}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="event.stopPropagation();openTerminal(${t.id})">${icon("terminal")}对话</button>
          ${["succeeded", "failed", "cancelled"].includes(t.status)
            ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}重试</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("listEmpty");
  if (empty) empty.classList.toggle("hidden", tasks.length > 0);
  const c = document.getElementById("viewCount");
  if (c) c.textContent = `${tasks.length} 个任务`;
}

function setView(v) {
  state.view = v;
  document.getElementById("segBoard").classList.toggle("active", v === "board");
  document.getElementById("segList").classList.toggle("active", v === "list");
  document.getElementById("boardView").classList.toggle("hidden", v !== "board");
  document.getElementById("listView").classList.toggle("hidden", v !== "list");
  if (v === "list") renderList(); else renderBoard();
}

function applyFilters() { state.view === "list" ? renderList() : renderBoard(); }

/* ============================================================
   任务详情（两栏）
   ============================================================ */

function openTask(id) { location.hash = "#/issue/" + id; }

function closeDetail() {
  state.selected = null;
  location.hash = "#/";
}

function showDetail(id) {
  state.selected = id;
  const shell = document.getElementById("boardShell") || document.getElementById("dashShell");
  if (shell) shell.classList.add("hidden");
  document.getElementById("detailShell").classList.remove("hidden");
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    document.getElementById("dCrumb").innerHTML = `任务 / <b>#${t.id}</b>`;
    document.getElementById("dBadge").innerHTML =
      `<span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>`;
  }
  refreshDetail();
}

function hideDetail() {
  document.getElementById("detailShell").classList.add("hidden");
  const shell = document.getElementById("boardShell") || document.getElementById("dashShell");
  if (shell) shell.classList.remove("hidden");
  state.selected = null;
}

async function refreshDetail() {
  if (!state.selected) return;
  try {
    const [task, logs] = await Promise.all([
      api(`/api/tasks/${state.selected}`), api(`/api/tasks/${state.selected}/logs`),
    ]);
    const i = state.tasks.findIndex(x => x.id === task.id);
    if (i >= 0) state.tasks[i] = task; else state.tasks.unshift(task);
    state.logs = logs;
    renderDetail(task);
  } catch (_) { /* 任务已删除 */ }
}

function renderDetail(t) {
  const main = document.getElementById("dMain");
  if (!main) return;
  main.innerHTML = `
    <h2>${esc(t.title)}</h2>
    <div class="detail-id">#${t.id} · 创建于 ${esc((t.created_at || "").slice(0, 16).replace("T", " "))}
      ${t.resume_of ? ` · <span style="color:var(--brand)">续跑自 #${t.resume_of}</span>` : ""}</div>
    ${t.body ? `<div class="detail-desc">${esc(t.body)}</div>` : ""}
    ${t.error ? `<div class="detail-desc" style="border-color:rgba(255,99,105,.4);color:var(--danger)">错误：${esc(t.error)}</div>` : ""}
    <div id="childrenBox"></div>
    ${t.status === "awaiting_review" ? `<div id="diffBox"><div class="empty">加载改动中...</div></div>` : ""}
    <div class="sec-title">工作空间</div>
    <div id="wsBox"><div class="empty">加载中...</div></div>
    <div class="term">
      <div class="term-head">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="t-title">${esc(t.agent_name || "未指派")} · 对话 · ${esc(t.project_dir || "")}</span>
        <button class="btn ghost xs" onclick="copyLogs()">${icon("copy")}复制</button>
        <button class="btn ghost xs" onclick="openTerminal(${t.id})">${icon("expand")}全屏</button>
      </div>
      <div class="term-body" id="logBox">${logsHTML()}</div>
    </div>`;
  const box = document.getElementById("logBox");
  if (box) box.scrollTop = box.scrollHeight;
  if (t.status === "awaiting_review") loadDiff(t.id);
  loadChildren(t.id);
  loadWorkspace(t.id);
  renderSide(t);
}

/* ---- 工作空间（git worktree 隔离） ---- */

async function loadWorkspace(id) {
  const box = document.getElementById("wsBox");
  if (!box) return;
  try {
    const w = await api(`/api/workspace/${id}`);
    const t = state.tasks.find(x => x.id === id) || {};
    const done = ["succeeded", "failed", "cancelled"].includes(t.status);
    if (!w.is_git) {
      box.innerHTML = `<div class="ws-row"><span class="ws-label">隔离</span><span class="ws-val">项目非 git 仓库，任务直接在项目目录执行</span>` +
        `<button class="btn xs" onclick="gitInitProject('${esc(w.path)}', ${id})">git init</button></div>`;
      return;
    }
    if (!w.is_worktree) {
      box.innerHTML = `<div class="ws-row"><span class="ws-label">隔离</span><span class="ws-val">${esc(w.note || "无独立工作空间")}</span></div>`;
      return;
    }
    box.innerHTML = `
      <div class="ws-row"><span class="ws-label">分支</span><span class="ws-val mono">${esc(w.branch)}</span></div>
      <div class="ws-row"><span class="ws-label">HEAD</span><span class="ws-val mono">${esc(w.head || "-")}` +
      (w.dirty ? ` <span class="ws-tag dirty">dirty</span>` : "") +
      (w.ahead > 0 ? ` <span class="ws-tag ahead">+${w.ahead}</span>` : "") +
      `</span></div>
      <div class="ws-row"><span class="ws-label">路径</span><span class="ws-val mono" title="${esc(w.path)}">${esc(w.path)}</span></div>` +
      (done ? `<div class="ws-actions">
        <button class="btn sm brand" onclick="wsMerge(${id})">合并回主分支</button>
        <button class="btn sm danger" onclick="wsDiscard(${id})">丢弃</button>
      </div>` : "");
  } catch (_) { box.innerHTML = `<div class="empty">工作空间信息不可用</div>`; }
}

async function wsMerge(id) {
  if (!confirm(`把任务 #${id} 的改动 squash 合并回主分支？`)) return;
  try {
    const r = await api(`/api/workspace/${id}/merge`, { method: "POST" });
    toast(`已合并${r.commit ? " (" + r.commit + ")" : ""}`);
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

async function wsDiscard(id) {
  if (!confirm(`丢弃任务 #${id} 的工作空间？分支与 worktree 将删除，改动不可恢复。`)) return;
  try {
    await api(`/api/workspace/${id}/discard`, { method: "POST" });
    toast("已丢弃");
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

async function gitInitProject(path, id) {
  if (!confirm(`在 ${path} 初始化 git 仓库？之后的任务将获得独立 worktree。`)) return;
  try {
    await api("/api/workspace/git-init", { method: "POST", body: JSON.stringify({ path }) });
    toast("已初始化");
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

function renderSide(t) {
  const side = document.getElementById("dSide");
  if (!side) return;
  const statusOpts = Object.keys(STATUS_LABEL).map(s =>
    `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
  const pOpts = `<option value="">无项目</option>` + state.projects.map(p =>
    `<option value="${p.id}" ${t.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  let actions = "";
  if (["queued", "claimed", "running"].includes(t.status)) {
    actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}取消任务</button>`;
  }
  if (t.status === "awaiting_review") {
    actions += `<button class="btn sm brand" onclick="setTaskStatus(${t.id},'succeeded')">${icon("check")}审批通过</button>`;
    actions += `<button class="btn sm" onclick="rejectTask(${t.id})">${icon("retry")}驳回重做</button>`;
    actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}取消</button>`;
  }
  if (["succeeded", "failed", "cancelled"].includes(t.status)) {
    actions += `<button class="btn sm" onclick="setTaskStatus(${t.id},'queued')">${icon("retry")}重试</button>`;
    actions += `<button class="btn sm" onclick="resumeTask(${t.id})">${icon("terminal")}继续对话</button>`;
  }
  actions += `<button class="btn sm" onclick="openSubTask(${t.id})">${icon("plus")}拆分子任务</button>`;
  if (t.body) actions += `<button class="btn sm" onclick="saveAsTemplate(${t.id})">${icon("bookmark")}保存为模板</button>`;
  actions += `<button class="btn sm danger" onclick="deleteTask(${t.id})">${icon("trash")}删除任务</button>`;

  side.innerHTML = `
    <div class="sec-title">属性</div>
    <div class="prop-row"><span class="k">状态</span>
      <span class="v"><select onchange="patchTask(${t.id},{status:this.value})">${statusOpts}</select></span></div>
    <div class="prop-row"><span class="k">项目</span>
      <span class="v"><select onchange="patchTask(${t.id},{project_id:this.value||null})">${pOpts}</select></span></div>
    <div class="prop-row"><span class="k">角色</span><span class="v">${esc(t.agent_name || "未指派")}</span></div>
    <div class="prop-row"><span class="k">权限</span><span class="v">${PERM_LABEL[t.perm] || t.perm}</span></div>
    <div class="prop-row"><span class="k">目录</span><span class="v" style="font-size:12px;word-break:break-all">${esc(t.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">轮次</span><span class="v">${t.review_rounds || "-"}</span></div>
    <div class="prop-row"><span class="k">开始</span><span class="v">${esc((t.started_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="prop-row"><span class="k">结束</span><span class="v">${esc((t.finished_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">操作</div>
    <div class="detail-actions">${actions}</div>`;
}

async function patchTask(id, set) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(set) });
    toast("已更新");
  } catch (e) { toast(e.message, true); }
}

async function setTaskStatus(id, status) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (status === "queued" && location.pathname === "/history") { location.href = "/"; return; }
    await loadAll();
    const p = location.pathname;
    if (p === "/" || p === "/board") {
      if (state.selected === id && location.hash.startsWith("#/issue/")) showDetail(id);
      if (p === "/") loadDashboard();
    } else if (p === "/history") {
      loadHistory();
    } else if (p === "/projects" && state.projectView) {
      refreshProjectDetail();
    }
  } catch (e) { toast(e.message, true); }
}

async function rejectTask(id) {
  const note = prompt("驳回原因 / 修改意见（将追加到任务提示词，重新执行）");
  if (note === null) return;
  try {
    await api(`/api/tasks/${id}`, {
      method: "PATCH", body: JSON.stringify({ status: "queued", review_note: note }),
    });
    toast("已驳回，任务重新执行");
    await loadAll();
    showDetail(id);
  } catch (e) { toast(e.message, true); }
}

async function deleteTask(id) {
  if (!confirm(`删除任务 #${id}？执行日志将一并删除。`)) return;
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast("已删除");
    await loadAll();
    const p = location.pathname;
    if (state.selected === id) { closeDetail(); location.hash = "#/"; }
    if (p === "/history") loadHistory();
    if (p === "/projects" && state.projectView) refreshProjectDetail();
    if (p === "/") loadDashboard();
    if (p === "/board") { renderBoard(); renderList(); }
  } catch (e) { toast(e.message, true); }
}

/* 子任务 */
async function loadChildren(id) {
  try {
    const kids = await api(`/api/tasks/${id}/children`);
    const box = document.getElementById("childrenBox");
    if (!box || !kids.length) return;
    const done = kids.filter(k => ["succeeded", "failed", "cancelled"].includes(k.status)).length;
    box.innerHTML = `<div class="sec-title">子任务 ${done}/${kids.length}</div>` +
      kids.map(k => `<div class="card" style="padding:8px 10px;margin-bottom:6px" onclick="openTask(${k.id})">
        <div class="c-title">#${k.id} ${esc(k.title)}</div>
        <div class="c-meta"><span class="badge ${k.status}" style="--st-color:${ST_COLOR[k.status]}"><span class="st-dot"></span>${STATUS_LABEL[k.status]}</span>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(k.agent_name || "")}</span></div>
      </div>`).join("");
  } catch (_) {}
}

function openSubTask(parentId) {
  fillSelects();
  const t = state.tasks.find(x => x.id === parentId);
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = t ? t.perm : "full";
  document.getElementById("tProject").value = t && t.project_id ? t.project_id : "";
  document.getElementById("tParentId").value = parentId;
  document.getElementById("taskModalTitle").textContent = "拆分子任务";
  openModal("taskModal");
}

/* ---- 续跑：attach 回上次对话 ---- */

async function resumeTask(id) {
  if (!confirm(`续跑任务 #${id}？将创建新任务并复用原会话继续对话（pi/omp 真实续对话，其他 CLI 为全新会话）。`)) return;
  try {
    const t = await api(`/api/tasks/${id}/resume`, { method: "POST" });
    toast(`已创建续跑任务 #${t.id}`);
    await loadAll();
    location.hash = "#/issue/" + t.id;
  } catch (e) { toast(e.message, true); }
}

/* diff */
async function loadDiff(id) {
  try {
    const d = await api(`/api/tasks/${id}/diff`);
    const box = document.getElementById("diffBox");
    if (!box) return;
    const stat = d.stat.trim();
    const diff = d.diff.trim();
    if (!stat && !diff) {
      box.innerHTML = `<div class="detail-desc">无文件改动或非 git 仓库${d.note ? "（" + esc(d.note) + "）" : ""}</div>`;
      return;
    }
    box.innerHTML = `<div class="detail-desc" style="color:var(--success)">文件改动（git diff）${d.branch ? ` · 分支 <code class="mono">${esc(d.branch)}</code>` : ""}：</div>
      <div class="term"><div class="term-body" style="max-height:180px">${esc(stat)}</div></div>
      ${diff ? `<div class="term"><div class="term-body" style="max-height:300px">${esc(diff).split("\n").map(l =>
        `<div class="line"><span class="c ${l.startsWith("+") && !l.startsWith("+++") ? "out" : l.startsWith("-") && !l.startsWith("---") ? "err" : "sys"}">${esc(l)}</span></div>`).join("")}</div></div>` : ""}`;
  } catch (_) {}
}

/* 终端对话 */
function tsOf(l) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(l.created_at || "");
  return m ? m[1] : "";
}

function logLineHTML(l) {
  return `<div class="line"><span class="ts">${tsOf(l)}</span><span class="c ${l.stream}">${esc(l.content)}</span></div>`;
}

function logsHTML() {
  return state.logs.map(logLineHTML).join("");
}

function appendLog(l) {
  if (state.selected === l.task_id) {
    state.logs.push(l);
    const box = document.getElementById("logBox");
    if (box) {
      box.insertAdjacentHTML("beforeend", logLineHTML(l));
      box.scrollTop = box.scrollHeight;
    }
  }
  if (state.termTask === l.task_id) {
    if (term) termWrite(l.content);
  }
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(state.logs.map(l => l.content).join("\n"));
    toast("已复制对话内容");
  } catch (_) { toast("复制失败", true); }
}

/* ---- 全屏终端（xterm.js 渲染：ANSI 颜色 / 真实终端感） ---- */
let term = null, termFit = null;

function initTerm() {
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

function termWrite(content) {
  if (term) term.write(String(content ?? "") + "\r\n");
}

function openTerminal(id) {
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

function closeTerminal() {
  state.termTask = null; // 停止向已关闭的弹窗追加日志
  closeModal("termModal");
}

/* ============================================================
   任务创建 / 模板
   ============================================================ */

function openNewTask() {
  fillSelects();
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = "full";
  document.getElementById("tProject").value = "";
  document.getElementById("tParentId").value = "";
  document.getElementById("taskModalTitle").textContent = "新建任务";
  openModal("taskModal");
}

async function submitTask() {
  const title = document.getElementById("tTitle").value.trim();
  if (!title) return toast("标题不能为空", true);
  const parentId = Number(document.getElementById("tParentId").value) || null;
  const projectId = Number(document.getElementById("tProject").value) || null;
  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: document.getElementById("tBody").value,
        agent_id: Number(document.getElementById("tAgent").value) || null,
        project_id: projectId,
        perm: document.getElementById("tPerm").value,
        parent_id: parentId,
      }),
    });
    closeModal("taskModal");
    toast("任务已创建");
    await loadAll();
    renderBoard(); renderList();
    refreshOverview();
  } catch (e) { toast(e.message, true); }
}

function applyTemplate() {
  const t = state.templates.find(x => x.id === Number(document.getElementById("tTemplate").value));
  if (!t) return;
  document.getElementById("tBody").value = t.body || "";
  if (t.agent_id) document.getElementById("tAgent").value = t.agent_id;
}

async function saveAsTemplate(taskId) {
  // 列表接口的 body 是截断版（省载荷），模板必须用完整提示词
  let t;
  try { t = await api(`/api/tasks/${taskId}`); } catch (_) { return; }
  const name = prompt("模板名称（用于复用该任务的提示词）", t.title);
  if (!name) return;
  try {
    await api("/api/templates", { method: "POST", body: JSON.stringify({ name, body: t.body, agent_id: t.agent_id }) });
    toast("已保存为模板");
    loadTemplates();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   历史页
   ============================================================ */

function loadHistory() {
  const agentId = document.getElementById("hAgent").value;
  const status = document.getElementById("hStatus").value;
  const days = Number(document.getElementById("hDays").value) || 0;
  state.history = state.tasks.filter(t => {
    if (agentId && t.agent_id !== Number(agentId)) return false;
    if (status && t.status !== status) return false;
    if (days > 0) {
      const end = t.finished_at || t.created_at;
      if (!end || Date.now() - new Date(end).getTime() > days * 86400000) return false;
    }
    return true;
  });
  state.historySel.clear();
  renderHistory();
}

function renderHistory() {
  const body = document.getElementById("historyBody");
  if (!body) return;
  body.innerHTML = state.history.map(t => `
    <tr data-id="${t.id}" class="${state.historySel.has(t.id) ? "selected" : ""}" onclick="toggleRow(this)">
      <td class="chk"><input type="checkbox" ${state.historySel.has(t.id) ? "checked" : ""} onclick="event.stopPropagation()"></td>
      <td class="num">#${t.id}</td>
      <td class="t-title"><span class="t-link" onclick="event.stopPropagation();openTerminal(${t.id})">${esc(t.title)}</span></td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${esc(t.project_name || "-")}</td>
      <td>${PERM_LABEL[t.perm] || t.perm}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          ${["succeeded", "failed", "cancelled"].includes(t.status)
            ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}重试</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("historyEmpty");
  if (empty) empty.classList.toggle("hidden", state.history.length > 0);
  const cnt = document.getElementById("hSelCount");
  if (cnt) cnt.textContent = state.historySel.size;
}

function toggleRow(tr) {
  const id = Number(tr.dataset.id);
  if (state.historySel.has(id)) state.historySel.delete(id); else state.historySel.add(id);
  tr.classList.toggle("selected", state.historySel.has(id));
  const cb = tr.querySelector("input[type=checkbox]");
  if (cb) cb.checked = state.historySel.has(id);
  const cnt = document.getElementById("hSelCount");
  if (cnt) cnt.textContent = state.historySel.size;
}

function toggleAll() {
  const all = document.getElementById("hCheckAll").checked;
  state.historySel.clear();
  if (all) state.history.forEach(t => state.historySel.add(t.id));
  renderHistory();
}

async function deleteSelected() {
  const ids = [...state.historySel];
  if (!ids.length) return toast("先勾选要删除的任务", true);
  if (!confirm(`删除选中的 ${ids.length} 条任务？不可恢复。`)) return;
  try {
    for (const id of ids) await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast(`已删除 ${ids.length} 条`);
    await loadAll();
    loadHistory();
  } catch (e) { toast(e.message, true); }
}

async function cleanupHistory() {
  const agentId = Number(document.getElementById("hAgent").value) || null;
  const days = Number(document.getElementById("hDays").value) || 0;
  const before = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : "";
  if (!confirm(`删除${agentId ? "该角色" : "全部角色"}${before ? "、" + days + " 天前" : ""}的终态任务？不可恢复！`)) return;
  try {
    const r = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
    toast(`已删除 ${r.deleted} 条历史`);
    await loadAll();
    loadHistory();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   项目页（维度二：任务管理）
   ============================================================ */

function renderProjectList() {
  const grid = document.getElementById("projectGrid");
  if (!grid) return;
  const q = (document.getElementById("pSearch")?.value || "").trim().toLowerCase();
  const list = state.projects.filter(p => !q || p.name.toLowerCase().includes(q));
  grid.innerHTML = list.map(p => {
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const done = ts.filter(t => t.status === "succeeded").length;
    const pct = ts.length ? done / ts.length * 100 : 0;
    const agents = new Set(ts.map(t => t.agent_name).filter(Boolean));
    return `<div class="project-card" onclick="openProject(${p.id})">
      <div class="pc-top">
        <b>${esc(p.name)}</b>
        ${p.is_git ? `<span class="chip git-chip" title="git 仓库，任务将获得独立 worktree">git</span>` : `<span class="chip" title="非 git 仓库，任务直接在项目目录执行">非 git</span>`}
        <span class="badge ${p.status === "active" ? "running" : "cancelled"}">${p.status === "active" ? "进行中" : "已归档"}</span>
      </div>
      ${p.description ? `<div class="pc-desc">${esc(p.description)}</div>` : ""}
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${fmtPct(pct)}</span></div>
      <div class="pc-meta">
        ${p.project_dir ? `<span class="pc-dir" title="${esc(p.project_dir)}">${esc(p.project_dir)}</span>` : ""}
        <span>${ts.length} 任务</span>
        <span>${done} 完成</span>
        <span>${agents.size} 角色</span>
        <span class="spacer"></span>
        <span class="pc-date">${(p.updated_at || p.created_at || "").slice(5, 16).replace("T", " ")}</span>
      </div>
    </div>`;
  }).join("");
  const empty = document.getElementById("projectEmpty");
  if (empty) empty.classList.toggle("hidden", list.length > 0);
  const cnt = document.getElementById("projectCount");
  if (cnt) cnt.textContent = `${list.length} 个项目`;
}

function openProject(id) { location.hash = "#/project/" + id; }
function closeProjectDetail() { location.hash = "#/"; }

function showProjectDetail(id) {
  state.projectView = id;
  document.getElementById("projectListShell").classList.add("hidden");
  document.getElementById("projectDetailShell").classList.remove("hidden");
  refreshProjectDetail();
}

function hideProjectDetail() {
  document.getElementById("projectDetailShell").classList.add("hidden");
  document.getElementById("projectListShell").classList.remove("hidden");
  state.projectView = null;
}

async function refreshProjectDetail() {
  if (!state.projectView) return;
  const id = state.projectView;
  const p = state.projects.find(x => x.id === id);
  if (!p) return;
  document.getElementById("pdCrumb").innerHTML = `项目 / <b>${esc(p.name)}</b>`;
  document.getElementById("pdBadge").innerHTML =
    `<span class="badge ${p.status === "active" ? "running" : "cancelled"}">${p.status === "active" ? "进行中" : "已归档"}</span>`;
  try {
    const [stats, tasks] = await Promise.all([
      api(`/api/stats/project/${id}`), api(`/api/tasks?project_id=${id}`),
    ]);
    state.projectStats[id] = stats;
    renderProjectDetail(p, stats, tasks);
  } catch (_) {}
}

function renderProjectDetail(p, s, tasks) {
  const main = document.getElementById("pdMain");
  const side = document.getElementById("pdSide");
  if (!main || !side) return;
  const counts = s.status_counts || [];
  const review = counts.find(c => c.status === "awaiting_review");
  const rowHTML = tasks.map(t => `
    <div class="p-task-row" onclick="openTerminal(${t.id})">
      <span class="num">#${t.id}</span>
      <span class="t">${esc(t.title)}</span>
      <span class="a">${t.agent_name ? `<span class="avatar sm">${esc(t.agent_name.slice(0, 1))}</span>${esc(t.agent_name)}` : "-"}</span>
      <span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>
      <span class="ops">
        ${["succeeded", "failed", "cancelled"].includes(t.status)
          ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}重试</button>` : ""}
        <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}删除</button>
      </span>
    </div>`).join("");

  const agentsHTML = (s.agents || []).map(a => `
    <tr>
      <td class="t-title"><span class="avatar sm">${esc((a.agent_name || "?").slice(0, 1))}</span>
        <a class="t-link" href="/roles#/agent/${a.agent_id}">${esc(a.agent_name || "未指派")}</a></td>
      <td class="num">${a.total}</td>
      <td class="num" style="color:var(--success)">${a.succeeded}</td>
      <td class="num" style="color:var(--danger)">${a.failed}</td>
      <td class="num">${a.reviews || 0}</td>
      <td class="num">${fmtPct(a.success_rate)}</td>
      <td class="num">${fmtDur(a.avg_duration)}</td>
    </tr>`).join("");

  main.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="detail-id">创建于 ${esc((p.created_at || "").slice(0, 16).replace("T", " "))}</div>
    ${p.description ? `<div class="detail-desc">${esc(p.description)}</div>` : ""}

    <div class="pd-stats">
      <div class="pd-ring">${ringHTML(s.progress || 0, "完成度")}</div>
      <div class="pd-chips">
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-running)"></span><b>${s.in_flight || 0}</b><span>进行中</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-review)"></span><b>${review ? review.count : 0}</b><span>待审批</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${s.succeeded}</b><span>完成</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-failed)"></span><b>${s.failed}</b><span>失败</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${s.total}</b><span>总任务</span></div>
      </div>
    </div>

    <div class="sec-title">近 14 天完成</div>
    ${dailyChartHTML(s.daily, 14)}

    <div class="sec-title">任务 ${tasks.length}</div>
    <div class="p-task-list">
      ${rowHTML || `<div class="empty">还没有任务，去看板派活并归入本项目</div>`}
    </div>

    <div class="sec-title">成员统计（在本项目上工作的 agent）</div>
    <div class="list-wrap" style="max-height:340px">
      <table class="list-grid">
        <thead><tr><th>角色</th><th>任务</th><th>完成</th><th>失败</th><th>审批轮次</th><th>成功率</th><th>平均耗时</th></tr></thead>
        <tbody>${agentsHTML || `<tr><td colspan="7"><div class="empty">尚无产出统计</div></td></tr>`}</tbody>
      </table>
    </div>`;

  side.innerHTML = `
    <div class="sec-title">属性</div>
    <div class="prop-row"><span class="k">状态</span>
      <span class="v"><select onchange="patchProject(${p.id},{status:this.value})">
        <option value="active" ${p.status === "active" ? "selected" : ""}>进行中</option>
        <option value="archived" ${p.status === "archived" ? "selected" : ""}>已归档</option>
      </select></span></div>
    <div class="prop-row"><span class="k">工作目录</span><span class="v" style="font-size:12px;word-break:break-all">${esc(p.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">描述</span><span class="v" style="font-size:12px;white-space:pre-wrap">${esc(p.description || "-")}</span></div>
    <div class="prop-row"><span class="k">创建</span><span class="v">${esc((p.created_at || "").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">操作</div>
    <div class="detail-actions">
      <button class="btn sm" onclick="openProjectModal(${p.id})">编辑</button>
      <button class="btn sm danger" onclick="deleteProject(${p.id})">删除</button>
    </div>`;
}

function openProjectModal(id) {
  const p = id ? state.projects.find(x => x.id === id) : null;
  document.getElementById("projectModalTitle").textContent = p ? "编辑项目" : "新建项目";
  document.getElementById("pId").value = p ? p.id : "";
  document.getElementById("pName").value = p ? p.name : "";
  document.getElementById("pDesc").value = p ? (p.description || "") : "";
  document.getElementById("pProjectDir").value = p ? (p.project_dir || "") : "";
  document.getElementById("pStatus").value = p ? (p.status || "active") : "active";
  loadProjDatalist();
  openModal("projectModal");
}

async function submitProject() {
  const id = document.getElementById("pId").value;
  const body = {
    name: document.getElementById("pName").value.trim(),
    description: document.getElementById("pDesc").value.trim(),
    project_dir: document.getElementById("pProjectDir").value.trim(),
    status: document.getElementById("pStatus").value,
  };
  if (!body.name) return toast("项目名不能为空", true);
  try {
    if (id) await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
    closeModal("projectModal");
    await loadAll();
    renderProjectList();
    if (state.projectView) refreshProjectDetail();
  } catch (e) { toast(e.message, true); }
}

async function patchProject(id, set) {
  try {
    await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(set) });
    await loadAll();
    if (state.projectView === id) refreshProjectDetail();
    renderProjectList();
    toast("已更新");
  } catch (e) { toast(e.message, true); }
}

async function deleteProject(id) {
  if (!id) id = state.projectView;
  if (!id) return;
  if (!confirm("删除该项目？项目下的任务将保留（转为无项目），项目统计随之消失。")) return;
  try {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    toast("已删除");
    await loadAll();
    if (state.projectView === id) { closeProjectDetail(); }
    renderProjectList();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   图表组件（纯 CSS，无外部依赖）
   ============================================================ */

function dailyChartHTML(daily, days) {
  days = days || 14;
  const map = {};
  (daily || []).forEach(d => map[d.date] = d.count);
  const vals = Object.values(map);
  const max = Math.max(1, ...vals);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const c = map[key] || 0;
    const today = i === 0;
    out.push(`<div class="bc-col ${today ? "today" : ""}" title="${key}: ${c} 个完成">
      <div class="bc-bar" style="height:${Math.round(c / max * 100)}%;${c === 0 ? "opacity:.22" : ""}"></div>
      <div class="bc-day">${i % 2 === 0 ? key.slice(5) : ""}</div>
    </div>`);
  }
  return `<div class="bar-chart">${out.join("")}</div>`;
}

function ringHTML(pct, label) {
  const deg = Math.round(Math.min(100, pct) * 3.6);
  return `<div class="ring" style="background:conic-gradient(var(--brand) ${deg}deg, rgba(255,255,255,.09) 0)">
    <div class="ring-inner"><b>${fmtPct(pct)}</b><span>${label}</span></div>
  </div>`;
}

function statusBarHTML(counts) {
  const order = ["queued", "claimed", "running", "awaiting_review", "succeeded", "failed", "cancelled"];
  const total = (counts || []).reduce((a, c) => a + c.count, 0);
  if (!total) return `<div class="status-bar"><div class="sb-empty"></div></div>`;
  const segs = [...(counts || [])]
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
    .filter(c => c.count > 0)
    .map(c => `<div class="sb-seg" title="${STATUS_LABEL[c.status]}: ${c.count}" style="width:${c.count / total * 100}%;background:${ST_COLOR[c.status]}"></div>`).join("");
  return `<div class="status-bar">${segs}</div>`;
}

/* ============================================================
   agents 页：列表 + 详情 tab（schema 驱动深度定制）
   ============================================================ */

/* ============================================================
   agents 页：卡片 / 表格双视图 + 列表 + 详情 tab（schema 驱动深度定制）
   ============================================================ */

function setAgentView(v) {
  state.agentView = v;
  const g = document.getElementById("segGrid"), t = document.getElementById("segTable");
  if (g) g.classList.toggle("active", v === "grid");
  if (t) t.classList.toggle("active", v === "table");
  const grid = document.getElementById("agentGrid");
  const wrap = document.getElementById("agentTableWrap");
  if (grid) grid.classList.toggle("hidden", v !== "grid");
  if (wrap) wrap.classList.toggle("hidden", v !== "table");
  try { localStorage.setItem("paihuo.agentView", v); } catch (_) {}
  renderAgentList();
}

function agentTaskStats(a) {
  const ts = state.tasks.filter(t => t.agent_id === a.id);
  return {
    total: ts.length,
    inFlight: ts.filter(t => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length,
    review: ts.filter(t => t.status === "awaiting_review").length,
  };
}

function renderAgentGrid() {
  const grid = document.getElementById("agentGrid");
  if (!grid) return;
  const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
  const list = state.agents.filter(a =>
    !q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q));
  grid.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    const st = agentTaskStats(a);
    return `<div class="agent-card" onclick="openAgentDetail(${a.id})">
      <div class="ac-top">
        <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(a.name)}</div>
          <div class="ac-sub">${esc(a.description || "未设置描述")}</div>
        </div>
        <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span>
      </div>
      <div class="ac-meta">
        <span class="chip">${esc(a.cli)}</span>
        <span class="chip" title="${esc(rc.model || "默认模型")}">${esc(rc.model || "默认模型")}</span>
      </div>
      <div class="ac-stats">
        <span><b>${st.total}</b> 任务</span>
        <span><b style="color:var(--st-running)">${st.inFlight}</b> 进行中</span>
        <span><b style="color:var(--st-review)">${st.review}</b> 待审批</span>
        <span class="ac-ops">
          <button class="btn xs" title="打开详情并切到配置 tab" onclick="event.stopPropagation();agentTabFromCard(${a.id})">配置</button>
          <button class="btn xs" onclick="event.stopPropagation();openAgentModal(${a.id})">编辑</button>
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
        </span>
      </div>
    </div>`;
  }).join("");
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

function renderAgentTable() {
  const body = document.getElementById("agentList");
  if (!body) return;
  const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
  const list = state.agents.filter(a => !q || a.name.toLowerCase().includes(q));
  body.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    return `<tr onclick="openAgentDetail(${a.id})">
      <td><span style="display:flex;align-items:center;gap:8px">
        <span class="avatar av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <b>${esc(a.name)}</b>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(a.description || "")}</span>
      </span></td>
      <td><span class="badge">${esc(a.cli)}</span></td>
      <td>${esc(rc.model || "默认")}</td>
      <td><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteAgent(${a.id})">${icon("trash")}删除</button>
        </span>
      </td>
    </tr>`;
  }).join("");
  const empty = document.getElementById("agentEmpty");
  if (empty) empty.classList.toggle("hidden", list.length > 0);
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

function renderAgentList() {
  state.agentView === "grid" ? renderAgentGrid() : renderAgentTable();
}

async function toggleAgent(id) {
  const a = state.agents.find(x => x.id === id);
  try {
    await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
    await loadAll();
    renderAgentList();
  } catch (e) { toast(e.message, true); }
}

/* ---- 目录选择器 ---- */
const dirState = { inputId: null, path: "" };

async function dirLoad(path) {
  try {
    const d = await api(`/api/fs/dirs?path=${encodeURIComponent(path || "")}`);
    dirState.path = d.path;
    // 面包屑
    const el = document.getElementById("dirCrumb");
    const segs = d.path.split("/").filter(Boolean);
    let html = `<span class="crumb-seg" data-p="/">/</span>`;
    let cur = "";
    segs.forEach((s, i) => {
      cur += "/" + s;
      const last = i === segs.length - 1;
      html += `<span class="crumb-sep">/</span>` +
        `<span class="crumb-seg${last ? " cur" : ""}" data-p="${esc(cur)}">${esc(s)}</span>`;
    });
    el.innerHTML = html;
    // 目录列表
    const list = document.getElementById("dirList");
    list.innerHTML = "";
    if (d.parent !== d.path) {
      const up = document.createElement("div");
      up.className = "dir-row up";
      up.dataset.path = d.parent;
      up.innerHTML = icon("back") + `<span>上一级</span>`;
      list.appendChild(up);
    }
    d.dirs.forEach(n => {
      const row = document.createElement("div");
      row.className = "dir-row";
      row.dataset.path = d.path.replace(/\/+$/, "") + "/" + n;
      row.innerHTML = icon("folder") + `<span class="dr-name">${esc(n)}</span>`;
      list.appendChild(row);
    });
    if (!d.dirs.length) list.innerHTML = `<div class="empty">空目录</div>`;
  } catch (e) { toast(e.message, true); }
}

function openDirPicker(inputId) {
  dirState.inputId = inputId;
  const cur = (document.getElementById(inputId).value || "").trim();
  document.getElementById("dirNewName").value = "";
  dirLoad(cur || ""); // 空路径 → 家目录
  openModal("dirModal");
}

function pickDir() {
  const input = document.getElementById(dirState.inputId);
  if (input) input.value = dirState.path;
  closeModal("dirModal");
  toast("已选择目录");
}

async function mkdirCurrent() {
  const name = document.getElementById("dirNewName").value.trim();
  if (!name) return toast("先输入目录名", true);
  const p = dirState.path.replace(/\/+$/, "") + "/" + name;
  try {
    await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ path: p }) });
    document.getElementById("dirNewName").value = "";
    toast("已创建");
    dirLoad(dirState.path);
  } catch (e) { toast(e.message, true); }
}

// 项目目录 datalist：家目录顶层候选（项目弹窗 + 技能添加弹窗共用）
async function loadProjDatalist() {
  for (const id of ["dlistProj", "dlistSkill"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }
  try {
    const d = await api("/api/fs/dirs");
    const opts = d.dirs.map(n => `<option value="${esc(d.path.replace(/\/+$/, "") + "/" + n)}">`).join("");
    for (const id of ["dlistProj", "dlistSkill"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = opts;
    }
  } catch (_) {}
}

/* ---- 从卡片直接进入配置 tab ---- */
let pendingAgentTab = null;
function agentTabFromCard(id) {
  pendingAgentTab = "config";
  openAgentDetail(id);
}

function openAgentDetail(id) { location.hash = "#/agent/" + id; }
function closeAgentDetail() { location.hash = "#/"; }

function showAgentDetail(id) {
  const a = state.agents.find(x => x.id === id);
  if (!a) return;
  state.agentEditing = a;
  document.getElementById("agentListShell").classList.add("hidden");
  document.getElementById("agentDetailShell").classList.remove("hidden");
  document.getElementById("adCrumb").innerHTML = `角色 / <b>${esc(a.name)}</b>`;
  const docs = state.schema[a.cli]?.docs;
  document.getElementById("adCliDocs").innerHTML =
    `<span class="badge">${esc(a.cli)}</span> ${docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(docs)}">官方文档 ↗</a>` : ""}`;
  const tab = pendingAgentTab || "overview";
  pendingAgentTab = null;
  agentTab(tab);
}

function hideAgentDetail() {
  document.getElementById("agentDetailShell").classList.add("hidden");
  document.getElementById("agentListShell").classList.remove("hidden");
  state.agentEditing = null;
}

function agentTab(name) {
  state.agentTab = name;
  document.querySelectorAll("#agentTabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  const a = state.agentEditing;
  if (!a) return;
  const form = document.getElementById("agentForm");
  if (name === "overview") renderAgentOverview(a);
  else if (name === "config") renderAgentConfig(a);
  else if (name === "env") renderAgentEnv(a);
  else if (name === "stats") renderAgentStats(a);
}

async function loadAgentStats(a) {
  if (!state.agentStats[a.id]) {
    try { state.agentStats[a.id] = await api(`/api/stats/agent/${a.id}`); } catch (_) {}
  }
  return state.agentStats[a.id];
}

async function renderAgentOverview(a) {
  const form = document.getElementById("agentForm");
  if (!form) return;
  const st = await loadAgentStats(a);
  if (state.agentTab !== "overview") return;
  form.innerHTML = `
    <div class="agent-hero">
      <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
      <div>
        <div class="ah-name">${esc(a.name)} <span class="badge">${esc(a.cli)}</span>
          <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></div>
        ${a.description ? `<div class="ah-desc">${esc(a.description)}</div>` : ""}
      </div>
    </div>
    ${st ? `
      <div class="pd-stats">
        <div class="pd-chips">
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-running)"></span><b>${st.in_flight}</b><span>进行中</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${st.succeeded}</b><span>完成</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-failed)"></span><b>${st.failed}</b><span>失败</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-cancel)"></span><b>${st.cancelled}</b><span>取消</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${fmtPct(st.success_rate)}</b><span>成功率</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${fmtDur(st.avg_duration)}</b><span>平均耗时</span></div>
        </div>
      </div>
      <div class="sec-title">近 14 天完成</div>
      ${dailyChartHTML(st.daily, 14)}
      ${st.projects && st.projects.length ? `
        <div class="sec-title">分项目产出</div>
        <div class="list-wrap" style="max-height:260px">
          <table class="list-grid">
            <thead><tr><th>项目</th><th>任务</th><th>完成</th><th>失败</th><th>审批轮次</th><th>成功率</th><th>平均耗时</th></tr></thead>
            <tbody>${st.projects.map(ps => `
              <tr ${ps.project_id > 0 ? `onclick="openProject(${ps.project_id})" style="cursor:pointer"` : ""}>
                <td><a class="t-link" href="/projects#/project/${ps.project_id}">${esc(ps.project_name || "未命名")}</a></td>
                <td class="num">${ps.total}</td>
                <td class="num" style="color:var(--success)">${ps.succeeded}</td>
                <td class="num" style="color:var(--danger)">${ps.failed}</td>
                <td class="num">${ps.reviews || 0}</td>
                <td class="num">${fmtPct(ps.success_rate)}</td>
                <td class="num">${fmtDur(ps.avg_duration)}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>` : ""}
    ` : `<div class="empty">暂无统计</div>`}
    <div class="sec-title">最近任务</div>
    <div id="agentRecent"></div>`;
  try {
    const recent = await api(`/api/tasks?agent_id=${a.id}&limit=8`);
    const box = document.getElementById("agentRecent");
    if (box) {
      box.innerHTML = recent.map(t => `
        <div class="p-task-row" onclick="openTerminal(${t.id})">
          <span class="num">#${t.id}</span>
          <span class="t">${esc(t.title)}</span>
          <span class="a">${esc(t.project_name || "-")}</span>
          <span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>
        </div>`).join("") || `<div class="empty">还没有任务</div>`;
    }
  } catch (_) {}
}

async function renderAgentStats(a) {
  const form = document.getElementById("agentForm");
  if (!form) return;
  form.innerHTML = `<div class="empty">加载统计中...</div>`;
  const st = await loadAgentStats(a);
  if (state.agentTab !== "stats") return;
  if (!st) { form.innerHTML = `<div class="empty">统计不可用</div>`; return; }
  form.innerHTML = `
    <div class="sec-title">状态分布（${st.total} 个任务）</div>
    <div class="sb-wrap">${statusBarHTML(st.status_counts)}
      <div class="sb-legend">
        ${(st.status_counts || []).map(c =>
          `<span class="sb-item"><i style="background:${ST_COLOR[c.status]}"></i>${STATUS_LABEL[c.status]} ${c.count}</span>`).join("")}
      </div></div>
    <div class="sec-title">近 14 天完成</div>
    ${dailyChartHTML(st.daily, 14)}
    <div class="sec-title">分项目产出（维度二：agent 统计）</div>
    <div class="list-wrap">
      <table class="list-grid">
        <thead><tr><th>项目</th><th>任务</th><th>完成</th><th>失败</th><th>审批轮次</th><th>成功率</th><th>平均耗时</th></tr></thead>
        <tbody>${(st.projects || []).map(ps => `
          <tr>
            <td><a class="t-link" href="/projects#/project/${ps.project_id}">${esc(ps.project_name || "未命名")}</a></td>
            <td class="num">${ps.total}</td>
            <td class="num" style="color:var(--success)">${ps.succeeded}</td>
            <td class="num" style="color:var(--danger)">${ps.failed}</td>
            <td class="num">${ps.reviews || 0}</td>
            <td class="num">${fmtPct(ps.success_rate)}</td>
            <td class="num">${fmtDur(ps.avg_duration)}</td>
          </tr>`).join("") || `<tr><td colspan="7"><div class="empty">暂无产出</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

/* ---- schema 驱动的配置表单（深度定制核心） ---- */

function fieldValue(f, rc) {
  if (BUILTIN_KEYS.includes(f.key)) {
    const v = rc[f.key];
    if (f.type === "list") return Array.isArray(v) ? (v || []).join(",") : (v ?? "");
    if (f.type === "env") return Object.entries(v || {}).map(([k, val]) => `${k}=${val}`).join("\n");
    if (Array.isArray(v)) return (v || []).join(" "); // extra_args 等数组字段回显
    return v ?? f.default ?? "";
  }
  return (rc.custom && rc.custom[f.key] != null) ? rc.custom[f.key] : (f.default ?? "");
}

/* ---- 列表字段（chips 编辑器）：逗号分隔值 ↔ 可增删的 chip ---- */

function chipHTML(key, p) {
  return `<span class="chip-item" data-v="${esc(p)}"><span class="ci-text">${esc(p)}</span><button type="button" class="chip-x" onclick="removeChip('${key}', this)" aria-label="移除">×</button></span>`;
}

function chipEditorValue(el) {
  const box = el.closest(".chip-editor");
  return { box, hidden: box.querySelector('input[type="hidden"]') };
}

function syncChips(box, key) {
  const h = box.querySelector('input[type="hidden"]');
  const items = h.value ? h.value.split(",") : [];
  const row = box.querySelector(".chips");
  if (row) row.innerHTML = items.map(p => chipHTML(key, p)).join("");
  if (box.querySelector(".skill-opts")) {
    box.querySelectorAll(".skill-opts input[type=checkbox]").forEach(cb =>
      cb.checked = items.includes(cb.dataset.v));
  }
}

function addChip(key, input) {
  const v = (input.value || "").trim();
  if (!v) return;
  const { box, hidden } = chipEditorValue(input);
  const items = hidden.value ? hidden.value.split(",") : [];
  if (!items.includes(v)) {
    items.push(v);
    hidden.value = items.join(",");
  }
  syncChips(box, key);
  input.value = "";
  input.focus();
}

function removeChip(key, btn) {
  const chip = btn.closest(".chip-item");
  if (!chip) return;
  const { box, hidden } = chipEditorValue(btn);
  const items = hidden.value ? hidden.value.split(",") : [];
  const i = items.indexOf(chip.dataset.v);
  if (i >= 0) items.splice(i, 1);
  hidden.value = items.join(",");
  syncChips(box, key);
}

function toggleSkill(key, cb) {
  const { box, hidden } = chipEditorValue(cb);
  const items = hidden.value ? hidden.value.split(",") : [];
  const v = cb.dataset.v;
  if (cb.checked) { if (!items.includes(v)) items.push(v); }
  else { const i = items.indexOf(v); if (i >= 0) items.splice(i, 1); }
  hidden.value = items.join(",");
  syncChips(box, key);
}

/* ---- 技能多选：paihuo 技能库（按名称勾选，值=工作目录实际路径） ---- */

function skillsControlHTML(f, val) {
  const items = val ? String(val).split(",").map(s => s.trim()).filter(Boolean) : [];
  const lib = state.skillLib || [];
  const opts = lib.map(s => {
    const on = items.includes(s.dir);
    return `<label class="skill-opt"><input type="checkbox" data-v="${esc(s.dir)}" ${on ? "checked" : ""} onchange="toggleSkill('${f.key}', this)"><span title="${esc(s.description || s.dir)}">${esc(s.name)}</span></label>`;
  }).join("");
  return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map(p => chipHTML(f.key, p)).join("")}</div>
    <div class="skill-opts">${opts || `<div class="empty">技能库为空：到 Skills 页添加技能（含 SKILL.md 的目录）</div>`}</div>
    <div class="chip-add">
      <input placeholder="自定义技能目录路径，回车添加" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f.key}', this.previousElementSibling)">添加</button>
    </div>
  </div>`;
}

/* ---- 普通列表字段（plugins 等）：chip 编辑器 ---- */

function chipsControlHTML(f, val) {
  const items = val ? String(val).split(",").map(s => s.trim()).filter(Boolean) : [];
  return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map(p => chipHTML(f.key, p)).join("")}</div>
    <div class="chip-add">
      <input placeholder="${esc(f.placeholder || "回车添加")}" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f.key}', this.previousElementSibling)">添加</button>
    </div>
  </div>`;
}

function fieldControlHTML(f, rc) {
  const val = fieldValue(f, rc);
  const attrs = `data-key="${f.key}" data-type="${f.type}"`;
  let ctl = "";
  if (f.type === "select") {
    ctl = `<select ${attrs}>${f.options.map(o =>
      `<option value="${esc(o)}" ${String(val) === String(o) ? "selected" : ""}>${o === "" ? "默认" : esc(o)}</option>`).join("")}</select>`;
  } else if (f.type === "textarea") {
    ctl = `<textarea ${attrs} rows="5" placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`;
  } else if (f.type === "env") {
    ctl = `<textarea ${attrs} rows="6" placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`;
  } else if (f.type === "list" && f.source === "skills") {
    ctl = skillsControlHTML(f, val);
  } else if (f.type === "list") {
    ctl = chipsControlHTML(f, val);
  } else if (f.suggestions && f.suggestions.length) {
    const dl = "dl_" + (++dlSeq);
    ctl = `<input ${attrs} list="${dl}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">` +
      `<datalist id="${dl}">${f.suggestions.map(s => `<option value="${esc(s)}">`).join("")}</datalist>`;
  } else {
    ctl = `<input ${attrs} value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">`;
  }
  return `<div class="schema-field">
    <label class="field">${esc(f.label)}${ctl}</label>
    ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
  </div>`;
}

function schemaFormHTML(schema, rc) {
  const groups = {};
  (schema.fields || []).forEach(f => { (groups[f.group] = groups[f.group] || []).push(f); });
  return Object.entries(groups).map(([g, fs]) => `
    <div class="schema-group">
      <div class="schema-group-title">${esc(g)}</div>
      <div class="schema-group-body">${fs.map(f => fieldControlHTML(f, rc)).join("")}</div>
    </div>`).join("");
}

function readConfigFrom(schema, container) {
  const cfg = { model: "", system_prompt: "", instructions: "", thinking: "", skills: [], plugins: [], extra_args: [], env: {}, custom: {} };
  (schema.fields || []).forEach(f => {
    const el = container.querySelector(`[data-key="${f.key}"]`);
    if (!el) return;
    if (f.type === "env") {
      if (BUILTIN_KEYS.includes(f.key)) cfg.env = parseEnv(el.value);
      else cfg.custom[f.key] = el.value;
      return;
    }
    if (f.type === "list") {
      const arr = el.value.split(",").map(s => s.trim()).filter(Boolean);
      if (BUILTIN_KEYS.includes(f.key)) cfg[f.key] = arr;
      else cfg.custom[f.key] = arr.join(",");
      return;
    }
    if (f.key === "extra_args") {
      cfg.extra_args = el.value.split(/\s+/).filter(Boolean);
      return;
    }
    if (BUILTIN_KEYS.includes(f.key)) cfg[f.key] = el.value;
    else cfg.custom[f.key] = el.value;
  });
  return cfg;
}

async function renderAgentConfig(a) {
  const form = document.getElementById("agentForm");
  if (!form) return;
  const schema = state.schema[a.cli];
  if (!schema) { form.innerHTML = `<div class="empty">CLI schema 未加载</div>`; return; }
  await loadSkillLib();
  form.innerHTML = `
    <div class="schema-tip">该角色的可配置参数来自 ${esc(schema.name)} 官方文档
      ${schema.docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">查看文档 ↗</a>` : ""}。
      每个 CLI 的字段不同——这是按角色深度定制，不是统一定制。</div>
    <div id="configForm">${schemaFormHTML(schema, a.role_config || {})}</div>
    <div style="margin-top:16px"><button class="btn primary" onclick="saveAgentConfig()">保存</button></div>`;
}

async function saveAgentConfig() {
  const a = state.agentEditing;
  if (!a) return;
  const schema = state.schema[a.cli];
  const cfg = readConfigFrom(schema, document.getElementById("configForm"));
  try {
    await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ role_config: cfg }) });
    toast("配置已保存");
    await loadAll();
    showAgentDetail(a.id);
  } catch (e) { toast(e.message, true); }
}

async function renderAgentEnv(a) {
  const form = document.getElementById("agentForm");
  if (!form) return;
  const rc = a.role_config || {};
  form.innerHTML = `
    <div class="schema-tip">环境变量注入到该角色的每次执行进程（继承并覆盖系统环境）。</div>
    <label class="field">环境变量（每行 K=V）
      <textarea id="envText" rows="12" placeholder="KEY=VALUE">${esc(Object.entries(rc.env || {}).map(([k, v]) => `${k}=${v}`).join("\n"))}</textarea>
    </label>
    <div style="margin-top:16px"><button class="btn primary" onclick="saveAgentEnv()">保存环境变量</button></div>`;
}

async function saveAgentEnv() {
  const a = state.agentEditing;
  if (!a) return;
  const rc = a.role_config || {};
  const env = parseEnv(document.getElementById("envText").value);
  const body = {
    model: rc.model || "", system_prompt: rc.system_prompt || "", instructions: rc.instructions || "",
    thinking: rc.thinking || "", skills: rc.skills || [], plugins: rc.plugins || [],
    extra_args: rc.extra_args || [], env, custom: rc.custom || {},
  };
  try {
    await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ role_config: body }) });
    toast("环境变量已保存");
    await loadAll();
    showAgentDetail(a.id);
  } catch (e) { toast(e.message, true); }
}

async function openAgentModal(id) {
  const a = id ? state.agents.find(x => x.id === id) : null;
  document.getElementById("agentModalTitle").textContent = a ? "编辑角色" : "新建角色";
  document.getElementById("aId").value = a ? a.id : "";
  document.getElementById("aName").value = a ? a.name : "";
  document.getElementById("aDesc").value = a ? (a.description || "") : "";
  document.getElementById("aPerm").value = a ? (a.default_perm || "full") : "full";
  document.getElementById("aEnabled").checked = a ? a.enabled : true;
  state.agentModalRC = a ? JSON.parse(JSON.stringify(a.role_config || {})) : {};
  await loadSchema();
  await loadSkillLib();
  const sel = document.getElementById("aCli");
  if (a) sel.value = a.cli;
  else if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
  renderAgentModalSchema();
  openModal("agentModal");
}

function renderAgentModalSchema() {
  const schema = state.schema[document.getElementById("aCli").value];
  const box = document.getElementById("agentModalSchema");
  if (!box) return;
  const sub = document.getElementById("agentModalSub");
  if (sub && schema) {
    sub.innerHTML = `配置按 ${esc(schema.name)} 官方文档定制
      ${schema.docs ? `（<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">文档 ↗</a>）` : ""}，不同 CLI 字段不同`;
  }
  box.innerHTML = schema ? schemaFormHTML(schema, state.agentModalRC) : "";
}

async function submitAgent() {
  const id = document.getElementById("aId").value;
  const cli = document.getElementById("aCli").value;
  const schema = state.schema[cli];
  const body = {
    name: document.getElementById("aName").value.trim(),
    description: document.getElementById("aDesc").value.trim(),
    cli,
    default_perm: document.getElementById("aPerm").value,
    enabled: document.getElementById("aEnabled").checked,
    role_config: schema ? readConfigFrom(schema, document.getElementById("agentModalSchema")) : {},
  };
  try {
    if (id) await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
    closeModal("agentModal");
    await loadAll();
    renderAgentList();
  } catch (e) { toast(e.message, true); }
}

async function deleteAgent(id) {
  if (!id) return;
  if (!confirm("删除该角色？未完成任务将失去指派，历史任务保留。")) return;
  try {
    await api(`/api/agents/${id}`, { method: "DELETE" });
    await loadAll();
    renderAgentList();
    if (state.agentEditing && state.agentEditing.id === id) hideAgentDetail();
  } catch (e) { toast(e.message, true); }
}

function parseEnv(text) {
  const env = {};
  text.split("\n").forEach(line => {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return env;
}

/* ============================================================
   autopilots 页
   ============================================================ */

function renderScheduleList() {
  const body = document.getElementById("scheduleList");
  if (!body) return;
  body.innerHTML = state.schedules.map(sc => `
    <tr>
      <td><b>${esc(sc.name)}</b></td>
      <td><code style="font-family:var(--font-mono);font-size:12px">${esc(sc.cron)}</code></td>
      <td>${esc(sc.agent_name || "-")}</td>
      <td style="font-size:12px;color:var(--fg-muted)">${esc(sc.title_template || "")}</td>
      <td class="num">${esc((sc.last_run_at || "-").slice(0, 16).replace("T", " "))}</td>
      <td><input type="checkbox" ${sc.enabled ? "checked" : ""} onclick="toggleSchedule(${sc.id})"></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="openScheduleModal(${sc.id})">编辑</button>
          <button class="btn xs danger" onclick="deleteSchedule(${sc.id})">删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("scheduleEmpty");
  if (empty) empty.classList.toggle("hidden", state.schedules.length > 0);
}

async function toggleSchedule(id) {
  const sc = state.schedules.find(x => x.id === id);
  try {
    await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !sc.enabled }) });
    await loadAll();
    renderScheduleList();
  } catch (e) { toast(e.message, true); }
}

function openScheduleModal(id) {
  fillSelects();
  const sc = id ? state.schedules.find(x => x.id === id) : null;
  document.getElementById("scheduleModalTitle").textContent = sc ? "编辑定时任务" : "新建定时任务";
  document.getElementById("sId").value = sc ? sc.id : "";
  document.getElementById("sName").value = sc ? sc.name : "";
  document.getElementById("sCron").value = sc ? sc.cron : "0 9 * * *";
  document.getElementById("sTitle").value = sc ? sc.title_template : "";
  document.getElementById("sBody").value = sc ? sc.body_template : "";
  document.getElementById("sEnabled").checked = sc ? sc.enabled : true;
  if (sc) document.getElementById("sAgent").value = sc.agent_id;
  openModal("scheduleModal");
}

async function submitSchedule() {
  const id = document.getElementById("sId").value;
  const body = {
    name: document.getElementById("sName").value.trim(),
    cron: document.getElementById("sCron").value.trim(),
    title_template: document.getElementById("sTitle").value.trim(),
    body_template: document.getElementById("sBody").value,
    agent_id: Number(document.getElementById("sAgent").value),
    enabled: document.getElementById("sEnabled").checked,
  };
  try {
    if (id) await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/schedules", { method: "POST", body: JSON.stringify(body) });
    closeModal("scheduleModal");
    await loadAll();
    renderScheduleList();
  } catch (e) { toast(e.message, true); }
}

async function deleteSchedule(id) {
  if (!confirm("删除该定时任务？")) return;
  try {
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    await loadAll();
    renderScheduleList();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   skills 页：技能库管理（定向添加 → 复制到 paihuo 工作目录 → 角色按名称勾选）
   + Pi Extensions 管理（pi install/list/remove）
   ============================================================ */

function setSkillTab(tab) {
  const skills = tab === "skills";
  document.getElementById("segSkillLib").classList.toggle("active", skills);
  document.getElementById("segExt").classList.toggle("active", !skills);
  document.getElementById("skillShell").classList.toggle("hidden", !skills);
  document.getElementById("extShell").classList.toggle("hidden", skills);
  document.getElementById("btnAddSkill").classList.toggle("hidden", !skills);
  document.getElementById("btnAddExt").classList.toggle("hidden", skills);
  if (!skills) loadExtensions();
}

async function loadExtensions() {
  const raw = document.getElementById("extRaw");
  if (!raw) return;
  try {
    const d = await api("/api/extensions");
    raw.textContent = d.raw || "（空）";
    if (d.error && d.raw) raw.textContent = d.raw + "\n\n[执行提示] " + d.error;
  } catch (e) { raw.textContent = "加载失败: " + e.message; }
}

function openExtModal() {
  document.getElementById("extSource").value = "";
  openModal("extModal");
}

async function submitExt() {
  const source = document.getElementById("extSource").value.trim();
  if (!source) return toast("需要 extension 来源", true);
  try {
    const d = await api("/api/extensions/install", { method: "POST", body: JSON.stringify({ source }) });
    closeModal("extModal");
    toast("已安装");
    loadExtensions();
  } catch (e) { toast(e.message, true); }
}

async function removeExt() {
  const name = prompt("输入要移除的 extension 名称（可从上方列表查看）");
  if (!name) return;
  try {
    await api(`/api/extensions/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("已移除");
    loadExtensions();
  } catch (e) { toast(e.message, true); }
}

async function loadSkillLib() {
  try {
    state.skillLib = await api("/api/skills");
  } catch (_) { state.skillLib = []; }
}

function renderSkillLib() {
  const grid = document.getElementById("skillGrid");
  if (!grid) return;
  const lib = state.skillLib;
  grid.innerHTML = lib.map(s => `
    <div class="skill-card">
      <div class="sk-top">
        <span class="avatar">${esc((s.name || "?").slice(0, 1))}</span>
        <div class="sk-id">
          <div class="sk-name">${esc(s.name)}</div>
          <div class="sk-desc">${esc(s.description || "无描述")}</div>
        </div>
      </div>
      <div class="sk-meta">
        <span class="chip" title="${esc(s.dir)}">${esc(s.dir)}</span>
      </div>
      <div class="sk-foot">
        <span class="count-info">来源：${esc(s.source_path || "-")} · ${(s.created_at || "").slice(0, 10)}</span>
        <span class="ac-ops">
          <button class="btn xs danger" onclick="deleteSkill(${s.id})">${icon("trash")}删除</button>
        </span>
      </div>
    </div>`).join("");
  const empty = document.getElementById("skillEmpty");
  if (empty) empty.classList.toggle("hidden", lib.length > 0);
  const cnt = document.getElementById("skillCount");
  if (cnt) cnt.textContent = `${lib.length} 个技能`;
}

function openSkillModal() {
  document.getElementById("sSkillPath").value = "";
  loadProjDatalist();
  openModal("skillModal");
}

async function submitSkill() {
  const path = document.getElementById("sSkillPath").value.trim();
  if (!path) return toast("需要技能目录路径", true);
  try {
    const sk = await api("/api/skills", { method: "POST", body: JSON.stringify({ source_path: path }) });
    closeModal("skillModal");
    toast(`已导入 skill: ${sk.name}`);
    await loadSkillLib();
    renderSkillLib();
  } catch (e) { toast(e.message, true); }
}

async function deleteSkill(id) {
  const s = state.skillLib.find(x => x.id === id);
  if (!confirm(`删除 skill「${s ? s.name : id}」？将同时移除工作目录中的副本，已引用它的角色配置会失效。`)) return;
  try {
    await api(`/api/skills/${id}`, { method: "DELETE" });
    toast("已删除");
    await loadSkillLib();
    renderSkillLib();
  } catch (e) { toast(e.message, true); }
}

/* ---- 模板列表（提示词模板，任务详情「保存为模板」沉淀） ---- */

async function loadTemplates() {
  try {
    state.templates = await api("/api/templates");
  } catch (_) { return; }
  const sel = document.getElementById("tTemplate");
  if (sel) sel.innerHTML = `<option value="">—</option>` + state.templates.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  renderTemplateList();
}

function renderTemplateList() {
  const body = document.getElementById("templateList");
  if (!body) return;
  body.innerHTML = state.templates.map(t => `
    <tr>
      <td><b>${esc(t.name)}</b></td>
      <td style="font-size:12px;color:var(--fg-muted);max-width:480px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((t.body || "").slice(0, 90))}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td class="num">${(t.created_at || "").slice(0, 16).replace("T", " ")}</td>
      <td><button class="btn xs danger" onclick="deleteTemplate(${t.id})">${icon("trash")}删除</button></td>
    </tr>`).join("");
  const empty = document.getElementById("templateEmpty");
  if (empty) empty.classList.toggle("hidden", state.templates.length > 0);
}

async function deleteTemplate(id) {
  if (!confirm("删除该模板？")) return;
  try {
    await api(`/api/templates/${id}`, { method: "DELETE" });
    await loadTemplates();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   设置页
   ============================================================ */

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    const el = document.getElementById("retentionDays");
    if (el) el.value = s.retention_days || "";
    const wt = document.getElementById("wtRetentionDays");
    if (wt) wt.value = s.worktree_retention_days || "";
  } catch (_) {}
}

async function saveWtRetention() {
  try {
    const days = document.getElementById("wtRetentionDays").value.trim();
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ worktree_retention_days: days }) });
    toast("已保存，每小时自动清理一次");
  } catch (e) { toast(e.message, true); }
}

async function saveRetention() {
  try {
    const days = document.getElementById("retentionDays").value.trim();
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ retention_days: days }) });
    toast("已保存，每小时执行一次自动清理");
  } catch (e) { toast(e.message, true); }
}

async function runCleanup() {
  const agentId = Number(document.getElementById("cleanupAgent").value) || null;
  const days = Number(document.getElementById("cleanupDays").value);
  const before = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : "";
  if (!confirm(`删除${agentId ? "该角色" : "全部角色"}${before ? "、" + days + " 天前" : ""}的终态任务？不可恢复！`)) return;
  try {
    const r = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
    toast(`已删除 ${r.deleted} 条历史`);
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   Dashboard（默认首页）：统计条 + 任务执行区 + 项目区 + Agent 区
   ============================================================ */

function dashCardHTML(t, actions) {
  return `<div class="card dash-card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span>#${t.id}</span>
      <span>${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">审批</span>` : ""}
    </div>
    <div class="c-title">${esc(t.title)}</div>
    <div class="c-meta">
      ${t.project_name ? `<span class="chip">${esc(t.project_name)}</span>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm av-${esc(t.agent_name)}">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">未指派</span>`}
      </span>
    </div>
    ${actions ? `<div class="dash-actions" onclick="event.stopPropagation()">${actions}</div>` : ""}
  </div>`;
}

function loadDashboard() {
  refreshOverview();
  renderDashTasks();
  renderDashProjects();
  loadDashAgents();
}

function renderDashTasks() {
  const run = document.getElementById("dashRunning");
  const rev = document.getElementById("dashReview");
  if (!run || !rev) return;
  const running = state.tasks.filter(t => ["queued", "claimed", "running"].includes(t.status))
    .sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 12);
  const review = state.tasks.filter(t => t.status === "awaiting_review")
    .sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 12);
  run.innerHTML = running.map(t => dashCardHTML(t)).join("") || `<div class="empty">暂无进行中任务</div>`;
  rev.innerHTML = review.map(t => dashCardHTML(t,
    `<button class="btn xs brand" onclick="setTaskStatus(${t.id},'succeeded')">通过</button>` +
    `<button class="btn xs" onclick="rejectTask(${t.id})">驳回</button>` +
    `<button class="btn xs" onclick="openTerminal(${t.id})">看对话</button>`)).join("") || `<div class="empty">无待审批任务</div>`;
  const rc = document.getElementById("dashRunningCount");
  if (rc) rc.textContent = running.length;
  const vc = document.getElementById("dashReviewCount");
  if (vc) vc.textContent = review.length;
}

function renderDashProjects() {
  const box = document.getElementById("dashProjects");
  if (!box) return;
  const active = state.projects.filter(p => p.status === "active");
  if (!active.length) {
    box.innerHTML = `<div class="dash-onboard">
      <div class="ob-title">快速开始</div>
      <a class="ob-step" href="/agents">1. 安装 Agent（CLI）</a>
      <a class="ob-step" href="/roles">2. 创建 Role（角色配置）</a>
      <a class="ob-step" href="/projects">3. 新建 Project（绑定工作目录）</a>
      <a class="ob-step" href="/board">4. 在 Board 派发任务</a>
    </div>`;
    return;
  }
  box.innerHTML = active.map(p => {
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const done = ts.filter(t => t.status === "succeeded").length;
    const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
    const inflight = ts.filter(t => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
    return `<div class="dash-proj" onclick="location.href='/projects#/project/${p.id}'">
      <div class="dp-top"><b title="${esc(p.name)}">${esc(p.name)}</b>
        ${inflight ? `<span class="badge running">${inflight} 活跃</span>` : `<span class="badge">${ts.length} 任务</span>`}</div>
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${pct}%</span></div>
    </div>`;
  }).join("") || `<div class="empty">暂无活跃项目</div>`;
}

async function loadDashAgents() {
  try {
    const prov = await api("/api/provision");
    const box = document.getElementById("dashAgents");
    if (!box) return;
    const installed = prov.filter(p => p.installed);
    const agents = state.agents || [];
    const running = state.tasks.filter(t => t.status === "running").length;
    const review = state.tasks.filter(t => t.status === "awaiting_review").length;
    box.innerHTML = `
      <div class="dash-prov">
        ${prov.map(p => `<span class="prov-chip ${p.installed ? "ok" : ""} ${p.login ? "login" : ""}" title="${esc(p.name)}${p.installed ? " " + esc(p.version) : " — 未安装"}${p.installed && !p.login ? "（未登录）" : ""}">${esc(p.name)}${p.installed ? (p.login ? " ✓" : " ⚠") : " ✗"}</span>`).join("")}
      </div>
      <div class="dash-prov-meta">
        <span><b>${installed.length}/${prov.length}</b> 已安装</span>
        <span><b>${agents.filter(a => a.enabled).length}</b> 角色启用</span>
        <span><b style="color:var(--st-running)">${running}</b> 运行中</span>
        <span><b style="color:var(--st-review)">${review}</b> 待审批</span>
      </div>`;
  } catch (_) {}
}

/* ============================================================
   Agents 页：安装/登录管理
   ============================================================ */

let provState = { prov: [], instCli: null };

async function loadProvision() {
  try { provState.prov = await api("/api/provision"); } catch (_) { provState.prov = []; }
  renderProvGrid();
}

function renderProvGrid() {
  const grid = document.getElementById("provGrid");
  if (!grid) return;
  const empty = document.getElementById("provEmpty");
  if (empty) empty.classList.add("hidden");
  grid.innerHTML = provState.prov.map(p => `
    <div class="prov-card ${p.installed ? "" : "not-installed"}">
      <div class="pc-top">
        <span class="avatar lg av-${esc(p.id)}">${esc((p.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(p.name)}</div>
          <div class="ac-sub">
            ${p.installed ? `<span class="badge succeeded">已安装</span>` : `<span class="badge cancelled">未安装</span>`}
            ${p.installed ? `<span class="badge ${p.login ? "succeeded" : "awaiting_review"}">${p.login ? "已登录" : "未登录"}</span>` : ""}
          </div>
        </div>
        ${p.installed ? `<span class="prov-ver">${esc(p.version)}</span>` : ""}
      </div>
      <div class="prov-body">
        ${!p.installed ? `<div class="prov-cmd" title="官方安装命令">$ ${esc(p.install_cmd || "（请参考官方文档）")}</div>`
          : p.login ? `<div class="prov-login-ok">已检测到登录凭据 ✓</div>`
          : `<div class="prov-login-hint">${esc(p.login_hint || "请在服务器终端完成登录")}</div>`}
      </div>
      <div class="ac-stats prov-actions">
        ${!p.installed
          ? `<button class="btn sm brand" onclick="installProvision('${p.id}')">安装</button>`
          : `<button class="btn sm" onclick="installProvision('${p.id}')">重装/更新</button>`}
        <a class="btn sm ghost" href="${esc(p.docs)}" target="_blank" rel="noreferrer">官方文档 ↗</a>
        ${p.installed ? `<button class="btn sm" onclick="copyText('${esc(p.login_hint || "")}')">复制登录指引</button>` : ""}
        ${p.installed ? `<button class="btn sm" onclick="createDefaultRole('${p.id}')">创建默认角色</button>` : ""}
      </div>
    </div>`).join("");
  const cnt = document.getElementById("provCount");
  if (cnt) cnt.textContent = `已安装 ${provState.prov.filter(p => p.installed).length}/${provState.prov.length}`;
}

async function installProvision(cli) {
  provState.instCli = cli;
  const box = document.getElementById("instBox");
  const title = document.getElementById("instTitle");
  box.innerHTML = `<div class="empty">正在启动安装...</div>`;
  title.textContent = `安装 ${cli}`;
  openModal("instModal");
  try {
    const r = await api("/api/provision/install", { method: "POST", body: JSON.stringify({ cli }) });
    // 命令回显与执行输出由服务端经 SSE provision 事件推送，这里不再重复追加
    setTimeout(loadProvision, 3000);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    provState.instCli = null;
  }
}

function appendInstLine(line) {
  const box = document.getElementById("instBox");
  if (!box) return;
  const c = line.startsWith("$") ? "sys" : "out";
  box.insertAdjacentHTML("beforeend", `<div class="line"><span class="c ${c}">${esc(line)}</span></div>`);
  box.scrollTop = box.scrollHeight;
}

function closeInstTerminal() { provState.instCli = null; closeModal("instModal"); }

function refreshProvision() { loadProvision(); }

function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("已复制")).catch(() => toast("复制失败", true));
}

async function createDefaultRole(cli) {
  const name = prompt(`创建基于 ${cli} 的默认角色名称`, cli);
  if (!name) return;
  try {
    await api("/api/agents", { method: "POST", body: JSON.stringify({ name, cli, enabled: true }) });
    toast("已创建角色，可在角色页继续定制");
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   hash 路由 + SSE
   ============================================================ */

/* ---- 侧边栏折叠（localStorage 记忆） ---- */
function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const collapsed = sb.classList.toggle("collapsed");
  const btn = document.getElementById("sbToggle");
  if (btn) {
    btn.title = collapsed ? "展开侧边栏 (Ctrl+B)" : "收起侧边栏 (Ctrl+B)";
    btn.setAttribute("aria-label", btn.title);
  }
  try { localStorage.setItem("paihuo.sb", collapsed ? "1" : "0"); } catch (_) {}
}
function restoreSidebar() {
  let collapsed = false;
  try { collapsed = localStorage.getItem("paihuo.sb") === "1"; } catch (_) {}
  const sb = document.getElementById("sidebar");
  if (sb && collapsed) sb.classList.add("collapsed");
  if (collapsed) {
    const btn = document.getElementById("sbToggle");
    if (btn) { btn.title = "展开侧边栏 (Ctrl+B)"; btn.setAttribute("aria-label", btn.title); }
  }
}

/* ---- 全局快捷键 ----
   N 新建任务（看板页）  / 聚焦搜索  Esc 关闭弹窗  Ctrl/Cmd+B 折叠侧边栏 */
function initShortcuts() {
  document.addEventListener("keydown", e => {
    const t = e.target;
    const inField = t && (t.matches("input, textarea, select") || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault(); toggleSidebar(); return;
    }
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not(.hidden)").forEach(m => closeModal(m.id));
      return;
    }
    if (inField) return;
    if (e.key === "n" || e.key === "N") {
      const taskModal = document.getElementById("taskModal");
      const inDetail = !document.getElementById("detailShell")?.classList.contains("hidden");
      if (!taskModal || inDetail) return; // 仅看板页、且未打开任务详情时生效
      openNewTask();
    }
    if (e.key === "/") {
      const s = document.querySelector("#pSearch, #aSearch");
      if (s) { e.preventDefault(); s.focus(); }
    }
  });
  // 点击弹窗背景关闭
  document.addEventListener("click", e => {
    if (e.target && e.target.classList && e.target.classList.contains("modal")) {
      closeModal(e.target.id);
    }
  });
  // 目录选择器事件委托（全站共享：agents / projects / skills）
  document.addEventListener("click", e => {
    const row = e.target.closest?.(".dir-row");
    if (row) { dirLoad(row.dataset.path); return; }
    const seg = e.target.closest?.(".crumb-seg");
    if (seg && !seg.classList.contains("cur")) dirLoad(seg.dataset.p);
  });
}


function route() {
  const h = location.hash;
  const path = location.pathname;
  if (path === "/projects") {
    const m = /^#\/project\/(\d+)/.exec(h);
    if (m) showProjectDetail(Number(m[1]));
    else if (state.projectView !== null) hideProjectDetail();
    return;
  }
  if (path === "/roles") {
    const m = /^#\/agent\/(\d+)/.exec(h);
    if (m) {
      const id = Number(m[1]);
      // 详情内允许直接切到另一个角色（比如从项目成员表点进来再切换）
      if (state.agentEditing === null || state.agentEditing.id !== id) showAgentDetail(id);
    } else if (state.agentEditing !== null) {
      hideAgentDetail();
    }
    return;
  }
  const m = /^#\/issue\/(\d+)/.exec(h);
  if (m) showDetail(Number(m[1]));
  else if (state.selected !== null || !document.getElementById("detailShell").classList.contains("hidden")) {
    hideDetail();
  }
}

let ovTimer = null;
function refreshOverviewSoon() {
  clearTimeout(ovTimer);
  ovTimer = setTimeout(refreshOverview, 600);
}

// SSE 连接管理：
// - 页面隐藏（后台标签页）时主动断开：浏览器对同域名 HTTP/1.1 最多 6 个
//   并发连接，每个页面的 SSE 长连接占一个名额；页面开多了连接池被占满，
//   新页面导航会一直排队转圈。隐藏即释放，可见时重连。
// - pagehide（导航/关页）时主动 close，不依赖浏览器异步 abort。
function sse() {
  if (state.es) return; // 已有连接（可见性切换重连时避免重复）
  const es = new EventSource("/api/events");
  state.es = es;
  es.addEventListener("task", ev => {
    try {
      const t = JSON.parse(ev.data).payload;
      const i = state.tasks.findIndex(x => x.id === t.id);
      if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
      const path = location.pathname;
      if (path === "/board") {
        state.view === "list" ? renderList() : renderBoard();
        if (state.selected === t.id) refreshDetail();
        refreshOverviewSoon();
      } else if (path === "/") {
        loadDashboard();
        if (state.selected === t.id) refreshDetail();
      } else if (path === "/history") {
        loadHistory();
      } else if (path === "/roles") {
        if (state.agentTab === "overview") renderAgentOverview(state.agentEditing);
      } else if (path === "/projects") {
        renderProjectList();
        if (state.projectView) refreshProjectDetail();
      }
      fillSelects();
    } catch (_) {}
  });
  es.addEventListener("log", ev => {
    try { appendLog(JSON.parse(ev.data).payload); } catch (_) {}
  });
  es.addEventListener("provision", ev => {
    try {
      const d = JSON.parse(ev.data).payload;
      if (provState.instCli && d.cli === provState.instCli) appendInstLine(d.line || "");
      if (d.line && d.line.includes("[install] 完成")) {
        setTimeout(loadProvision, 1500);
      }
    } catch (_) {}
  });
  es.addEventListener("error", () => {
    // EventSource 自动重连；只有 es.close() 后不再重连
    if (!state.es) return;
  });
}

// 页面隐藏：断开 SSE 释放连接名额；可见：重连并刷新数据（隐藏期间可能错过事件）。
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.es) { state.es.close(); state.es = null; }
    return;
  }
  if (!state.es) {
    sse();
    loadAll().then(() => {
      const path = location.pathname;
      if (path === "/") loadDashboard();
      else if (path === "/board") { renderBoard(); renderList(); refreshOverview(); }
      else if (path === "/history") loadHistory();
      else if (path === "/roles") renderAgentList();
      else if (path === "/agents") loadProvision();
      else if (path === "/projects") renderProjectList();
      else if (path === "/autopilots") renderScheduleList();
      else if (path === "/skills") loadSkillLib().then(renderSkillLib);
      else if (path === "/settings") loadSettings();
    }).catch(() => {});
  }
});

// 导航/关页：主动关闭 SSE，避免连接残留占住浏览器连接池。
window.addEventListener("pagehide", () => {
  if (state.es) { state.es.close(); state.es = null; }
});

document.addEventListener("DOMContentLoaded", async () => {
  restoreSidebar();
  initShortcuts();
  await loadSchema();
  try { await loadAll(); } catch (e) { toast("加载失败: " + e.message, true); }
  const path = location.pathname;
  if (path === "/") {
    loadDashboard();
    loadTemplates();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/board") {
    renderBoard();
    loadTemplates();
    refreshOverview();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/history") {
    loadHistory();
  } else if (path === "/roles") {
    let av = "grid";
    try { av = localStorage.getItem("paihuo.agentView") || "grid"; } catch (_) {}
    setAgentView(av === "table" ? "table" : "grid");
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/agents") {
    loadProvision();
  } else if (path === "/projects") {
    renderProjectList();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/autopilots") {
    renderScheduleList();
  } else if (path === "/skills") {
    loadSkillLib().then(renderSkillLib);
  } else if (path === "/settings") {
    loadSettings();
  }
  sse();
});
