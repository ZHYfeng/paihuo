// 模块 dashboard（由 scripts/split-frontend.py 生成）
import { ST_COLOR, api, esc, state } from "./core.js";
import { refreshOverview } from "./main.js";
import { openTask, rejectTask, setTaskStatus } from "./task.js";
import { openTerminal } from "./terminal.js";

export function dashCardHTML(t, actions) {
  return `<div class="card dash-card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
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

export function loadDashboard() {
  refreshOverview();
  renderDashTasks();
  renderDashProjects();
  loadDashAgents();
}

export function renderDashTasks() {
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

export function renderDashProjects() {
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

export async function loadDashAgents() {
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
