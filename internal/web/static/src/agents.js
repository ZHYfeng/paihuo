// 模块 agents（由 scripts/split-frontend.py 生成）
import { STATUS_LABEL, ST_COLOR, api, closeModal, esc, fmtDur, fmtPct, icon, openModal, state, toast } from "./core.js";
import { loadAll, loadSchema } from "./main.js";
import { dailyChartHTML, openProject, statusBarHTML } from "./projects.js";
import { loadSkillLib } from "./skills.js";
import { openTask } from "./task.js";

export let dlSeq = 0;

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
  return { list, query: q };
}

export function renderAgentEmpty(list, query) {
  const empty = document.getElementById("agentEmpty");
  if (!empty) return;
  empty.textContent = list.length
    ? ""
    : query
      ? "没有符合条件的角色"
      : "还没有角色。每个角色绑定一种 CLI，配置按该 CLI 的官方文档深度定制。";
  empty.classList.toggle("hidden", list.length > 0);
}

export function agentActionsHTML(a) {
  return `
    <button class="btn xs" title="打开详情并切到配置 tab" onclick="event.stopPropagation();agentTabFromCard(${a.id})">配置</button>
    <button class="btn xs" title="编辑角色基本信息和配置" onclick="event.stopPropagation();openAgentModal(${a.id})">编辑</button>
    <button class="btn xs" title="${a.enabled ? "停用" : "启用"}角色" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
    <button class="btn xs danger" title="删除角色" aria-label="删除角色 ${esc(a.name)}" onclick="event.stopPropagation();deleteAgent(${a.id})">${icon("trash")}</button>`;
}

export function renderAgentGrid() {
  const grid = document.getElementById("agentGrid");
  if (!grid) return;
  const { list, query } = filteredAgents();
  grid.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    const st = agentTaskStats(a);
    return `<article class="agent-card" data-agent-id="${a.id}" onclick="openAgentDetail(${a.id})">
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
    return `<tr onclick="openAgentDetail(${a.id})">
      <td><span style="display:flex;align-items:center;gap:8px">
        <span class="avatar av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <a class="table-primary-action" href="#/agent/${a.id}" onclick="event.stopPropagation()">${esc(a.name)}</a>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(a.description || "")}</span>
      </span></td>
      <td><span class="badge">${esc(a.cli)}</span></td>
      <td>${esc(rc.model || "默认")}</td>
      <td class="num">${esc(String(a.max_concurrency || 1))}</td>
      <td><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></td>
      <td>
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

/* ---- 目录选择器 ---- */
export let pendingAgentTab = null;

export function agentTabFromCard(id) {
  pendingAgentTab = "config";
  openAgentDetail(id);
}

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
  const tab = pendingAgentTab || "overview";
  pendingAgentTab = null;
  agentTab(tab);
}

export function hideAgentDetail() {
  document.getElementById("agentDetailShell").classList.add("hidden");
  document.getElementById("agentListShell").classList.remove("hidden");
  state.agentEditing = null;
}

export function agentTab(name) {
  state.agentTab = name;
  document.querySelectorAll("#agentTabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  const a = state.agentEditing;
  if (!a) return;
  const form = document.getElementById("agentForm");
  if (name === "overview") renderAgentOverview(a);
  else if (name === "config") renderAgentConfig(a);
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
  const scope = input.closest("#configForm, #agentModalSchema");
  const select = scope && scope.querySelector('select[data-key="thinking"][data-thinking-options]');
  if (!select) return;
  let byModel = {}, fallback = [];
  try { byModel = JSON.parse(select.dataset.thinkingOptions || "{}"); } catch (_) {}
  try { fallback = JSON.parse(select.dataset.fallbackOptions || "[]"); } catch (_) {}
  const model = String(input.value || "").trim();
  const options = Array.isArray(byModel[model]) ? byModel[model] : fallback;
  const current = select.value;
  select.innerHTML = selectOptionsHTML(options, current);
}

export function fieldControlHTML(f, rc, selectedModel = "") {
  const val = fieldValue(f, rc);
  let attrs = `data-key="${f.key}" data-type="${f.type}"`;
  const hasModelThinking = f.key === "thinking" && f.thinking_options_by_model;
  if (hasModelThinking) {
    attrs += ` data-thinking-options="${esc(JSON.stringify(f.thinking_options_by_model))}"`;
    attrs += ` data-fallback-options="${esc(JSON.stringify(f.options || []))}"`;
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

export async function renderAgentConfig(a) {
  const form = document.getElementById("agentForm");
  if (!form) return;
  if (!state.schema[a.cli]) await loadSchema(); // 容错：首屏 schema 是后台加载的，点得快时现拉一次
  const schema = state.schema[a.cli];
  if (!schema) { form.innerHTML = `<div class="empty">CLI schema 未加载</div>`; return; }
  await loadSkillLib();
  form.innerHTML = `
    <div class="schema-tip">该角色的可配置参数来自 ${esc(schema.name)} 官方文档
      ${schema.docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">查看文档 ↗</a>` : ""}。
      每个 CLI 的字段不同——这是按角色深度定制，不是统一定制；环境变量在下方「执行」分组里一并编辑。</div>
    <div id="configForm">${schemaFormHTML(schema, a.role_config || {})}</div>
    <div style="margin-top:16px"><button class="btn primary" onclick="saveAgentConfig()">保存</button></div>`;
}

export async function saveAgentConfig() {
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

export async function openAgentModal(id) {
  const a = id ? state.agents.find(x => x.id === id) : null;
  document.getElementById("agentModalTitle").textContent = a ? "编辑角色" : "新建角色";
  document.getElementById("aId").value = a ? a.id : "";
  document.getElementById("aName").value = a ? a.name : "";
  document.getElementById("aDesc").value = a ? (a.description || "") : "";
  document.getElementById("aMaxConcurrency").value = a ? (a.max_concurrency || 1) : 1;
  state.agentModalRC = a ? JSON.parse(JSON.stringify(a.role_config || {})) : {};
  await loadSchema();
  await loadSkillLib();
  const sel = document.getElementById("aCli");
  if (a) sel.value = a.cli;
  else if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
  renderAgentModalSchema();
  openModal("agentModal");
}

export function renderAgentModalSchema() {
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

export async function submitAgent() {
  const id = document.getElementById("aId").value;
  const cli = document.getElementById("aCli").value;
  const schema = state.schema[cli];
  const body = {
    name: document.getElementById("aName").value.trim(),
    description: document.getElementById("aDesc").value.trim(),
    cli,
    max_concurrency: Number(document.getElementById("aMaxConcurrency").value),
    enabled: true,
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
