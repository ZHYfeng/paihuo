// 模块 dashboard（由 scripts/gen-globals.py 维护导入/导出）
import { ST_COLOR, api, esc, state } from "./core.js";
import { refreshOverview } from "./main.js";
import { openTask, rejectTask, setTaskStatus } from "./task.js";

export function dashCardHTML(t, actions) {
  return `<article class="card dash-card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">审批</span>` : ""}
    </div>
    <a class="c-title card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
    <div class="c-meta">
      ${t.project_name ? `<span class="chip">${esc(t.project_name)}</span>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm av-${esc(t.agent_name)}">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">未指派</span>`}
      </span>
    </div>
    ${actions ? `<div class="dash-actions" onclick="event.stopPropagation()">${actions}</div>` : ""}
  </article>`;
}

function dashEmpty(title, detail, action) {
  return `<div class="dash-empty">
    <span class="dash-empty-mark" aria-hidden="true"><i></i></span>
    <b>${title}</b><span>${detail}</span>
    ${action || ""}
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
    .sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 6);
  const review = state.tasks.filter(t => t.status === "awaiting_review")
    .sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 6);
  run.innerHTML = running.map(t => dashCardHTML(t)).join("") || dashEmpty(
    "执行队列已清空", "创建任务后，进度会在这里实时更新。",
    `<button type="button" class="btn xs" onclick="openNewTask()">派发任务</button>`);
  rev.innerHTML = review.map(t => dashCardHTML(t,
    `<button class="btn xs brand" onclick="setTaskStatus(${t.id},'succeeded')">通过并合并</button>` +
    `<button class="btn xs" onclick="rejectTask(${t.id})">驳回</button>` +
    `<button class="btn xs" onclick="openTask(${t.id})">查看详情</button>`)).join("") || dashEmpty(
      "当前无需审批", "需要人工确认的交付会集中出现在这里。",
      `<a class="btn xs" href="/history">查看历史</a>`);
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
      <div class="ob-title">开始第一次交付</div>
      <a class="ob-step" href="/agents"><b>01</b><span>配置本机智能体</span></a>
      <a class="ob-step" href="/roles"><b>02</b><span>创建任务角色</span></a>
      <a class="ob-step" href="/projects"><b>03</b><span>建立项目工作区</span></a>
      <a class="ob-step" href="/board"><b>04</b><span>派发首个任务</span></a>
    </div>`;
    return;
  }
  const ranked = active.map(p => {
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const done = ts.filter(t => t.status === "succeeded").length;
    const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
    const inflight = ts.filter(t => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
    return { p, ts, pct, inflight };
  }).sort((a, b) => b.inflight - a.inflight || a.p.name.localeCompare(b.p.name, "zh-CN"));
  const visible = ranked.slice(0, 4);
  box.innerHTML = visible.map(({ p, ts, pct, inflight }) => {
    return `<a class="dash-proj" href="/projects#/project/${p.id}">
      <div class="dp-top"><b title="${esc(p.name)}">${esc(p.name)}</b>
        ${inflight ? `<span class="badge running">${inflight} 活跃</span>` : `<span class="badge">${ts.length} 任务</span>`}</div>
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${pct}%</span></div>
    </a>`;
  }).join("") + (ranked.length > visible.length
    ? `<a class="dash-more" href="/projects">查看其余 ${ranked.length - visible.length} 个项目 <span aria-hidden="true">→</span></a>` : "");
}

export async function loadDashAgents() {
  try {
    const prov = await api("/api/provision");
    const box = document.getElementById("dashAgents");
    if (!box) return;
    const installed = prov.filter(p => p.installed);
    const agents = state.agents || [];
    box.innerHTML = `
      <div class="dash-prov">
        ${prov.map(p => `<span class="prov-chip ${p.installed ? "ok" : ""} ${p.login ? "login" : ""}" title="${esc(p.name)}${p.installed ? " " + esc(p.version) : " — 未安装"}${p.installed && !p.login ? "（未登录）" : ""}"><i aria-hidden="true"></i>${esc(p.name)}<span class="sr-only">${p.installed ? (p.login ? "已安装并登录" : "已安装，未登录") : "未安装"}</span></span>`).join("")}
      </div>
      <div class="dash-prov-meta">
        <span><b>${installed.length}/${prov.length}</b> 已安装</span>
        <span><b>${agents.filter(a => a.enabled).length}</b> 角色启用</span>
      </div>`;
  } catch (_) {}
}

/* ============================================================
   Agents 页：安装/登录管理
   ============================================================ */
