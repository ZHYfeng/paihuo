// 模块 task（由 scripts/split-frontend.py 生成）
import { BOARD_COLS, PERM_LABEL, STATUS_LABEL, ST_COLOR, api, closeModal, esc, icon, openModal, state, toast } from "./core.js";
import { loadDashboard } from "./dashboard.js";
import { loadHistory } from "./history.js";
import { fillSelects, loadAll, refreshOverview } from "./main.js";
import { refreshProjectDetail } from "./projects.js";
import { loadTemplates } from "./skills.js";
import { openTerminal, sendTaskInput, term, termWrite } from "./terminal.js";

// 任务详情是全站共享的视图。打开时只临时隐藏当前页面原本可见的直属内容，
// 关闭后精确恢复，避免破坏项目/角色页自身的列表与详情切换状态。
let detailBackground = null;
let detailReturnHash = "#/";

export function currentFilters() {
  return {
    agent: Number(document.getElementById("fAgent")?.value) || null,
    project: Number(document.getElementById("fProject")?.value) || null,
    status: document.getElementById("fStatus")?.value || "",
  };
}

export function filteredTasks() {
  const f = currentFilters();
  return state.tasks.filter(t => {
    if (f.agent && t.agent_id !== f.agent) return false;
    if (f.project && t.project_id !== f.project) return false;
    if (f.status && t.status !== f.status) return false;
    return true;
  });
}

export function renderBoard() {
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

export function cardHTML(t) {
  return `<div class="card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">审批</span>` : ""}
      ${t.run_mode === "interactive" ? `<span class="chip">交互</span>` : ""}
      ${t.concurrent ? `<span class="chip">并发</span>` : ""}
      ${t.review_rounds > 0 ? `<span class="chip">第${t.review_rounds}轮</span>` : ""}
    </div>
    <div class="c-title">${esc(t.title)}</div>
    ${t.body ? `<div class="c-desc">${esc(t.body)}</div>` : ""}
    <div class="c-meta">
      ${t.project_id && t.project_name ? `<a class="chip chip-link" href="/projects#/project/${t.project_id}" title="打开项目页" onclick="event.stopPropagation()">${esc(t.project_name)}</a>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">未指派</span>`}
        ${t.error ? `<span style="color:var(--danger)">✗</span>` : ""}
      </span>
    </div>
  </div>`;
}

export function renderList() {
  const el = document.getElementById("listBody");
  if (!el) return;
  const tasks = filteredTasks();
  el.innerHTML = tasks.map(t => `
    <tr onclick="openTask(${t.id})">
      <td class="num">#${t.id}</td>
      <td class="t-title">${esc(t.title)}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${t.project_id ? `<a class="t-link" href="/projects#/project/${t.project_id}" onclick="event.stopPropagation()">${esc(t.project_name || "-")}</a>` : esc(t.project_name || "-")}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="event.stopPropagation();openTask(${t.id})">${icon("expand")}详情</button>
          ${canRetryTask(t)
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

export function setView(v) {
  state.view = v;
  document.getElementById("segBoard").classList.toggle("active", v === "board");
  document.getElementById("segList").classList.toggle("active", v === "list");
  document.getElementById("boardView").classList.toggle("hidden", v !== "board");
  document.getElementById("listView").classList.toggle("hidden", v !== "list");
  if (v === "list") renderList(); else renderBoard();
}

export function applyFilters() {
  const pl = document.getElementById("fProjectLink");
  const pv = Number(document.getElementById("fProject")?.value) || null;
  if (pl) {
    if (pv) { pl.href = `/projects#/project/${pv}`; pl.style.display = ""; }
    else pl.style.display = "none";
  }
  state.view === "list" ? renderList() : renderBoard();
}

/* ============================================================
   任务详情（两栏）
   ============================================================ */

export function openTask(id) {
  if (!/^#\/issue\/\d+$/.test(location.hash)) detailReturnHash = location.hash || "#/";
  location.hash = "#/issue/" + id;
}

export function closeDetail() {
  const back = detailReturnHash || "#/";
  detailReturnHash = "#/";
  location.hash = back;
}

export function showDetail(id) {
  state.selected = id;
  const main = document.querySelector(".main");
  const detailShell = document.getElementById("detailShell");
  if (!detailShell) return;
  // 详情两栏页接管主区。项目、角色等页面也各有自己的详情壳，不能只按
  // board/dashboard 的 id 隐藏；记录本来可见的直属元素，返回时原样恢复。
  if (detailBackground === null) {
    detailBackground = [];
    for (const child of main?.children || []) {
      if (child === detailShell || child.classList.contains("hidden")) continue;
      child.classList.add("hidden");
      detailBackground.push(child);
    }
  }
  detailShell.classList.remove("hidden");
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    document.getElementById("dCrumb").innerHTML = `任务 / <b>#${t.id}</b>`;
    document.getElementById("dBadge").innerHTML =
      `<span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>`;
  }
  refreshDetail();
}

export function hideDetail() {
  document.getElementById("detailShell")?.classList.add("hidden");
  for (const child of detailBackground || []) child.classList.remove("hidden");
  detailBackground = null;
  state.selected = null;
}

export async function refreshDetail() {
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

export function renderDetail(t) {
  const main = document.getElementById("dMain");
  if (!main) return;
  const isInteractive = t.run_mode === "interactive" && t.status === "running";
  const input = isInteractive ? `<div class="term-input detail-input">
      <input id="taskInput" autocomplete="off" aria-label="发送给 Pi 的消息" placeholder="发送消息给 Pi（Enter 发送）" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();sendTaskInput(${t.id},'taskInput')}">
      <button class="btn primary" onclick="sendTaskInput(${t.id},'taskInput')">发送</button>
    </div>` : "";
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
      ${input}
    </div>`;
  const box = document.getElementById("logBox");
  if (box) box.scrollTop = box.scrollHeight;
  if (t.status === "awaiting_review") loadDiff(t.id);
  loadChildren(t.id);
  loadWorkspace(t.id);
  renderSide(t);
}

/* ---- 工作空间（git worktree 隔离） ---- */

export async function loadWorkspace(id) {
  const box = document.getElementById("wsBox");
  if (!box) return;
  try {
    const w = await api(`/api/workspace/${id}`);
    const t = state.tasks.find(x => x.id === id) || {};
    const done = ["succeeded", "failed", "cancelled"].includes(t.status);
    const isMergeTask = !!t.merge_of;
    const canManualMerge = isMergeTask && ["succeeded", "failed"].includes(t.status);
    const sourceAwaitingMerge = !isMergeTask && t.status === "succeeded";
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
      (done ? `<div class="ws-actions">` +
        (canManualMerge ? `<button class="btn sm brand" onclick="wsMerge(${id})">合并回主分支</button>` :
          `<span class="ws-val">代码由系统创建的合并任务写入主分支</span>`) +
        (sourceAwaitingMerge ? "" : `<button class="btn sm danger" onclick="wsDiscard(${id})">丢弃</button>`) +
      `</div>` : "");
  } catch (_) { box.innerHTML = `<div class="empty">工作空间信息不可用</div>`; }
}

export async function wsMerge(id) {
  if (!confirm(`把任务 #${id} 的改动 squash 合并回主分支？`)) return;
  try {
    const r = await api(`/api/workspace/${id}/merge`, { method: "POST" });
    toast(`已合并${r.commit ? " (" + r.commit + ")" : ""}`);
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

export async function wsDiscard(id) {
  if (!confirm(`丢弃任务 #${id} 的工作空间？分支与 worktree 将删除，改动不可恢复。`)) return;
  try {
    await api(`/api/workspace/${id}/discard`, { method: "POST" });
    toast("已丢弃");
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

export async function gitInitProject(path, id) {
  if (!confirm(`在 ${path} 初始化 git 仓库？之后的任务将获得独立 worktree。`)) return;
  try {
    await api("/api/workspace/git-init", { method: "POST", body: JSON.stringify({ path }) });
    toast("已初始化");
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

export function renderSide(t) {
  const side = document.getElementById("dSide");
  if (!side) return;
  const statusOpts = Object.keys(STATUS_LABEL).map(s =>
    `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
  // 和新建任务保持一致：只能新指派启用中的角色；但若当前角色后来被
  // 停用，仍保留该选项，避免详情页显示为空、也方便改派到其他角色。
  const agentOpts = `<option value="">不指派</option>` + state.agents
    .filter(a => a.enabled || a.id === t.agent_id)
    .map(a => `<option value="${a.id}" ${a.id === t.agent_id ? "selected" : ""}>${esc(a.name)}</option>`)
    .join("");
  const pOpts = `<option value="">无项目</option>` + state.projects.map(p =>
    `<option value="${p.id}" ${t.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  let actions = "";
  if (["queued", "claimed", "running"].includes(t.status)) {
    actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}取消任务</button>`;
  }
  if (t.run_mode === "interactive" && t.status === "running") {
    actions += `<button class="btn sm" onclick="endInteractiveTask(${t.id})">${icon("terminal")}结束会话</button>`;
  }
  if (t.status === "awaiting_review") {
    actions += `<button class="btn sm brand" onclick="setTaskStatus(${t.id},'succeeded')">${icon("check")}通过并派发合并</button>`;
    actions += `<button class="btn sm" onclick="rejectTask(${t.id})">${icon("retry")}驳回重做</button>`;
    actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}取消</button>`;
  }
  if (canRetryTask(t)) {
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
    <div class="prop-row"><span class="k">角色</span>
      <span class="v"><select aria-label="任务角色" onchange="patchTask(${t.id},{agent_id:Number(this.value)||null})">${agentOpts}</select></span></div>
    <div class="prop-row"><span class="k">权限</span><span class="v">${PERM_LABEL[t.perm] || t.perm}</span></div>
    <div class="prop-row"><span class="k">方式</span><span class="v">${t.run_mode === "interactive" ? "交互式 Pi" : "批处理 · -p"}</span></div>
    <div class="prop-row"><span class="k">并发</span>
      <span class="v"><select onchange="patchTask(${t.id},{concurrent:this.value==='1'})">
        <option value="0" ${t.concurrent ? "" : "selected"}>串行（默认）</option>
        <option value="1" ${t.concurrent ? "selected" : ""}>并发</option>
      </select></span></div>
    <div class="prop-row"><span class="k">执行器</span><span class="v">tmux · ${["claimed", "running"].includes(t.status) ? `paihuo:task-${t.id}` : "日志已归档"}</span></div>
    <div class="prop-row"><span class="k">目录</span><span class="v" style="font-size:12px;word-break:break-all">${esc(t.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">轮次</span><span class="v">${t.review_rounds || "-"}</span></div>
    <div class="prop-row"><span class="k">开始</span><span class="v">${esc((t.started_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="prop-row"><span class="k">结束</span><span class="v">${esc((t.finished_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">操作</div>
    <div class="detail-actions">${actions}</div>`;
}

export async function patchTask(id, set) {
  try {
    const task = await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(set) });
    const i = state.tasks.findIndex(t => t.id === task.id);
    if (i >= 0) state.tasks[i] = task; else state.tasks.unshift(task);
    if (state.selected === id) renderDetail(task);
    if (location.pathname === "/board") {
      state.view === "list" ? renderList() : renderBoard();
    } else if (location.pathname === "/") {
      loadDashboard();
    } else if (location.pathname === "/history") {
      loadHistory();
    } else if (location.pathname === "/projects" && state.projectView) {
      refreshProjectDetail();
    }
    toast("已更新");
  } catch (e) { toast(e.message, true); }
}

export async function setTaskStatus(id, status) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (status === "succeeded") toast("已审批，代码合并任务已派发");
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

export async function endInteractiveTask(id) {
  if (!confirm("向 Pi 发送 /exit 并结束交互会话？任务会按正常退出结果结算。")) return;
  if (await sendTaskInput(id, "", "/exit")) {
    toast("已发送 /exit，等待 Pi 退出");
  }
}

export async function rejectTask(id) {
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

export async function deleteTask(id) {
  if (!confirm(`删除任务 #${id}？执行日志、worktree、任务分支及其合并子任务将一并删除。`)) return;
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast("已删除");
    await loadAll();
    const p = location.pathname;
    if (state.selected === id) closeDetail();
    if (p === "/history") loadHistory();
    if (p === "/projects" && state.projectView) refreshProjectDetail();
    if (p === "/") loadDashboard();
    if (p === "/board") { renderBoard(); renderList(); }
  } catch (e) { toast(e.message, true); }
}

export function canRetryTask(t) {
  if (!["succeeded", "failed", "cancelled"].includes(t.status)) return false;
  return !(t.status === "succeeded" && !t.merge_of && state.tasks.some(child => child.merge_of === t.id));
}

/* 子任务 */
export async function loadChildren(id) {
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

export function openSubTask(parentId) {
  fillSelects();
  const t = state.tasks.find(x => x.id === parentId);
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = t ? t.perm : "full";
  document.getElementById("tRunMode").value = "batch";
  document.getElementById("tConcurrent").checked = false;
  document.getElementById("tProject").value = t && t.project_id ? t.project_id : "";
  document.getElementById("tParentId").value = parentId;
  document.getElementById("taskModalTitle").textContent = "拆分子任务";
  syncTaskRunMode();
  openModal("taskModal");
}

/* ---- 续跑：原任务继续 ---- */

export async function resumeTask(id) {
  if (!confirm(`继续任务 #${id}？将保留任务编号、任务会话目录、工作空间和历史记录，重新排队执行。`)) return;
  try {
    const t = await api(`/api/tasks/${id}/resume`, { method: "POST" });
    toast(`任务 #${t.id} 已在原任务中重新排队`);
    await loadAll();
    openTask(t.id);
    if (state.selected === t.id) showDetail(t.id);
  } catch (e) { toast(e.message, true); }
}

/* diff */
export async function loadDiff(id) {
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
export function tsOf(l) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(l.created_at || "");
  return m ? m[1] : "";
}

export function logLineHTML(l) {
  return `<div class="line"><span class="ts">${tsOf(l)}</span><span class="c ${l.stream}">${esc(l.content)}</span></div>`;
}

export function logsHTML() {
  return state.logs.map(logLineHTML).join("");
}

export function appendLog(l) {
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

export async function copyLogs() {
  try {
    await navigator.clipboard.writeText(state.logs.map(l => l.content).join("\n"));
    toast("已复制对话内容");
  } catch (_) { toast("复制失败", true); }
}

/* ---- 全屏终端（xterm.js 渲染：ANSI 颜色 / 真实终端感） ---- */
export function openNewTask() {
  fillSelects();
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = "full";
  document.getElementById("tRunMode").value = "batch";
  document.getElementById("tConcurrent").checked = false;
  document.getElementById("tProject").value = "";
  document.getElementById("tParentId").value = "";
  document.getElementById("taskModalTitle").textContent = "新建任务";
  syncTaskRunMode();
  openModal("taskModal");
}

// 项目页直接派活：打开新建任务弹窗并预选项目
// （当前项目状态 active 才允许派活，已归档项目不提供入口）
export function openProjectTask(projectId) {
  const p = state.projects.find(x => x.id === projectId);
  fillSelects();
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = "full";
  document.getElementById("tRunMode").value = "batch";
  document.getElementById("tConcurrent").checked = false;
  document.getElementById("tProject").value = projectId;
  document.getElementById("tParentId").value = "";
  document.getElementById("taskModalTitle").textContent = p ? `新建任务 · ${esc(p.name)}` : "新建任务";
  syncTaskRunMode();
  openModal("taskModal");
}

// 交互式是任务级能力，但当前仅 Pi 支持。前端即时说明限制，服务端会再次
// 验证，避免手写请求绕过。
export function syncTaskRunMode() {
  const agentID = Number(document.getElementById("tAgent")?.value) || 0;
  const agent = state.agents.find(a => a.id === agentID);
  const isPi = agent?.cli === "pi";
  const select = document.getElementById("tRunMode");
  const help = document.getElementById("tRunModeHelp");
  if (!select) return;
  const interactive = select.querySelector('option[value="interactive"]');
  if (interactive) interactive.disabled = !isPi;
  if (!isPi && select.value === "interactive") select.value = "batch";
  if (help) {
    help.textContent = isPi
      ? "批处理会自动结算；交互式会保留 Pi 终端，直到你发送 /exit。"
      : "批处理会自动结算；交互式目前仅支持 Pi 角色。";
  }
}

export async function submitTask() {
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
        run_mode: document.getElementById("tRunMode").value,
        concurrent: document.getElementById("tConcurrent").checked,
        parent_id: parentId,
      }),
    });
    closeModal("taskModal");
    toast("任务已创建");
    await loadAll();
    renderBoard(); renderList();
    refreshOverview();
    if (location.pathname === "/projects" && state.projectView) refreshProjectDetail();
  } catch (e) { toast(e.message, true); }
}

export function applyTemplate() {
  const t = state.templates.find(x => x.id === Number(document.getElementById("tTemplate").value));
  if (!t) return;
  document.getElementById("tBody").value = t.body || "";
  if (t.agent_id) document.getElementById("tAgent").value = t.agent_id;
  syncTaskRunMode();
}

export async function saveAsTemplate(taskId) {
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
