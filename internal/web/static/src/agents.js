// 模块 agents（由 scripts/gen-globals.py 维护导入/导出）
import { STATUS_LABEL, ST_COLOR, api, esc, fmtDur, fmtPct, icon, state, toast } from "./core.js";
import { loadAll, loadSchema } from "./main.js";
import { dailyChartHTML, openProject, statusBarHTML } from "./projects.js";
import { openTask } from "./task.js";

export let dlSeq = 0;

export const AGENT_SORT_OPTIONS = [
  ["name-asc", "名称 A-Z"],
  ["name-desc", "名称 Z-A"],
  ["created-desc", "最近创建"],
  ["created-asc", "最早创建"],
  ["cli-asc", "CLI A-Z"],
  ["model-asc", "模型 A-Z"],
  ["concurrency-desc", "最大并发：高到低"],
  ["concurrency-asc", "最大并发：低到高"],
  ["tasks-desc", "任务数：多到少"],
  ["tasks-asc", "任务数：少到多"],
  ["status-enabled", "启用状态优先"],
];

function normalizeAgentSort(sort) {
  return AGENT_SORT_OPTIONS.some(([value]) => value === sort) ? sort : "name-asc";
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareAgentValues(a, b, sort, stats) {
  switch (sort) {
    case "name-asc": return compareText(a.name, b.name);
    case "name-desc": return compareText(b.name, a.name);
    case "created-desc": return compareText(b.created_at, a.created_at);
    case "created-asc": return compareText(a.created_at, b.created_at);
    case "cli-asc": return compareText(a.cli, b.cli);
    case "model-asc": return compareText(a.role_config?.model, b.role_config?.model);
    case "concurrency-desc": return (b.max_concurrency || 1) - (a.max_concurrency || 1);
    case "concurrency-asc": return (a.max_concurrency || 1) - (b.max_concurrency || 1);
    case "tasks-desc": return stats(b).total - stats(a).total;
    case "tasks-asc": return stats(a).total - stats(b).total;
    case "status-enabled": return Number(b.enabled) - Number(a.enabled);
    default: return 0;
  }
}

export function sortAgents(list, sort = state.agentSort) {
  const normalized = normalizeAgentSort(sort);
  const stats = new Map();
  const getStats = a => {
    if (!stats.has(a.id)) stats.set(a.id, agentTaskStats(a));
    return stats.get(a.id);
  };
  return [...list].sort((a, b) =>
    compareAgentValues(a, b, normalized, getStats)
      || compareText(a.name, b.name)
      || Number(a.id || 0) - Number(b.id || 0));
}

export function setAgentSort(sort) {
  state.agentSort = normalizeAgentSort(sort);
  const select = document.getElementById("agentSort");
  if (select && select.value !== state.agentSort) select.value = state.agentSort;
  try { localStorage.setItem("paihuo.agentSort", state.agentSort); } catch (_) {}
  renderAgentList();
}

export function setAgentView(v) {
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

export function agentTaskStats(a) {
  const ts = state.tasks.filter(t => t.agent_id === a.id);
  return {
    total: ts.length,
    inFlight: ts.filter(t => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length,
    review: ts.filter(t => t.status === "awaiting_review").length,
  };
}

export function filteredAgents() {
  const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
  const list = state.agents.filter(a => {
    if (!q) return true;
    const rc = a.role_config || {};
    return [a.name, a.description, a.cli, rc.model]
      .some(value => String(value || "").toLowerCase().includes(q));
  });
  return { list: sortAgents(list), query: q };
}

export function renderAgentEmpty(list, query) {
  const empty = document.getElementById("agentEmpty");
  if (!empty) return;
  if (!list.length) {
    empty.innerHTML = query
      ? `<b class="empty-title">没有符合条件的角色</b>
        <span class="empty-copy">尝试清除搜索词，查看全部任务角色。</span>
        <button type="button" class="btn sm" onclick="document.getElementById('aSearch').value='';renderAgentList()">清除搜索</button>`
      : `<b class="empty-title">创建第一个任务角色</b>
        <span class="empty-copy">角色把一个本机 CLI、模型、技能与并发策略组合为可复用的执行配置。</span>
        <button type="button" class="btn brand sm" onclick="openRoleStudio()">创建角色</button>`;
  }
  empty.classList.toggle("hidden", list.length > 0);
}

export function agentActionsHTML(a) {
  return `
    <button class="btn xs" title="打开唯一角色编辑器，编辑配置并测试角色" onclick="event.stopPropagation();openRoleStudio(${a.id})">编辑</button>
    <button class="btn xs" title="复制此角色的配置，创建一个新角色" aria-label="复制角色 ${esc(a.name)}" onclick="event.stopPropagation();copyRole(${a.id})">${icon("copy")}复制</button>
    <button class="btn xs" title="${a.enabled ? "停用" : "启用"}角色" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
    <button class="btn xs danger" title="删除角色" aria-label="删除角色 ${esc(a.name)}" onclick="event.stopPropagation();deleteAgent(${a.id})">${icon("trash")}<span class="agent-list-mobile-action-label">删除</span></button>`;
}

export function renderAgentGrid() {
  const grid = document.getElementById("agentGrid");
  if (!grid) return;
  const { list, query } = filteredAgents();
  grid.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    const st = agentTaskStats(a);
    return `<article class="agent-card" data-agent-id="${a.id}" tabindex="0" onclick="openAgentDetail(${a.id})" onkeydown="if(event.target.closest('a,button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openAgentDetail(${a.id})}">
      <div class="ac-top">
        <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <a class="ac-name card-primary-action" href="#/agent/${a.id}" onclick="event.stopPropagation()">${esc(a.name)}</a>
          <div class="ac-sub">${esc(a.description || "未设置描述")}</div>
        </div>
        <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span>
      </div>
      <div class="ac-meta">
        <span class="chip">${esc(a.cli)}</span>
        <span class="chip" title="${esc(rc.model || "默认模型")}">${esc(rc.model || "默认模型")}</span>
        <span class="chip" title="同一角色最多同时运行的任务数">并发 ${esc(String(a.max_concurrency || 1))}</span>
      </div>
      <div class="ac-stats">
        <span><b>${st.total}</b> 任务</span>
        <span><b style="color:var(--st-running)">${st.inFlight}</b> 进行中</span>
        <span><b style="color:var(--st-review)">${st.review}</b> 待审批</span>
      </div>
      <div class="ac-ops">${agentActionsHTML(a)}</div>
    </article>`;
  }).join("");
  renderAgentEmpty(list, query);
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

export function renderAgentTable() {
  const body = document.getElementById("agentList");
  if (!body) return;
  const { list, query } = filteredAgents();
  body.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    return `<tr class="agent-list-row" tabindex="0" onclick="openAgentDetail(${a.id})" onkeydown="if(event.target.closest('a,button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openAgentDetail(${a.id})}">
      <td class="agent-list-identity">
        <span class="agent-list-main">
          <span class="avatar av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
          <span class="agent-list-copy">
            <a class="table-primary-action" href="#/agent/${a.id}" onclick="event.stopPropagation()">${esc(a.name)}</a>
            <span class="agent-list-description">${esc(a.description || "未设置描述")}</span>
          </span>
        </span>
      </td>
      <td class="agent-list-cli" data-label="CLI"><span class="badge">${esc(a.cli)}</span></td>
      <td class="agent-list-model" data-label="模型">${esc(rc.model || "默认")}</td>
      <td class="agent-list-concurrency num" data-label="最大并发">${esc(String(a.max_concurrency || 1))}</td>
      <td class="agent-list-status" data-label="状态"><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></td>
      <td class="agent-list-actions" data-label="操作">
        <span class="ops">${agentActionsHTML(a)}</span>
      </td>
    </tr>`;
  }).join("");
  renderAgentEmpty(list, query);
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

export function renderAgentList() {
  state.agentView === "grid" ? renderAgentGrid() : renderAgentTable();
}

// refreshAgentCatalog 只刷新 Linux 主机发现的 CLI 模型/能力目录；不会修改
// SQLite 中已创建角色或其未保存的表单内容。已打开的配置表单保留输入，重新
// 打开时会使用新目录，避免刷新按钮造成意外丢失。
export async function refreshAgentCatalog() {
  const btn = document.getElementById("refreshAgentCatalog");
  const original = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.textContent = "检测中…"; }
  try {
    await loadSchema(true);
    toast("已从 Linux 主机刷新模型与能力目录");
  } catch (e) {
    toast("刷新主机能力失败：" + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

export async function toggleAgent(id) {
  const a = state.agents.find(x => x.id === id);
  if (!a) return;
  try {
    await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
    await loadAll();
    renderAgentList();
  } catch (e) { toast(e.message, true); }
}

/* ---- 角色详情 ---- */
export function openAgentDetail(id) { location.hash = "#/agent/" + id; }

export function closeAgentDetail() { location.hash = "#/"; }

export function showAgentDetail(id) {
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

export function hideAgentDetail() {
  document.getElementById("agentDetailShell").classList.add("hidden");
  document.getElementById("agentListShell").classList.remove("hidden");
  state.agentEditing = null;
}

export function agentTab(name) {
  if (name !== "overview" && name !== "stats") name = "overview";
  state.agentTab = name;
  document.querySelectorAll("#agentTabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  const a = state.agentEditing;
  if (!a) return;
  const form = document.getElementById("agentForm");
  if (name === "overview") renderAgentOverview(a);
  else if (name === "stats") renderAgentStats(a);
}

export async function loadAgentStats(a) {
  if (!state.agentStats[a.id]) {
    try { state.agentStats[a.id] = await api(`/api/stats/agent/${a.id}`); } catch (_) {}
  }
  return state.agentStats[a.id];
}

export async function renderAgentOverview(a) {
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
        <div class="ah-sub">执行池：
          <input id="aMaxConc" class="conc-input" type="number" min="1" step="1" inputmode="numeric"
            value="${esc(String(a.max_concurrency || 1))}" aria-label="最大并发"
            onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();saveAgentConcurrency()}">
          个任务
          <button class="btn xs primary" onclick="saveAgentConcurrency()">更新并发</button>
          <span class="count-info">同时最多运行的任务数，每个任务独占 tmux/会话/Git worktree</span>
        </div>
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
              <tr ${ps.project_id > 0 ? `onclick="openProject(${ps.project_id})"` : ""}>
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
        <div class="p-task-row" onclick="openTask(${t.id})">
          <span class="num">#${t.id}</span>
          <a class="t card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
          <span class="a">${esc(t.project_name || "-")}</span>
          <span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>
        </div>`).join("") || `<div class="empty">还没有任务</div>`;
    }
  } catch (_) {}
}

export async function renderAgentStats(a) {
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

// 字段读写按 schema 的 builtin 标记落位：true=RoleConfig 顶层字段，
// false=Custom。标记由服务端从 RoleConfig 结构体反射派生——在 Go 里新增/
// 删除角色创建选项后，创建弹窗与角色页配置表单自动同步，这里不再维护
// 硬编码字段清单。

export function fieldValue(f, rc) {
  if (f.builtin) {
    const v = rc[f.key];
    if (f.type === "list") return Array.isArray(v) ? (v || []).join(",") : (v ?? "");
    if (f.type === "env") return Object.entries(v || {}).map(([k, val]) => `${k}=${val}`).join("\n");
    if (Array.isArray(v)) return (v || []).join(" "); // extra_args 等数组字段回显
    return v ?? f.default ?? "";
  }
  return (rc.custom && rc.custom[f.key] != null) ? rc.custom[f.key] : (f.default ?? "");
}

/* ---- 列表字段（chips 编辑器）：逗号分隔值 ↔ 可增删的 chip ---- */

export function chipHTML(key, p) {
  return `<span class="chip-item" data-v="${esc(p)}"><span class="ci-text">${esc(p)}</span><button type="button" class="chip-x" onclick="removeChip('${key}', this)" aria-label="移除">×</button></span>`;
}

export function chipEditorValue(el) {
  const box = el.closest(".chip-editor");
  return { box, hidden: box.querySelector('input[type="hidden"]') };
}

export function syncChips(box, key) {
  const h = box.querySelector('input[type="hidden"]');
  const items = h.value ? h.value.split(",") : [];
  const row = box.querySelector(".chips");
  if (row) row.innerHTML = items.map(p => chipHTML(key, p)).join("");
  if (box.querySelector(".skill-opts")) {
    box.querySelectorAll(".skill-opts input[type=checkbox]").forEach(cb =>
      cb.checked = items.includes(cb.dataset.v));
  }
}

export function addChip(key, input) {
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

export function removeChip(key, btn) {
  const chip = btn.closest(".chip-item");
  if (!chip) return;
  const { box, hidden } = chipEditorValue(btn);
  const items = hidden.value ? hidden.value.split(",") : [];
  const i = items.indexOf(chip.dataset.v);
  if (i >= 0) items.splice(i, 1);
  hidden.value = items.join(",");
  syncChips(box, key);
}

export function toggleSkill(key, cb) {
  const { box, hidden } = chipEditorValue(cb);
  const items = hidden.value ? hidden.value.split(",") : [];
  const v = cb.dataset.v;
  if (cb.checked) { if (!items.includes(v)) items.push(v); }
  else { const i = items.indexOf(v); if (i >= 0) items.splice(i, 1); }
  hidden.value = items.join(",");
  syncChips(box, key);
}

export function filterSkillOptions(control) {
  const box = control?.closest?.(".chip-editor");
  if (!box) return;
  const tag = box.querySelector("[data-skill-tag-filter]")?.value || "";
  const query = (box.querySelector("[data-skill-search]")?.value || "").trim().toLocaleLowerCase();
  box.querySelectorAll(".skill-opt").forEach(option => {
    const tags = (option.dataset.tags || "").split("|").filter(Boolean);
    const text = option.dataset.search || "";
    const matchesTag = !tag || (tag === "__untagged__" ? tags.length === 0 : tags.includes(tag.toLocaleLowerCase()));
    option.hidden = !matchesTag || (!!query && !text.includes(query));
  });
}

// N2-L1：全选当前筛选（tag + 搜索）下可见的技能；清空全部。
export function selectVisibleSkills(key) {
  const box = document.querySelector(`.chip-editor [data-key="${key}"]`)?.closest(".chip-editor");
  if (!box) return;
  const hidden = new Set();
  box.querySelectorAll(".skill-opt").forEach(o => { if (o.hidden) hidden.add(o.dataset.v); });
  const add = [...box.querySelectorAll(".skill-opt input:checked")].map(i => i.dataset.v);
  box.querySelectorAll(".skill-opt").forEach(o => {
    if (!hidden.has(o.dataset.v)) { const cb = o.querySelector("input"); if (cb && !cb.checked) { cb.checked = true; add.push(o.dataset.v); } }
  });
  const input = box.querySelector("input[data-type=list]");
  if (input) input.value = [...new Set(add)].join(",");
}

export function clearSkillSelection(key) {
  const box = document.querySelector(`.chip-editor [data-key="${key}"]`)?.closest(".chip-editor");
  if (!box) return;
  box.querySelectorAll(".skill-opt input:checked").forEach(cb => cb.checked = false);
  const input = box.querySelector("input[data-type=list]");
  if (input) input.value = "";
}

/* ---- 技能多选：paihuo 技能库（按标签筛选后勾选，值=工作目录实际路径） ---- */

export function skillsControlHTML(f, val) {
  const items = val ? String(val).split(",").map(s => s.trim()).filter(Boolean) : [];
  const lib = state.skillLib || [];
  const tagMap = new Map();
  lib.forEach(s => (Array.isArray(s.tags) ? s.tags : []).forEach(tag => {
    const key = String(tag).trim().toLocaleLowerCase();
    if (key && !tagMap.has(key)) tagMap.set(key, String(tag).trim());
  }));
  const tagOptions = [...tagMap.entries()].sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join("");
  const hasUntagged = lib.some(s => !(Array.isArray(s.tags) && s.tags.length));
  const opts = lib.map(s => {
    const on = items.includes(s.dir);
    const rawTags = (Array.isArray(s.tags) ? s.tags : []).map(String).map(tag => tag.trim()).filter(Boolean);
    const tags = rawTags.map(tag => tag.toLocaleLowerCase());
    const search = [s.name, s.description, ...rawTags].join(" ").toLocaleLowerCase();
    return `<label class="skill-opt" data-tags="${esc(tags.join("|"))}" data-search="${esc(search)}"><input type="checkbox" data-v="${esc(s.dir)}" ${on ? "checked" : ""} onchange="toggleSkill('${f.key}', this)"><span class="skill-opt-copy" title="${esc(s.description || s.dir)}"><span class="skill-opt-name">${esc(s.name)}</span>${rawTags.length ? `<small>${rawTags.map(tag => esc(tag)).join(" · ")}</small>` : `<small>未分类</small>`}</span></label>`;
  }).join("");
  return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map(p => chipHTML(f.key, p)).join("")}</div>
    <div class="skill-filter-row">
      <label>按标签
        <select data-skill-tag-filter onchange="filterSkillOptions(this)">
          <option value="">全部标签</option>${tagOptions}${hasUntagged ? `<option value="__untagged__">未分类</option>` : ""}
        </select>
      </label>
      <input data-skill-search placeholder="搜索技能名称或说明" oninput="filterSkillOptions(this)">
    </div>
    <div class="skill-opts">${opts || `<div class="empty">技能库为空：到 Skills 页添加技能（含 SKILL.md 的目录）</div>`}</div>
    <div class="chip-add">
      <button type="button" class="btn xs" onclick="selectVisibleSkills('${f.key}')">全选当前筛选</button>
      <button type="button" class="btn xs" onclick="clearSkillSelection('${f.key}')">清空技能</button>
    </div>
    <div class="chip-add">
      <input placeholder="自定义技能目录路径，回车添加" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f.key}', this.previousElementSibling)">添加</button>
    </div>
  </div>`;
}

/* ---- 普通列表字段（plugins 等）：chip 编辑器 ---- */

export function chipsControlHTML(f, val) {
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

// selectOptionsHTML 保留数据库里已有但当前主机不再声明的值，避免用户只是
// 打开/保存一个角色就意外清空旧配置；这种值会明确标成“当前保存值”。
export function selectOptionsHTML(options, val) {
  const current = String(val ?? "");
  const values = Array.isArray(options) ? options.map(String) : [];
  const legacy = current !== "" && !values.includes(current);
  if (legacy) values.push(current);
  return values.map(o => {
    const label = o === "" ? "默认" : (legacy && o === current ? `${o}（当前保存值）` : o);
    return `<option value="${esc(o)}" ${current === o ? "selected" : ""}>${esc(label)}</option>`;
  }).join("");
}

// syncModelThinking 在模型输入变化时，把思考档位收窄到当前 Linux 主机为该
// 模型实际声明的集合。没有模型能力目录的 CLI 保留 schema 的静态选项。
export function syncModelThinking(input) {
  const scope = input.closest("#rsSchema");
  const select = scope && scope.querySelector('select[data-key="thinking"][data-thinking-options]');
  if (!select) return;
  let byModel = {}, fallback = [];
  try { byModel = JSON.parse(select.dataset.thinkingOptions || "{}"); } catch (_) {}
  try { fallback = JSON.parse(select.dataset.fallbackOptions || "[]"); } catch (_) {}
  const model = String(input.value || "").trim();
  const hasModel = Object.prototype.hasOwnProperty.call(byModel, model);
  let options = hasModel && Array.isArray(byModel[model]) ? byModel[model] : fallback;
  // 能力目录中的模型即使没有声明任何档位，也只能保留“默认”；不能
  // 回退到其它模型的并集。未知/手工输入的模型才使用保守并集。
  if (hasModel && Array.isArray(fallback) && fallback.includes("") && !options.includes("")) options = ["", ...options];
  const current = select.value;
  const next = Array.isArray(options) && options.map(String).includes(current) ? current : "";
  select.innerHTML = selectOptionsHTML(options, next);
}

export function fieldControlHTML(f, rc, selectedModel = "") {
  const val = fieldValue(f, rc);
  let attrs = `data-key="${f.key}" data-type="${f.type}"`;
  const hasModelThinking = f.key === "thinking" && f.thinking_options_by_model;
  if (hasModelThinking) {
    attrs += ` data-thinking-options="${esc(JSON.stringify(f.thinking_options_by_model))}"`;
    let fallbackOptions = f.options || [];
    if (Array.isArray(f.thinking_options_by_model[""])) {
      fallbackOptions = f.thinking_options_by_model[""];
      if (Array.isArray(f.options) && f.options.includes("") && !fallbackOptions.includes("")) {
        fallbackOptions = ["", ...fallbackOptions];
      }
    }
    attrs += ` data-fallback-options="${esc(JSON.stringify(fallbackOptions))}"`;
  }
  let ctl = "";
  if (f.type === "select") {
    let options = f.options || [];
    if (hasModelThinking && Array.isArray(f.thinking_options_by_model[selectedModel])) {
      options = f.thinking_options_by_model[selectedModel];
      if ((f.options || []).includes("") && !options.includes("")) options = ["", ...options];
    }
    ctl = `<select ${attrs}>${selectOptionsHTML(options, val)}</select>`;
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
    const sync = f.key === "model" ? ` oninput="syncModelThinking(this)" onchange="syncModelThinking(this)"` : "";
    ctl = `<input ${attrs} list="${dl}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}"${sync}>` +
      `<datalist id="${dl}">${f.suggestions.map(s => `<option value="${esc(s)}">`).join("")}</datalist>`;
  } else {
    const sync = f.key === "model" ? ` oninput="syncModelThinking(this)" onchange="syncModelThinking(this)"` : "";
    ctl = `<input ${attrs} value="${esc(val)}" placeholder="${esc(f.placeholder || "")}"${sync}>`;
  }
  return `<div class="schema-field">
    <label class="field">${esc(f.label)}${ctl}</label>
    ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
  </div>`;
}

export function schemaFormHTML(schema, rc) {
  const groups = {};
  const fields = schema.fields || [];
  const model = fields.find(f => f.key === "model");
  const selectedModel = model ? String(fieldValue(model, rc) || "") : "";
  fields.forEach(f => { (groups[f.group] = groups[f.group] || []).push(f); });
  return Object.entries(groups).map(([g, fs]) => `
    <div class="schema-group">
      <div class="schema-group-title">${esc(g)}</div>
      <div class="schema-group-body">${fs.map(f => fieldControlHTML(f, rc, selectedModel)).join("")}</div>
    </div>`).join("");
}

// 从表单容器收集配置：完全按 schema 渲染的字段回读，不存在于 schema 的
// 字段（含已删除的旧选项）一律不输出，服务端整包替换后自动清除。
export function readConfigFrom(schema, container) {
  const cfg = { custom: {} };
  (schema.fields || []).forEach(f => {
    const el = container.querySelector(`[data-key="${f.key}"]`);
    if (!el) return;
    const val = el.value;
    if (f.type === "env") {
      if (f.builtin) cfg.env = parseEnv(val);
      else cfg.custom[f.key] = val;
      return;
    }
    if (f.type === "list") {
      const arr = val.split(",").map(s => s.trim()).filter(Boolean);
      if (f.builtin) cfg[f.key] = arr;
      else cfg.custom[f.key] = arr.join(",");
      return;
    }
    if (f.builtin && f.key === "extra_args") {
      cfg.extra_args = val.split(/\s+/).filter(Boolean);
      return;
    }
    if (f.builtin) cfg[f.key] = val;
    else cfg.custom[f.key] = val;
  });
  return cfg;
}

export async function saveAgentConcurrency() {
  const a = state.agentEditing;
  if (!a) return;
  const n = Number(document.getElementById("aMaxConc")?.value);
  if (!Number.isInteger(n) || n < 1) return toast("最大并发必须是至少为 1 的整数", true);
  if (n === (a.max_concurrency || 1)) return;
  try {
    await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ max_concurrency: n }) });
    toast(`并发已更新为 ${n}`);
    await loadAll();
    showAgentDetail(a.id); // 重新渲染概况，展示最新并发
  } catch (e) { toast(e.message, true); }
}

/* 角色创建、编辑与 schema 配置统一在 role studio 中完成。 */

export async function deleteAgent(id) {
  // 详情页的按钮是内联 onclick，无法访问 ES module 内部的 state；没有显式
  // id 时从当前详情角色取值，列表/表格按钮仍可继续传入各自的 id。
  if (!id) id = state.agentEditing?.id;
  if (!id) return;
  if (!confirm("删除该角色？未完成任务将失去指派，历史任务保留。")) return;
  try {
    await api(`/api/agents/${id}`, { method: "DELETE" });
    await loadAll();
    renderAgentList();
    if (state.agentEditing && state.agentEditing.id === id) closeAgentDetail();
    toast("已删除");
  } catch (e) { toast(e.message, true); }
}

export function parseEnv(text) {
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
