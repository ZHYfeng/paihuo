// 模块 agents（由 scripts/split-frontend.py 生成）
import { BUILTIN_KEYS, STATUS_LABEL, ST_COLOR, api, closeModal, esc, fmtDur, fmtPct, icon, openModal, state, toast } from "./core.js";
import { loadAll, loadSchema } from "./main.js";
import { dailyChartHTML, openProject, statusBarHTML } from "./projects.js";
import { loadSkillLib } from "./skills.js";
import { openTerminal } from "./terminal.js";

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

export function renderAgentGrid() {
  const grid = document.getElementById("agentGrid");
  if (!grid) return;
  const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
  const list = state.agents.filter(a =>
    !q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q));
  grid.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    const st = agentTaskStats(a);
    return `<div class="agent-card" onclick="openAgentDetail(${a.id})">
      <div class="ac-top">
        <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(a.name)}</div>
          <div class="ac-sub">${esc(a.description || "未设置描述")}</div>
        </div>
        <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span>
      </div>
      <div class="ac-meta">
        <span class="chip">${esc(a.cli)}</span>
        <span class="chip" title="${esc(rc.model || "默认模型")}">${esc(rc.model || "默认模型")}</span>
      </div>
      <div class="ac-stats">
        <span><b>${st.total}</b> 任务</span>
        <span><b style="color:var(--st-running)">${st.inFlight}</b> 进行中</span>
        <span><b style="color:var(--st-review)">${st.review}</b> 待审批</span>
        <span class="ac-ops">
          <button class="btn xs" title="打开详情并切到配置 tab" onclick="event.stopPropagation();agentTabFromCard(${a.id})">配置</button>
          <button class="btn xs" onclick="event.stopPropagation();openAgentModal(${a.id})">编辑</button>
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
        </span>
      </div>
    </div>`;
  }).join("");
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

export function renderAgentTable() {
  const body = document.getElementById("agentList");
  if (!body) return;
  const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
  const list = state.agents.filter(a => !q || a.name.toLowerCase().includes(q));
  body.innerHTML = list.map(a => {
    const rc = a.role_config || {};
    return `<tr onclick="openAgentDetail(${a.id})">
      <td><span style="display:flex;align-items:center;gap:8px">
        <span class="avatar av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <b>${esc(a.name)}</b>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(a.description || "")}</span>
      </span></td>
      <td><span class="badge">${esc(a.cli)}</span></td>
      <td>${esc(rc.model || "默认")}</td>
      <td><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "启用" : "停用"}</span></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "停用" : "启用"}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteAgent(${a.id})">${icon("trash")}删除</button>
        </span>
      </td>
    </tr>`;
  }).join("");
  const empty = document.getElementById("agentEmpty");
  if (empty) empty.classList.toggle("hidden", list.length > 0);
  const cnt = document.getElementById("agentCount");
  if (cnt) cnt.textContent = `${list.length} 个角色`;
}

export function renderAgentList() {
  state.agentView === "grid" ? renderAgentGrid() : renderAgentTable();
}

export async function toggleAgent(id) {
  const a = state.agents.find(x => x.id === id);
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
  else if (name === "env") renderAgentEnv(a);
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

export function fieldValue(f, rc) {
  if (BUILTIN_KEYS.includes(f.key)) {
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

/* ---- 技能多选：paihuo 技能库（按名称勾选，值=工作目录实际路径） ---- */

export function skillsControlHTML(f, val) {
  const items = val ? String(val).split(",").map(s => s.trim()).filter(Boolean) : [];
  const lib = state.skillLib || [];
  const opts = lib.map(s => {
    const on = items.includes(s.dir);
    return `<label class="skill-opt"><input type="checkbox" data-v="${esc(s.dir)}" ${on ? "checked" : ""} onchange="toggleSkill('${f.key}', this)"><span title="${esc(s.description || s.dir)}">${esc(s.name)}</span></label>`;
  }).join("");
  return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map(p => chipHTML(f.key, p)).join("")}</div>
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

export function fieldControlHTML(f, rc) {
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
  } else if (f.type === "list" && f.source === "skills") {
    ctl = skillsControlHTML(f, val);
  } else if (f.type === "list") {
    ctl = chipsControlHTML(f, val);
  } else if (f.suggestions && f.suggestions.length) {
    const dl = "dl_" + (++dlSeq);
    ctl = `<input ${attrs} list="${dl}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">` +
      `<datalist id="${dl}">${f.suggestions.map(s => `<option value="${esc(s)}">`).join("")}</datalist>`;
  } else {
    ctl = `<input ${attrs} value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">`;
  }
  return `<div class="schema-field">
    <label class="field">${esc(f.label)}${ctl}</label>
    ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
  </div>`;
}

export function schemaFormHTML(schema, rc) {
  const groups = {};
  (schema.fields || []).forEach(f => { (groups[f.group] = groups[f.group] || []).push(f); });
  return Object.entries(groups).map(([g, fs]) => `
    <div class="schema-group">
      <div class="schema-group-title">${esc(g)}</div>
      <div class="schema-group-body">${fs.map(f => fieldControlHTML(f, rc)).join("")}</div>
    </div>`).join("");
}

export function readConfigFrom(schema, container) {
  const cfg = { model: "", system_prompt: "", instructions: "", thinking: "", skills: [], plugins: [], extra_args: [], env: {}, custom: {} };
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

export async function renderAgentConfig(a) {
  const form = document.getElementById("agentForm");
  if (!form) return;
  const schema = state.schema[a.cli];
  if (!schema) { form.innerHTML = `<div class="empty">CLI schema 未加载</div>`; return; }
  await loadSkillLib();
  form.innerHTML = `
    <div class="schema-tip">该角色的可配置参数来自 ${esc(schema.name)} 官方文档
      ${schema.docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">查看文档 ↗</a>` : ""}。
      每个 CLI 的字段不同——这是按角色深度定制，不是统一定制。</div>
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

export async function renderAgentEnv(a) {
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

export async function saveAgentEnv() {
  const a = state.agentEditing;
  if (!a) return;
  const rc = a.role_config || {};
  const env = parseEnv(document.getElementById("envText").value);
  const body = {
    model: rc.model || "", system_prompt: rc.system_prompt || "", instructions: rc.instructions || "",
    thinking: rc.thinking || "", skills: rc.skills || [], plugins: rc.plugins || [],
    extra_args: rc.extra_args || [], env, custom: rc.custom || {},
  };
  try {
    await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ role_config: body }) });
    toast("环境变量已保存");
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
  document.getElementById("aPerm").value = a ? (a.default_perm || "full") : "full";
  document.getElementById("aEnabled").checked = a ? a.enabled : true;
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

export async function deleteAgent(id) {
  if (!id) return;
  if (!confirm("删除该角色？未完成任务将失去指派，历史任务保留。")) return;
  try {
    await api(`/api/agents/${id}`, { method: "DELETE" });
    await loadAll();
    renderAgentList();
    if (state.agentEditing && state.agentEditing.id === id) hideAgentDetail();
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
