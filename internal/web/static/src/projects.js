// 模块 projects（由 scripts/split-frontend.py 生成）
import { STATUS_LABEL, ST_COLOR, api, closeModal, esc, fmtDur, fmtPct, icon, openModal, state, toast } from "./core.js";
import { loadAll } from "./main.js";
import { deleteTask, setTaskStatus } from "./task.js";
import { openTerminal } from "./terminal.js";

export function renderProjectList() {
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

export function openProject(id) { location.hash = "#/project/" + id; }

export function closeProjectDetail() { location.hash = "#/"; }

export function showProjectDetail(id) {
  state.projectView = id;
  document.getElementById("projectListShell").classList.add("hidden");
  document.getElementById("projectDetailShell").classList.remove("hidden");
  refreshProjectDetail();
}

export function hideProjectDetail() {
  document.getElementById("projectDetailShell").classList.add("hidden");
  document.getElementById("projectListShell").classList.remove("hidden");
  state.projectView = null;
}

export async function refreshProjectDetail() {
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

export function renderProjectDetail(p, s, tasks) {
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

    <div class="sec-title" style="display:flex;align-items:center;justify-content:space-between">
      <span>任务 ${tasks.length}</span>
      <button class="btn sm brand" onclick="openProjectTask(${p.id})">${icon("plus")}新建任务</button>
    </div>
    <div class="p-task-list">
      ${rowHTML || `<div class="empty">还没有任务
        <button class="btn xs brand" style="margin-left:8px" onclick="openProjectTask(${p.id})">${icon("plus")}派活</button></div>`}
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
      <button class="btn sm brand" onclick="openProjectTask(${p.id})">${icon("plus")}新建任务</button>
      <button class="btn sm" onclick="openProjectModal(${p.id})">编辑</button>
      <button class="btn sm danger" onclick="deleteProject(${p.id})">删除</button>
    </div>`;
}

export function openProjectModal(id) {
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

export async function submitProject() {
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

export async function patchProject(id, set) {
  try {
    await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(set) });
    await loadAll();
    if (state.projectView === id) refreshProjectDetail();
    renderProjectList();
    toast("已更新");
  } catch (e) { toast(e.message, true); }
}

export async function deleteProject(id) {
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

export function dailyChartHTML(daily, days) {
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

export function ringHTML(pct, label) {
  const deg = Math.round(Math.min(100, pct) * 3.6);
  return `<div class="ring" style="background:conic-gradient(var(--brand) ${deg}deg, rgba(255,255,255,.09) 0)">
    <div class="ring-inner"><b>${fmtPct(pct)}</b><span>${label}</span></div>
  </div>`;
}

export function statusBarHTML(counts) {
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

export const dirState = { inputId: null, path: "" };

export async function dirLoad(path) {
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

export function openDirPicker(inputId) {
  dirState.inputId = inputId;
  const cur = (document.getElementById(inputId).value || "").trim();
  document.getElementById("dirNewName").value = "";
  dirLoad(cur || ""); // 空路径 → 家目录
  openModal("dirModal");
}

export function pickDir() {
  const input = document.getElementById(dirState.inputId);
  if (input) input.value = dirState.path;
  closeModal("dirModal");
  toast("已选择目录");
}

export async function mkdirCurrent() {
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
export async function loadProjDatalist() {
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