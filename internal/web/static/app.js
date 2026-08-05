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
  history: [], historySel: new Set(),
  agentEditing: null,
  agentTab: "overview",
  agentModalRC: {},  // 新建/编辑弹窗中的临时 role_config
  projectView: null, // 项目详情中的项目 id
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
const BUILTIN_KEYS = ["model", "system_prompt", "thinking", "skills", "plugins", "extra_args", "env"];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
  t.textContent = msg;
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
      <td class="chk"><span class="num">#${t.id}</span></td>
      <td class="t-title">${esc(t.title)}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${esc(t.project_name || "-")}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops" style="display:flex;gap:4px">
          <button class="btn xs" onclick="event.stopPropagation();openTerminal(${t.id})">对话</button>
          ${["succeeded", "failed", "cancelled"].includes(t.status)
            ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">重试</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">删除</button>
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
  document.getElementById("boardShell").classList.add("hidden");
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
  document.getElementById("boardShell").classList.remove("hidden");
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
    <div class="detail-id">#${t.id} · 创建于 ${esc((t.created_at || "").slice(0, 16).replace("T", " "))}</div>
    ${t.body ? `<div class="detail-desc">${esc(t.body)}</div>` : ""}
    ${t.error ? `<div class="detail-desc" style="border-color:rgba(255,99,105,.4);color:var(--danger)">错误：${esc(t.error)}</div>` : ""}
    <div id="childrenBox"></div>
    ${t.status === "awaiting_review" ? `<div id="diffBox"><div class="empty">加载改动中...</div></div>` : ""}
    <div class="term">
      <div class="term-head">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="t-title">${esc(t.agent_name || "未指派")} · 对话 · ${esc(t.project_dir || "")}</span>
        <button class="btn ghost xs" onclick="copyLogs()">复制</button>
        <button class="btn ghost xs" onclick="openTerminal(${t.id})">全屏</button>
      </div>
      <div class="term-body" id="logBox">${logsHTML()}</div>
    </div>`;
  const box = document.getElementById("logBox");
  if (box) box.scrollTop = box.scrollHeight;
  if (t.status === "awaiting_review") loadDiff(t.id);
  loadChildren(t.id);
  renderSide(t);
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
    actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">取消任务</button>`;
  }
  if (t.status === "awaiting_review") {
    actions += `<button class="btn sm brand" onclick="setTaskStatus(${t.id},'succeeded')">审批通过</button>`;
    actions += `<button class="btn sm" onclick="rejectTask(${t.id})">驳回重做</button>`;
    actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">取消</button>`;
  }
  if (["succeeded", "failed", "cancelled"].includes(t.status)) {
    actions += `<button class="btn sm" onclick="setTaskStatus(${t.id},'queued')">重试</button>`;
  }
  actions += `<button class="btn sm" onclick="openSubTask(${t.id})">拆分子任务</button>`;
  if (t.body) actions += `<button class="btn sm" onclick="saveAsTemplate(${t.id})">保存为模板</button>`;
  actions += `<button class="btn sm danger" onclick="deleteTask(${t.id})">删除任务</button>`;

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
    if (p === "/" ) {
      if (state.selected === id && location.hash.startsWith("#/issue/")) showDetail(id);
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
    box.innerHTML = `<div class="detail-desc" style="color:var(--success)">文件改动（git diff）：</div>
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
    const box = document.getElementById("termBox");
    if (box) {
      box.insertAdjacentHTML("beforeend", logLineHTML(l));
      box.scrollTop = box.scrollHeight;
    }
  }
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(state.logs.map(l => l.content).join("\n"));
    toast("已复制对话内容");
  } catch (_) { toast("复制失败", true); }
}

function openTerminal(id) {
  const t = state.tasks.find(x => x.id === id) || {};
  document.getElementById("termTitle").textContent = `${t.agent_name || ""} · #${id} 对话`;
  const box = document.getElementById("termBox");
  box.innerHTML = `<div class="empty">加载对话中...</div>`;
  openModal("termModal");
  state.termTask = id;
  api(`/api/tasks/${id}/logs`).then(logs => {
    box.innerHTML = logs.map(logLineHTML).join("");
    box.scrollTop = box.scrollHeight;
  }).catch(() => { box.innerHTML = `<div class="empty">对话加载失败</div>`; });
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
        <span style="display:flex;gap:4px">
          ${["succeeded", "failed", "cancelled"].includes(t.status)
            ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">重试</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">删除</button>
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
        <span class="badge ${p.status === "active" ? "running" : "cancelled"}">${p.status === "active" ? "进行中" : "已归档"}</span>
      </div>
      ${p.description ? `<div class="pc-desc">${esc(p.description)}</div>` : ""}
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${fmtPct(pct)}</span></div>
      <div class="pc-meta">
        <span>${ts.length} 个任务</span>
        <span>${done} 完成</span>
        <span>${agents.size} 个角色</span>
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
          ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">重试</button>` : ""}
        <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">删除</button>
      </span>
    </div>`).join("");

  const agentsHTML = (s.agents || []).map(a => `
    <tr>
      <td class="t-title"><span class="avatar sm">${esc((a.agent_name || "?").slice(0, 1))}</span>
        <a class="t-link" href="/agents#/agent/${a.agent_id}">${esc(a.agent_name || "未指派")}</a></td>
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
    <div class="prop-row"><span class="k">描述</span><span class="v" style="font-size:12px;white-space:pre-wrap">${esc(p.description || "-")}</span></div>
    <div class="prop-row"><span class="k">创建</span><span class="v">${esc((p.created_at || "").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">操作</div>
    <div class="detail-actions">
      <button class="btn sm" onclick="openProjectModal(${p.id})">编辑项目</button>
      <button class="btn sm danger" onclick="deleteProject(${p.id})">删除项目</button>
    </div>`;
}

function openProjectModal(id) {
  const p = id ? state.projects.find(x => x.id === id) : null;
  document.getElementById("projectModalTitle").textContent = p ? "编辑项目" : "新建项目";
  document.getElementById("pId").value = p ? p.id : "";
  document.getElementById("pName").value = p ? p.name : "";
  document.getElementById("pDesc").value = p ? (p.description || "") : "";
  document.getElementById("pStatus").value = p ? (p.status || "active") : "active";
  openModal("projectModal");
}

async function submitProject() {
  const id = document.getElementById("pId").value;
  const body = {
    name: document.getElementById("pName").value.trim(),
    description: document.getElementById("pDesc").value.trim(),
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

function renderAgentList() {
  const body = document.getElementById("agentList");
  if (!body) return;
  const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
  const list = state.agents.filter(a => !q || a.name.toLowerCase().includes(q));
  body.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    return `<tr onclick="openAgentDetail(${a.id})">
      <td><span style="display:flex;align-items:center;gap:8px">
        <span class="avatar">${esc((a.name || "?").slice(0, 1))}</span>
        <b>${esc(a.name)}</b>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(a.description || "")}</span>
      </span></td>
      <td><span class="badge">${esc(a.cli)}</span></td>
      <td>${esc(rc.model || "默认")}</td>
      <td style="font-size:12px;color:var(--fg-muted)">${esc(a.project_dir || "-")}</td>
      <td><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></td>
      <td>
        <span style="display:flex;gap:4px">
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteAgent(${a.id})">删除</button>
        </span>
      </td>
    </tr>`;
  }).join("");
  const empty = document.getElementById("agentEmpty");
  if (empty) empty.classList.toggle("hidden", list.length > 0);
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

async function toggleAgent(id) {
  const a = state.agents.find(x => x.id === id);
  try {
    await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
    await loadAll();
    renderAgentList();
  } catch (e) { toast(e.message, true); }
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
  agentTab("overview");
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
      <span class="avatar lg">${esc((a.name || "?").slice(0, 1))}</span>
      <div>
        <div class="ah-name">${esc(a.name)} <span class="badge">${esc(a.cli)}</span>
          <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></div>
        ${a.description ? `<div class="ah-desc">${esc(a.description)}</div>` : ""}
        <div class="ah-sub">${esc(a.project_dir || "")}</div>
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
  } else if (f.type === "list") {
    ctl = `<input ${attrs} value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">`;
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
  const cfg = { model: "", system_prompt: "", thinking: "", skills: [], plugins: [], extra_args: [], env: {}, custom: {} };
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
  form.innerHTML = `
    <div class="schema-tip">该角色的可配置参数来自 ${esc(schema.name)} 官方文档
      ${schema.docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">查看文档 ↗</a>` : ""}。
      每个 CLI 的字段不同——这是按角色深度定制，不是统一定制。</div>
    <div id="configForm">${schemaFormHTML(schema, a.role_config || {})}</div>
    <div style="margin-top:16px"><button class="btn primary" onclick="saveAgentConfig()">保存配置</button></div>`;
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
    model: rc.model || "", system_prompt: rc.system_prompt || "", thinking: rc.thinking || "",
    skills: rc.skills || [], plugins: rc.plugins || [], extra_args: rc.extra_args || [],
    env, custom: rc.custom || {},
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
  document.getElementById("aProjectDir").value = a ? (a.project_dir || "") : "";
  document.getElementById("aPerm").value = a ? (a.default_perm || "full") : "full";
  document.getElementById("aEnabled").checked = a ? a.enabled : true;
  state.agentModalRC = a ? JSON.parse(JSON.stringify(a.role_config || {})) : {};
  await loadSchema();
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
    project_dir: document.getElementById("aProjectDir").value.trim(),
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
        <span style="display:flex;gap:4px">
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
   skills 页
   ============================================================ */

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
      <td><button class="btn xs danger" onclick="deleteTemplate(${t.id})">删除</button></td>
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
  } catch (_) {}
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
   hash 路由 + SSE
   ============================================================ */

function route() {
  const h = location.hash;
  const path = location.pathname;
  if (path === "/projects") {
    const m = /^#\/project\/(\d+)/.exec(h);
    if (m) showProjectDetail(Number(m[1]));
    else if (state.projectView !== null) hideProjectDetail();
    return;
  }
  if (path === "/agents") {
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

function sse() {
  const es = new EventSource("/api/events");
  es.addEventListener("task", ev => {
    try {
      const t = JSON.parse(ev.data).payload;
      const i = state.tasks.findIndex(x => x.id === t.id);
      if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
      const path = location.pathname;
      if (path === "/") {
        state.view === "list" ? renderList() : renderBoard();
        if (state.selected === t.id) refreshDetail();
        refreshOverviewSoon();
      } else if (path === "/history") {
        loadHistory();
      } else if (path === "/agents") {
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
  es.addEventListener("error", () => { /* EventSource 自动重连 */ });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSchema();
  try { await loadAll(); } catch (e) { toast("加载失败: " + e.message, true); }
  const path = location.pathname;
  if (path === "/") {
    renderBoard();
    loadTemplates();
    refreshOverview();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/history") {
    loadHistory();
  } else if (path === "/agents") {
    renderAgentList();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/projects") {
    renderProjectList();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/autopilots") {
    renderScheduleList();
  } else if (path === "/skills") {
    loadTemplates();
  } else if (path === "/settings") {
    loadSettings();
  }
  sse();
});
