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
  if (state.selected) refreshDetail();
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
  if (["queued", "claimed", "running", "awaiting_review"].includes(status)) {
    actions += `<button class="btn danger" onclick="setTaskStatus(${t.id},'cancelled')">取消</button>`;
  }
  if (status === "awaiting_review") {
    actions += `<button class="btn primary" onclick="setTaskStatus(${t.id},'running')">批准继续</button>`;
  }
  if (["succeeded", "failed", "cancelled"].includes(status)) {
    actions += `<button class="btn" onclick="setTaskStatus(${t.id},'queued')">重试</button>`;
  }
  actions += `<button class="btn danger" onclick="deleteTask(${t.id})">删除</button>`;

  el.innerHTML = `
    <div class="detail-head">
      <h3>#${t.id} ${esc(t.title)}</h3>
      <span class="badge ${t.status}">${STATUS_LABEL[t.status]}</span>
    </div>
    <div class="meta">
      角色：${esc(t.agent_name || "未指派")}　权限：${PERM_LABEL[t.perm] || t.perm}　
      目录：${esc(t.project_dir || "-")}　
      创建：${esc(t.created_at || "")}
    </div>
    ${t.error ? `<div class="meta" style="color:var(--red)">错误：${esc(t.error)}</div>` : ""}
    <div class="actions">${actions}</div>
    ${t.body ? `<div class="body">${esc(t.body)}</div>` : ""}
    <div class="logs" id="logBox">${logsHTML()}</div>`;
  const box = document.getElementById("logBox");
  box.scrollTop = box.scrollHeight;
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
  openModal("taskModal");
}

async function submitTask() {
  const title = document.getElementById("tTitle").value.trim();
  if (!title) return toast("标题不能为空", true);
  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: document.getElementById("tBody").value,
        agent_id: Number(document.getElementById("tAgent").value) || null,
        perm: document.getElementById("tPerm").value,
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

function openScheduleModal() {
  fillAgentSelects();
  document.getElementById("sId").value = "";
  document.getElementById("sName").value = "";
  document.getElementById("sCron").value = "0 9 * * *";
  document.getElementById("sTitle").value = "";
  document.getElementById("sBody").value = "";
  document.getElementById("sEnabled").checked = true;
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
      <button class="btn small" onclick="deleteSchedule(${sc.id})">删除</button>
    </div>
  </div>`;
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
  sse();
});
