/* ============================================================
   派活 PaiHuo — 前端逻辑
   布局复刻 multica：侧边栏 + 页头 + 工具条 + 看板/列表/详情
   ============================================================ */

const state = {
  tasks: [], agents: [], schedules: [], templates: [],
  view: "board",          // board | list
  selected: null,         // 详情中的任务 id
  logs: [],               // 详情任务日志
  history: [],            // 历史页筛选结果
  historySel: new Set(),
  agentEditing: null,     // 详情中的角色
  agentTab: "general",
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  const [tasks, agents, schedules] = await Promise.all([
    api("/api/tasks"), api("/api/agents"), api("/api/schedules"),
  ]);
  state.tasks = tasks;
  state.agents = agents;
  state.schedules = schedules;
  fillSelects();
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
  const cnt = document.getElementById("sbBoardCount");
  if (cnt) cnt.textContent = state.tasks.filter(t =>
    ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
}

/* ============================================================
   看板页：board / list 视图
   ============================================================ */

function currentFilters() {
  return {
    agent: Number(document.getElementById("fAgent")?.value) || null,
    status: document.getElementById("fStatus")?.value || "",
  };
}

function filteredTasks() {
  const f = currentFilters();
  return state.tasks.filter(t => {
    if (f.agent && t.agent_id !== f.agent) return false;
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
      ${t.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">未指派</span>`}
      <span class="c-foot">
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

function openTask(id) {
  location.hash = "#/issue/" + id;
}

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
    if (state.selected === id && location.hash.startsWith("#/issue/")) showDetail(id);
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
    if (state.selected === id) { closeDetail(); location.hash = "#/"; }
    if (location.pathname === "/history") loadHistory();
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

/* ============================================================
   任务创建 / 模板
   ============================================================ */

function openNewTask() {
  fillSelects();
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = "full";
  document.getElementById("tParentId").value = "";
  document.getElementById("taskModalTitle").textContent = "新建任务";
  openModal("taskModal");
}

async function submitTask() {
  const title = document.getElementById("tTitle").value.trim();
  if (!title) return toast("标题不能为空", true);
  const parentId = Number(document.getElementById("tParentId").value) || null;
  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: document.getElementById("tBody").value,
        agent_id: Number(document.getElementById("tAgent").value) || null,
        perm: document.getElementById("tPerm").value,
        parent_id: parentId,
      }),
    });
    closeModal("taskModal");
    toast("任务已创建");
    await loadAll();
    renderBoard(); renderList();
  } catch (e) { toast(e.message, true); }
}

function applyTemplate() {
  const t = state.templates.find(x => x.id === Number(document.getElementById("tTemplate").value));
  if (!t) return;
  document.getElementById("tBody").value = t.body || "";
  if (t.agent_id) document.getElementById("tAgent").value = t.agent_id;
}

async function saveAsTemplate(taskId) {
  const t = state.tasks.find(x => x.id === taskId);
  if (!t) return;
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
   agents 页：列表 + 详情 tab
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

function openAgentDetail(id) {
  location.hash = "#/agent/" + id;
}

function closeAgentDetail() {
  location.hash = "#/";
}

function showAgentDetail(id) {
  const a = state.agents.find(x => x.id === id);
  if (!a) return;
  state.agentEditing = a;
  document.getElementById("agentListShell").classList.add("hidden");
  document.getElementById("agentDetailShell").classList.remove("hidden");
  agentTab("general");
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
  const rc = a.role_config || {};
  const form = document.getElementById("agentForm");
  let html = "";
  if (name === "general") {
    html = `
      <div class="row">
        <label class="field">角色名 <input id="gName" value="${esc(a.name)}"></label>
        <label class="field">CLI <select id="gCli">
          ${["omp", "opencode", "pi", "claude", "codex"].map(c =>
            `<option value="${c}" ${c === a.cli ? "selected" : ""}>${c}</option>`).join("")}
        </select></label>
      </div>
      <label class="field">项目目录 <input id="gDir" value="${esc(a.project_dir || "")}" placeholder="/path/to/project"></label>
      <label class="field">描述 <input id="gDesc" value="${esc(a.description || "")}"></label>
      <div class="row">
        <label class="field">默认权限 <select id="gPerm">
          <option value="full" ${(a.default_perm || "full") === "full" ? "selected" : ""}>完整</option>
          <option value="review" ${a.default_perm === "review" ? "selected" : ""}>完成后审批</option>
        </select></label>
        <label class="field" style="display:flex;align-items:center;gap:8px;margin-top:26px">
          <input type="checkbox" id="gEnabled" ${a.enabled ? "checked" : ""} style="width:auto"> 启用
        </label>
      </div>`;
  } else if (name === "model") {
    html = `
      <label class="field">模型 <input id="gModel" value="${esc(rc.model || "")}" placeholder="留空用 CLI 默认"></label>
      <label class="field">思考级别 <select id="gThink">
        ${["", "low", "medium", "high"].map(v =>
          `<option value="${v}" ${(rc.thinking || "") === v ? "selected" : ""}>${v === "" ? "默认" : v}</option>`).join("")}
      </select></label>
      <label class="field">系统提示词 <textarea id="gSys" rows="6" placeholder="角色定位、行为规范。会追加到 CLI 默认提示词之后">${esc(rc.system_prompt || "")}</textarea></label>`;
  } else if (name === "skills") {
    html = `
      <label class="field">技能目录（逗号分隔）<input id="gSkills" value="${esc((rc.skills || []).join(","))}" placeholder="/path/to/skills1,/path/to/skills2"></label>
      <label class="field">插件/配置文件（逗号分隔）<input id="gPlugins" value="${esc((rc.plugins || []).join(","))}"></label>
      <label class="field">额外参数（空格分隔）<input id="gExtra" value="${esc((rc.extra_args || []).join(" "))}" placeholder="--no-lsp --no-session"></label>`;
  } else if (name === "env") {
    html = `
      <label class="field">环境变量（每行 K=V）<textarea id="gEnv" rows="10" placeholder="KEY=VALUE">${esc(Object.entries(rc.env || {}).map(([k, v]) => `${k}=${v}`).join("\n"))}</textarea></label>`;
  }
  html += `<div style="margin-top:16px"><button class="btn primary" onclick="saveAgentDetail()">保存修改</button></div>`;
  form.innerHTML = html;
}

async function saveAgentDetail() {
  const a = state.agentEditing;
  const rc = a.role_config || {};
  const g = id => document.getElementById(id);
  const body = {
    name: (g("gName")?.value ?? a.name).trim(),
    description: g("gDesc")?.value ?? a.description,
    cli: g("gCli")?.value ?? a.cli,
    project_dir: g("gDir")?.value ?? a.project_dir,
    default_perm: g("gPerm")?.value ?? a.default_perm,
    enabled: g("gEnabled") ? g("gEnabled").checked : a.enabled,
    role_config: {
      model: (g("gModel")?.value ?? rc.model).trim(),
      thinking: g("gThink")?.value ?? rc.thinking,
      system_prompt: g("gSys")?.value ?? rc.system_prompt,
      skills: (g("gSkills")?.value ?? (rc.skills || []).join(",")).split(",").map(s => s.trim()).filter(Boolean),
      plugins: (g("gPlugins")?.value ?? (rc.plugins || []).join(",")).split(",").map(s => s.trim()).filter(Boolean),
      extra_args: (g("gExtra")?.value ?? (rc.extra_args || []).join(" ")).split(/\s+/).filter(Boolean),
      env: g("gEnv") ? parseEnv(g("gEnv").value) : (rc.env || {}),
    },
  };
  try {
    await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify(body) });
    toast("已保存");
    await loadAll();
    showAgentDetail(a.id);
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

async function openAgentModal(id) {
  const a = id ? state.agents.find(x => x.id === id) : null;
  document.getElementById("agentModalTitle").textContent = a ? "编辑角色" : "新建角色";
  document.getElementById("aId").value = a ? a.id : "";
  document.getElementById("aName").value = a ? a.name : "";
  document.getElementById("aDesc").value = a ? (a.description || "") : "";
  document.getElementById("aCli").value = a ? a.cli : "omp";
  document.getElementById("aProjectDir").value = a ? (a.project_dir || "") : "";
  document.getElementById("aPerm").value = a ? (a.default_perm || "full") : "full";
  const rc = a ? (a.role_config || {}) : {};
  document.getElementById("aModel").value = rc.model || "";
  document.getElementById("aSysPrompt").value = rc.system_prompt || "";
  document.getElementById("aThinking").value = rc.thinking || "";
  document.getElementById("aSkills").value = (rc.skills || []).join(",");
  document.getElementById("aPlugins").value = (rc.plugins || []).join(",");
  document.getElementById("aExtra").value = (rc.extra_args || []).join(" ");
  document.getElementById("aEnv").value = Object.entries(rc.env || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  openModal("agentModal");
}

async function submitAgent() {
  const id = document.getElementById("aId").value;
  const body = {
    name: document.getElementById("aName").value.trim(),
    description: document.getElementById("aDesc").value.trim(),
    cli: document.getElementById("aCli").value,
    project_dir: document.getElementById("aProjectDir").value.trim(),
    default_perm: document.getElementById("aPerm").value,
    role_config: {
      model: document.getElementById("aModel").value.trim(),
      system_prompt: document.getElementById("aSysPrompt").value,
      skills: document.getElementById("aSkills").value.split(",").map(s => s.trim()).filter(Boolean),
      thinking: document.getElementById("aThinking").value,
      plugins: document.getElementById("aPlugins").value.split(",").map(s => s.trim()).filter(Boolean),
      extra_args: document.getElementById("aExtra").value.split(/\s+/).filter(Boolean),
      env: parseEnv(document.getElementById("aEnv").value),
    },
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
  if (!confirm("删除该角色？未完成任务将失去指派。")) return;
  try {
    await api(`/api/agents/${id}`, { method: "DELETE" });
    await loadAll();
    renderAgentList();
  } catch (e) { toast(e.message, true); }
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
  if (path === "/agents") {
    const m = /^#\/agent\/(\d+)/.exec(h);
    if (m && state.agentEditing === null) showAgentDetail(Number(m[1]));
    else if (!m && state.agentEditing !== null) hideAgentDetail();
    return;
  }
  const m = /^#\/issue\/(\d+)/.exec(h);
  if (m) showDetail(Number(m[1]));
  else if (state.selected !== null || !document.getElementById("detailShell").classList.contains("hidden")) {
    hideDetail();
  }
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
      } else if (path === "/history") {
        loadHistory();
      } else if (path === "/agents") {
        const j = state.agents.findIndex(x => x.id === t.agent_id);
        if (j < 0) loadAll().then(() => { renderAgentList(); });
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
  try { await loadAll(); } catch (e) { toast("加载失败: " + e.message, true); }
  const path = location.pathname;
  if (path === "/") {
    renderBoard();
    loadTemplates();
    route();
    window.addEventListener("hashchange", route);
  } else if (path === "/history") {
    loadHistory();
  } else if (path === "/agents") {
    renderAgentList();
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
