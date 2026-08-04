/* 派活前端逻辑：看板渲染、SSE 实时更新、CRUD。 */

const TOKEN = document.body.dataset.token || "";
const state = {
  tasks: [],
  agents: [],
  devices: [],
  schedules: [],
  selected: null, // 当前查看的任务 id
  logs: [], // 当前查看任务的日志
};

const STATUS_LABEL = {
  queued: "待执行", claimed: "领取中", running: "执行中",
  awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "已取消",
};
const COLUMNS = [
  ["queued", "待执行"], ["claimed", "领取中"], ["running", "执行中"],
  ["awaiting_review", "待审批"], ["succeeded", "完成"], ["failed", "失败"], ["cancelled", "已取消"],
];
const PERM_LABEL = { full: "完整", review: "读+确认", readonly: "只读" };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isErr) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " error" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
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

/* ------------------------------------------------------------------ */
/* 看板 */

async function loadAll() {
  const [tasks, agents, schedules] = await Promise.all([
    api("/api/tasks"), api("/api/agents"), api("/api/schedules"),
  ]);
  state.tasks = tasks;
  state.agents = agents;
  state.schedules = schedules;
  renderBoard();
  fillAgentSelects();
  fillCleanupAgent();
  renderSettings();
  if (state.selected) refreshDetail();
}

function renderSettings() {
  const al = document.getElementById("agentList");
  if (al) al.innerHTML = state.agents.map(agentHTML).join("") || `<div class="empty">还没有角色，点击右上角新建</div>`;
  const sl = document.getElementById("scheduleList");
  if (sl) sl.innerHTML = state.schedules.map(scheduleHTML).join("") || `<div class="empty">还没有定时任务</div>`;
}

function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = COLUMNS.map(([key, label]) => {
    const items = state.tasks.filter(t => t.status === key);
    return `<div class="column">
      <div class="col-head"><span>${label}</span><span class="count">${items.length}</span></div>
      ${items.map(cardHTML).join("") || `<div class="empty">—</div>`}
    </div>`;
  }).join("");
}

function cardHTML(t) {
  const when = (t.started_at || t.created_at || "").slice(5, 16).replace("T", " ");
  return `<div class="card" onclick="openTask(${t.id})">
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">
      <span class="badge ${t.status}">${STATUS_LABEL[t.status]}</span>
      <span>${esc(t.agent_name || "未指派")}</span>
      <span>${when}</span>
    </div>
  </div>`;
}

async function openTask(id) {
  state.selected = id;
  const [task, logs] = await Promise.all([api(`/api/tasks/${id}`), api(`/api/tasks/${id}/logs`)]);
  const i = state.tasks.findIndex(t => t.id === id);
  if (i >= 0) state.tasks[i] = task;
  state.logs = logs;
  renderDetail(task);
}

function renderDetail(t) {
  const el = document.getElementById("detail");
  el.classList.remove("hidden");
  const status = t.status;
  let actions = "";
  if (["queued", "claimed", "running"].includes(status)) {
    actions += `<button class="btn danger" onclick="setTaskStatus(${t.id},'cancelled')">取消</button>`;
  }
  if (status === "awaiting_review") {
    actions += `<button class="btn primary" onclick="setTaskStatus(${t.id},'queued')">批准继续</button>`;
    actions += `<button class="btn" onclick="setTaskStatus(${t.id},'succeeded')">标记完成</button>`;
    actions += `<button class="btn danger" onclick="setTaskStatus(${t.id},'cancelled')">取消</button>`;
  }
  if (["succeeded", "failed", "cancelled"].includes(status)) {
    actions += `<button class="btn" onclick="setTaskStatus(${t.id},'queued')">重试</button>`;
  }
  actions += `<button class="btn danger" onclick="deleteTask(${t.id})">删除</button>`;
  actions += `<button class="btn" onclick="openSubTask(${t.id})">拆分子任务</button>`;
  if (t.body) actions += `<button class="btn" onclick="saveAsTemplate(${t.id})">保存为模板</button>`;

  el.innerHTML = `
    <div class="detail-head">
      <h3>#${t.id} ${esc(t.title)}</h3>
      <span class="badge ${t.status}">${STATUS_LABEL[t.status]}</span>
    </div>
    <div class="meta">
      角色：${esc(t.agent_name || "未指派")}　权限：${PERM_LABEL[t.perm] || t.perm}　
      目录：${esc(t.project_dir || "-")}　
      创建：${esc(t.created_at || "")}${t.review_rounds ? `　轮次：${t.review_rounds}` : ""}
    </div>
    ${t.error ? `<div class="meta" style="color:var(--red)">错误：${esc(t.error)}</div>` : ""}
    <div class="actions">${actions}</div>
    <div id="childrenBox"></div>
    ${t.status === "awaiting_review" ? `<div id="diffBox"><div class="empty">加载改动中...</div></div>` : ""}
    ${t.body ? `<div class="body">${esc(t.body)}</div>` : ""}
    <div class="logs" id="logBox">${logsHTML()}</div>`;
  const box = document.getElementById("logBox");
  box.scrollTop = box.scrollHeight;
  if (t.status === "awaiting_review") loadDiff(t.id);
  loadChildren(t.id);
}

async function loadChildren(id) {
  try {
    const kids = await api(`/api/tasks/${id}/children`);
    const box = document.getElementById("childrenBox");
    if (!box) return;
    if (!kids.length) return;
    const done = kids.filter(k => ["succeeded", "failed", "cancelled"].includes(k.status)).length;
    box.innerHTML = `<div class="meta" style="margin-top:6px">子任务 ${done}/${kids.length} 完成：</div>` +
      kids.map(k => `<div class="card" style="padding:6px 8px;margin:4px 0" onclick="openTask(${k.id})">
        <div class="card-meta"><span class="badge ${k.status}">${STATUS_LABEL[k.status]}</span>
        <span>${esc(k.title)}</span></div></div>`).join("");
  } catch (_) {}
}

function openSubTask(parentId) {
  fillAgentSelects();
  const t = state.tasks.find(x => x.id === parentId);
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = t ? t.perm : "full";
  document.getElementById("tParentId").value = parentId;
  document.getElementById("taskModalTitle").textContent = "拆分子任务";
  openModal("taskModal");
}

async function loadDiff(id) {
  try {
    const d = await api(`/api/tasks/${id}/diff`);
    const box = document.getElementById("diffBox");
    if (!box) return;
    const stat = d.stat.trim();
    const diff = d.diff.trim();
    if (!stat && !diff) {
      box.innerHTML = `<div class="meta">无文件改动或非 git 仓库${d.note ? "（" + esc(d.note) + "）" : ""}</div>`;
      return;
    }
    box.innerHTML = `<div class="meta" style="color:var(--green)">文件改动（git diff）：</div>
      <div class="logs" style="max-height:200px"><div class="line sys">${esc(stat)}</div></div>
      ${diff ? `<div class="logs" style="max-height:280px">${esc(diff).split("\n").map(l =>
        `<div class="line ${l.startsWith("+") && !l.startsWith("+++") ? "out" : l.startsWith("-") && !l.startsWith("---") ? "err" : "sys"}">${esc(l)}</div>`).join("")}</div>` : ""}`;
  } catch (e) {
    const box = document.getElementById("diffBox");
    if (box) box.innerHTML = `<div class="meta">diff 加载失败</div>`;
  }
}

function logsHTML() {
  return state.logs.map(l =>
    `<div class="line ${l.stream}">${esc(l.content)}</div>`).join("");
}

function appendLog(l) {
  if (state.selected !== l.task_id) return;
  state.logs.push(l);
  const box = document.getElementById("logBox");
  if (!box) return;
  box.insertAdjacentHTML("beforeend", `<div class="line ${l.stream}">${esc(l.content)}</div>`);
  box.scrollTop = box.scrollHeight;
}

async function refreshDetail() {
  if (!state.selected) return;
  try {
    const [task, logs] = await Promise.all([
      api(`/api/tasks/${state.selected}`), api(`/api/tasks/${state.selected}/logs`),
    ]);
    state.logs = logs;
    renderDetail(task);
  } catch (e) { /* 任务可能已删除 */ state.selected = null; }
}

/* ------------------------------------------------------------------ */
/* 任务操作 */

function openNewTask() {
  fillAgentSelects();
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
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

async function setTaskStatus(id, status) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  } catch (e) { toast(e.message, true); }
}

async function deleteTask(id) {
  if (!confirm(`删除任务 #${id}？执行日志将一并删除。`)) return;
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    if (state.selected === id) { state.selected = null; document.getElementById("detail").classList.add("hidden"); }
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

function fillAgentSelects() {
  const opts = state.agents.filter(a => a.enabled)
    .map(a => `<option value="${a.id}">${esc(a.name)}（${esc(a.cli)}）</option>`).join("");
  const tAgent = document.getElementById("tAgent");
  const sAgent = document.getElementById("sAgent");
  if (tAgent) tAgent.innerHTML = `<option value="">不指派</option>` + opts;
  if (sAgent) sAgent.innerHTML = opts;
}

/* ------------------------------------------------------------------ */
/* 设置页：角色 */

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
  const env = {};
  document.getElementById("aEnv").value.split("\n").forEach(line => {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
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
      env,
    },
  };
  try {
    if (id) await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
    closeModal("agentModal");
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

async function deleteAgent(id) {
  if (!confirm("删除该角色？未完成任务将失去指派。")) return;
  try {
    await api(`/api/agents/${id}`, { method: "DELETE" });
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

function agentHTML(a) {
  const rc = a.role_config || {};
  const bits = [a.cli, rc.model || "默认模型", rc.thinking ? "思考:" + rc.thinking : null]
    .filter(Boolean).join(" · ");
  return `<div class="item">
    <div class="item-main">
      <div class="item-title">${esc(a.name)} <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></div>
      <div class="item-sub">${esc(bits)}<br>目录：${esc(a.project_dir)}</div>
    </div>
    <div class="item-actions">
      <button class="btn small" onclick="openAgentModal(${a.id})">编辑</button>
      <button class="btn small danger" onclick="deleteAgent(${a.id})">删除</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 设置页：定时任务 */

function openScheduleModal(id) {
  fillAgentSelects();
  const sc = id ? state.schedules.find(x => x.id === id) : null;
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
  } catch (e) { toast(e.message, true); }
}

async function deleteSchedule(id) {
  if (!confirm("删除该定时任务？")) return;
  try {
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

function scheduleHTML(sc) {
  return `<div class="item">
    <div class="item-main">
      <div class="item-title">${esc(sc.name)} <span class="badge ${sc.enabled ? "succeeded" : "cancelled"}">${sc.enabled ? "启用" : "停用"}</span></div>
      <div class="item-sub">${esc(sc.cron)} → ${esc(sc.agent_name)}　上次：${esc(sc.last_run_at || "-")}</div>
    </div>
    <div class="item-actions">
      <button class="btn small" onclick="openScheduleModal(${sc.id})">编辑</button>
      <button class="btn small danger" onclick="deleteSchedule(${sc.id})">删除</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 数据清理 */

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    document.getElementById("retentionDays").value = s.retention_days || "";
  } catch (_) {}
}

/* 任务模板 */
async function loadTemplates() {
  try {
    state.templates = await api("/api/templates");
    const sel = document.getElementById("tTemplate");
    if (sel) sel.innerHTML = `<option value="">—</option>` + state.templates.map(t =>
      `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    const tl = document.getElementById("templateList");
    if (tl) tl.innerHTML = state.templates.map(t => `<div class="item">
      <div class="item-main">
        <div class="item-title">${esc(t.name)}</div>
        <div class="item-sub">${esc((t.body || "").slice(0, 80))}${(t.body || "").length > 80 ? "…" : ""}</div>
      </div>
      <div class="item-actions"><button class="btn small danger" onclick="deleteTemplate(${t.id})">删除</button></div>
    </div>`).join("") || `<div class="empty">还没有模板：在任务详情里点「保存为模板」沉淀常用提示词</div>`;
  } catch (_) {}
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
    await api("/api/templates", {
      method: "POST",
      body: JSON.stringify({ name, body: t.body, agent_id: t.agent_id }),
    });
    toast("已保存为模板");
    loadTemplates();
  } catch (e) { toast(e.message, true); }
}

async function deleteTemplate(id) {
  if (!confirm("删除该模板？")) return;
  try {
    await api(`/api/templates/${id}`, { method: "DELETE" });
    loadTemplates();
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
  const cond = (agentId ? "该角色" : "全部角色") + (before ? `、早于${days}天` : "");
  if (!confirm(`删除${cond}的所有终态历史任务？不可恢复！`)) return;
  try {
    const r = await api("/api/tasks/cleanup", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, before }),
    });
    toast(`已删除 ${r.deleted} 条历史`);
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

function fillCleanupAgent() {
  const sel = document.getElementById("cleanupAgent");
  if (!sel) return;
  sel.innerHTML = `<option value="">全部角色</option>` + state.agents.map(a =>
    `<option value="${a.id}">${esc(a.name)}</option>`).join("");
}

/* ------------------------------------------------------------------ */
/* 通用 */

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function sse() {
  const es = new EventSource(`/api/events${TOKEN ? "?token=" + encodeURIComponent(TOKEN) : ""}`);
  es.addEventListener("task", ev => {
    try {
      const d = JSON.parse(ev.data);
      const t = d.payload;
      const i = state.tasks.findIndex(x => x.id === t.id);
      if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
      renderBoard();
      if (state.selected === t.id) renderDetail(t);
    } catch (_) {}
  });
  es.addEventListener("log", ev => {
    try { appendLog(JSON.parse(ev.data).payload); } catch (_) {}
  });
  es.addEventListener("error", () => { /* 断线自动重连由 EventSource 处理 */ });
}

document.addEventListener("DOMContentLoaded", async () => {
  renderBoard();
  document.getElementById("detail").classList.add("hidden");
  try { await loadAll(); } catch (e) { toast("加载失败: " + e.message, true); }
  loadSettings();
  loadTemplates();
  sse();
});
