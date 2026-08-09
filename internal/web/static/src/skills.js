// 模块 skills（由 scripts/gen-globals.py 维护导入/导出）
import { api, closeModal, esc, icon, openModal, state, toast } from "./core.js";
import { loadProjDatalist } from "./projects.js";

export function setSkillTab(tab) {
  const skills = tab === "skills";
  if (skills && state.skillDetail !== null) {
    hideSkillDetail();
    if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
  }
  if (!skills && /^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
  if (!skills) hideSkillDetail();
  document.getElementById("segSkillLib").classList.toggle("active", skills);
  document.getElementById("segExt").classList.toggle("active", !skills);
  document.getElementById("skillShell").classList.toggle("hidden", !skills);
  document.getElementById("extShell").classList.toggle("hidden", skills);
  document.getElementById("btnAddSkill").classList.toggle("hidden", !skills);
  document.getElementById("btnAddExt").classList.toggle("hidden", skills);
  const detail = state.skillDetail !== null;
  document.getElementById("skillDisplaySeg")?.classList.toggle("hidden", !skills || detail);
  document.getElementById("skillFilterControls")?.classList.toggle("hidden", !skills || detail);
  document.getElementById("skillManageControls")?.classList.toggle("hidden", !skills || state.skillDetail !== null);
  if (!skills) loadExtensions();
}

export function setSkillView(view) {
  state.skillView = view === "list" ? "list" : "grid";
  document.getElementById("skillDisplaySeg")?.classList.remove("hidden");
  document.getElementById("segSkillGrid")?.classList.toggle("active", state.skillView === "grid");
  document.getElementById("segSkillList")?.classList.toggle("active", state.skillView === "list");
  try { localStorage.setItem("paihuo.skillView", state.skillView); } catch (_) {}
  renderSkillLib();
}

export async function loadExtensions() {
  const raw = document.getElementById("extRaw");
  if (!raw) return;
  try {
    const d = await api("/api/extensions");
    raw.textContent = d.raw || "（空）";
    if (d.error && d.raw) raw.textContent = d.raw + "\n\n[执行提示] " + d.error;
  } catch (e) { raw.textContent = "加载失败: " + e.message; }
}

export function openExtModal() {
  document.getElementById("extSource").value = "";
  openModal("extModal");
}

export async function submitExt() {
  const source = document.getElementById("extSource").value.trim();
  if (!source) return toast("需要 extension 来源", true);
  try {
    const d = await api("/api/extensions/install", { method: "POST", body: JSON.stringify({ source }) });
    closeModal("extModal");
    toast("已安装");
    loadExtensions();
  } catch (e) { toast(e.message, true); }
}

export async function removeExt() {
  const name = prompt("输入要移除的 extension 名称（可从上方列表查看）");
  if (!name) return;
  try {
    await api(`/api/extensions/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("已移除");
    loadExtensions();
  } catch (e) { toast(e.message, true); }
}

export async function loadSkillLib() {
  try {
    state.skillLib = await api("/api/skills");
    const known = new Set(state.skillLib.map(s => s.id));
    state.skillSelected.forEach(id => { if (!known.has(id)) state.skillSelected.delete(id); });
    syncSkillTagFilter();
  } catch (_) {
    state.skillLib = [];
    state.skillSelected.clear();
    syncSkillTagFilter();
  }
}

function skillTags(skill) {
  return Array.isArray(skill?.tags) ? skill.tags.filter(Boolean).map(String) : [];
}

function skillTagsHTML(skill) {
  const tags = skillTags(skill);
  return tags.length
    ? tags.map(tag => `<span class="skill-tag">${esc(tag)}</span>`).join("")
    : `<span class="skill-tag muted">未分类</span>`;
}

function skillTagsEditorHTML(skill) {
  const inputId = `skill-tags-${skill.id}`;
  return `
    <div class="skill-tags-row">
      <div class="skill-tags" aria-label="当前标签">${skillTagsHTML(skill)}</div>
      <button type="button" class="btn xs ghost skill-tags-edit" data-skill-tags-toggle="${skill.id}"
        aria-controls="skill-tag-editor-${skill.id}" aria-expanded="false"
        onclick="event.stopPropagation();toggleSkillTagsEditor(${skill.id})">编辑标签</button>
    </div>
    <div class="skill-tag-editor hidden" id="skill-tag-editor-${skill.id}" onclick="event.stopPropagation()">
      <input id="${inputId}" class="skill-tags-input" value="${esc(skillTags(skill).join(", "))}"
        aria-label="编辑 ${esc(skill.name)} 的标签" placeholder="标签，用逗号分隔"
        onkeydown="if (event.key === 'Enter') { event.preventDefault(); saveSkillTagsInline(${skill.id}, this); }">
      <button type="button" class="btn xs primary" onclick="saveSkillTagsInline(${skill.id}, this)">保存</button>
    </div>`;
}

function parseTagInput(raw) {
  const seen = new Set();
  return String(raw || "").split(/[,，\n]/).map(tag => tag.trim()).filter(tag => {
    if (!tag) return false;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function allSkillTags() {
  const tags = new Map();
  state.skillLib.forEach(skill => skillTags(skill).forEach(tag => {
    const key = tag.toLocaleLowerCase();
    if (!tags.has(key)) tags.set(key, tag);
  }));
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

function syncSkillTagFilter() {
  const select = document.getElementById("skillTagFilter");
  if (!select) return;
  const current = select.value;
  const options = [`<option value="">全部标签</option>`]
    .concat(allSkillTags().map(tag => `<option value="${esc(tag)}">${esc(tag)}</option>`));
  if (state.skillLib.some(skill => !skillTags(skill).length)) {
    options.push(`<option value="__untagged__">未分类</option>`);
  }
  select.innerHTML = options.join("");
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function filteredSkills() {
  const query = (document.getElementById("skillSearch")?.value || "").trim().toLocaleLowerCase();
  const tag = document.getElementById("skillTagFilter")?.value || "";
  const list = state.skillLib.filter(skill => {
    const tags = skillTags(skill);
    const matchesTag = !tag || (tag === "__untagged__" ? tags.length === 0 : tags.some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase()));
    if (!matchesTag) return false;
    if (!query) return true;
    return [skill.name, skill.description, skill.dir, skill.source_path, ...tags]
      .some(value => String(value || "").toLocaleLowerCase().includes(query));
  });
  return { list, query, tag };
}

function skillGroupDirectory(skill) {
  const raw = String(skill.source_path || skill.dir || "").trim().replace(/[\\/]+$/, "");
  if (!raw) return "未指定来源目录";
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  if (slash < 0) return "根目录";
  if (slash === 0) return raw.slice(0, 1);
  if (slash === 2 && raw[1] === ":") return raw.slice(0, 3);
  return raw.slice(0, slash) || "根目录";
}

function skillPathName(path) {
  const raw = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!raw) return "未指定";
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return slash >= 0 ? raw.slice(slash + 1) || raw : raw;
}

function skillCreatedDate(skill) {
  return String(skill.created_at || "").slice(0, 10) || "—";
}

function skillGroups(skills = state.skillLib) {
  const groups = new Map();
  skills.forEach(skill => {
    const directory = skillGroupDirectory(skill);
    let group = groups.get(directory);
    if (!group) {
      group = { directory, skills: [] };
      groups.set(directory, group);
    }
    group.skills.push(skill);
  });
  return [...groups.values()].sort((a, b) => a.directory.localeCompare(b.directory));
}

function skillCardHTML(s) {
  const selected = state.skillSelected.has(s.id);
  const sourcePath = s.source_path || s.dir || "";
  const sourceName = skillPathName(sourcePath);
  const copyName = skillPathName(s.dir);
  return `
    <article class="skill-card${selected ? " selected" : ""}" tabindex="0" aria-label="打开技能 ${esc(s.name)}"
      onclick="openSkillDetail(${s.id})"
      onkeydown="if (!event.target.closest('a,button,input,select,textarea') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSkillDetail(${s.id}); }">
      <div class="sk-top">
        <label class="skill-select" onclick="event.stopPropagation()" title="选择 ${esc(s.name)}">
          <input type="checkbox" data-skill-id="${s.id}" ${selected ? "checked" : ""} aria-label="选择技能 ${esc(s.name)}" onchange="toggleSkillSelection(${s.id}, this.checked)">
        </label>
        <span class="avatar">${esc((s.name || "?").slice(0, 1))}</span>
        <div class="sk-id">
          <a class="sk-name card-primary-action" href="#/skill/${s.id}" onclick="event.stopPropagation()">${esc(s.name)}</a>
          <div class="sk-desc">${esc(s.description || "无描述")}</div>
        </div>
      </div>
      <div class="sk-meta">
        ${skillTagsEditorHTML(s)}
        <div class="skill-card-context">
          <span class="skill-card-context-item" title="${esc(sourcePath || "未指定来源路径")}">
            ${icon("folder")}<span><small>来源目录</small><b>${esc(sourceName)}</b></span>
          </span>
          <span class="skill-card-context-item">
            ${icon("clock")}<span><small>添加时间</small><time>${esc(skillCreatedDate(s))}</time></span>
          </span>
        </div>
      </div>
      <div class="sk-foot">
        <span class="skill-copy-path" title="${esc(s.dir || "未指定副本路径")}">${icon("copy")}<span>副本</span><code>${esc(copyName)}</code></span>
        <span class="ac-ops">
          <button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s.id})">打开详情${icon("expand")}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteSkill(${s.id})">${icon("trash")}删除</button>
        </span>
      </div>
    </article>`;
}

function skillListRowHTML(s) {
  const selected = state.skillSelected.has(s.id);
  const sourcePath = s.source_path || s.dir || "";
  const sourceName = skillPathName(sourcePath);
  return `<tr class="skill-list-row${selected ? " selected" : ""}" tabindex="0" aria-label="打开技能 ${esc(s.name)}"
    onclick="openSkillDetail(${s.id})"
    onkeydown="if (!event.target.closest('a,button,input,select,textarea') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSkillDetail(${s.id}); }">
    <td class="skill-list-check" data-label="选择"><label class="skill-select" onclick="event.stopPropagation()" title="选择 ${esc(s.name)}">
      <input type="checkbox" data-skill-id="${s.id}" ${selected ? "checked" : ""} aria-label="选择技能 ${esc(s.name)}" onchange="toggleSkillSelection(${s.id}, this.checked)">
    </label></td>
    <td class="skill-list-main-cell" data-label="技能"><span class="skill-list-name"><span class="avatar">${esc((s.name || "?").slice(0, 1))}</span><span><a class="table-primary-action" href="#/skill/${s.id}" onclick="event.stopPropagation()">${esc(s.name)}</a><small>${esc(s.description || "无描述")}</small></span></span></td>
    <td class="skill-list-tags-cell" data-label="标签">${skillTagsEditorHTML(s)}</td>
    <td class="skill-list-source-cell" data-label="来源目录">
      <span class="skill-list-source" title="${esc(sourcePath || "未指定来源路径")}">
        <b>${esc(sourceName)}</b><code>${esc(skillGroupDirectory(s))}</code>
      </span>
    </td>
    <td class="skill-list-date-cell num" data-label="添加时间"><time>${esc(skillCreatedDate(s))}</time></td>
    <td class="skill-list-actions-cell" data-label="操作"><span class="ops"><button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s.id})">打开详情${icon("expand")}</button><button class="btn xs danger" onclick="event.stopPropagation();deleteSkill(${s.id})">${icon("trash")}删除</button></span></td>
  </tr>`;
}

function syncSkillSelectionControls(groups = skillGroups(filteredSkills().list)) {
  const lib = state.skillLib;
  const selected = state.skillSelected;
  const selectedCount = selected.size;
  const all = lib.length > 0 && selectedCount === lib.length;
  const checkAll = document.getElementById("skillCheckAll");
  if (checkAll) {
    checkAll.checked = all;
    checkAll.indeterminate = selectedCount > 0 && !all;
  }
  document.querySelectorAll("#skillGrid input[data-skill-id]").forEach(cb => {
    const on = selected.has(Number(cb.dataset.skillId));
    cb.checked = on;
    cb.closest(".skill-card")?.classList.toggle("selected", on);
    cb.closest("tr")?.classList.toggle("selected", on);
  });
  groups.forEach((group, i) => {
    const groupSelected = group.skills.filter(s => selected.has(s.id)).length;
    const cb = document.querySelector(`#skillGrid input[data-skill-group="${i}"]`);
    if (!cb) return;
    cb.checked = groupSelected === group.skills.length;
    cb.indeterminate = groupSelected > 0 && groupSelected < group.skills.length;
  });
  const cnt = document.getElementById("skillSelectedCount");
  if (cnt) cnt.textContent = `已选 ${selectedCount}`;
  const del = document.getElementById("btnDeleteSkills");
  if (del) del.disabled = selectedCount === 0;
}

export function renderSkillLib() {
  const grid = document.getElementById("skillGrid");
  if (!grid) return;
  const lib = state.skillLib;
  const { list, query, tag } = filteredSkills();
  const groups = skillGroups(list);
  grid.className = state.skillView === "list" ? "skill-list-shell" : "skill-groups";
  if (state.skillView === "list") {
    grid.innerHTML = `<div class="list-wrap skill-list-wrap"><table class="list-grid skill-list-grid" aria-label="技能列表">
      <caption class="sr-only">技能列表，共 ${list.length} 个技能</caption>
      <thead><tr><th class="skill-list-check">选择</th><th>技能</th><th>标签</th><th>来源目录</th><th>添加时间</th><th class="skill-list-actions-head">操作</th></tr></thead>
      <tbody>${list.map(skillListRowHTML).join("")}</tbody>
    </table></div>`;
  } else {
    grid.innerHTML = groups.map((group, i) => `
      <section class="skill-group">
        <header class="skill-group-head">
          <label class="skill-group-select" title="选择目录 ${esc(group.directory)}">
            <input type="checkbox" data-skill-group="${i}" aria-label="选择目录 ${esc(group.directory)}" onchange="toggleSkillGroup(${i}, this.checked)">
          </label>
          ${icon("folder")}
          <div class="skill-group-title">
            <b>来源目录</b>
            <code title="${esc(group.directory)}">${esc(group.directory)}</code>
          </div>
          <span class="count-info">${group.skills.length} 个技能</span>
        </header>
        <div class="skill-group-grid">${group.skills.map(skillCardHTML).join("")}</div>
      </section>`).join("");
  }
  const empty = document.getElementById("skillEmpty");
  if (empty) {
    empty.innerHTML = lib.length === 0
      ? `<b class="empty-title">沉淀第一个可复用技能</b>
        <span class="empty-copy">导入单个技能目录，或扫描一个目录树中的全部 skills。</span>
        <button type="button" class="btn brand sm" onclick="openSkillModal()">添加技能</button>`
      : `<b class="empty-title">没有符合当前条件的技能</b>
        <span class="empty-copy">清除搜索词与标签筛选后，再查看完整技能库。</span>
        <button type="button" class="btn sm" onclick="document.getElementById('skillSearch').value='';document.getElementById('skillTagFilter').value='';renderSkillLib()">清除筛选</button>`;
    empty.classList.toggle("hidden", list.length > 0);
  }
  const hasLibrary = lib.length > 0;
  document.getElementById("skillDisplaySeg")?.classList.toggle("hidden", !hasLibrary);
  document.getElementById("skillFilterControls")?.classList.toggle("hidden", !hasLibrary);
  document.getElementById("skillManageControls")?.classList.toggle("hidden", !hasLibrary);
  const cnt = document.getElementById("skillCount");
  if (cnt) cnt.textContent = list.length === lib.length ? `${lib.length} 个技能` : `${list.length} / ${lib.length} 个技能`;
  syncSkillSelectionControls(groups);
}

export function toggleSkillSelection(id, checked) {
  if (checked) state.skillSelected.add(id); else state.skillSelected.delete(id);
  syncSkillSelectionControls();
}

export function toggleSkillGroup(groupIndex, checked) {
  const group = skillGroups(filteredSkills().list)[groupIndex];
  if (!group) return;
  group.skills.forEach(skill => {
    if (checked) state.skillSelected.add(skill.id); else state.skillSelected.delete(skill.id);
  });
  syncSkillSelectionControls();
}

export function toggleAllSkills(checked) {
  state.skillSelected.clear();
  if (checked) state.skillLib.forEach(skill => state.skillSelected.add(skill.id));
  syncSkillSelectionControls();
}

export async function deleteSelectedSkills() {
  const ids = [...state.skillSelected];
  if (!ids.length) return toast("先勾选要删除的技能", true);
  if (!confirm(`删除选中的 ${ids.length} 个技能？将同时移除工作目录中的副本，已引用它们的角色配置会失效。`)) return;
  try {
    const result = await api("/api/skills", { method: "DELETE", body: JSON.stringify({ ids }) });
    if (state.skillDetail && ids.includes(state.skillDetail.id)) {
      hideSkillDetail();
      if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
    }
    state.skillSelected.clear();
    await loadSkillLib();
    renderSkillLib();
    toast(`已删除 ${result.count ?? ids.length} 个技能`);
  } catch (e) { toast(e.message, true); }
}

export function toggleSkillTagsEditor(id) {
  const editor = document.getElementById(`skill-tag-editor-${id}`);
  if (!editor) return;
  const opening = editor.classList.contains("hidden");
  editor.classList.toggle("hidden", !opening);
  document.querySelector(`[data-skill-tags-toggle="${id}"]`)?.setAttribute("aria-expanded", String(opening));
  if (opening) {
    const input = document.getElementById(`skill-tags-${id}`);
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  }
}

async function persistSkillTags(id, tags) {
  const updated = await api(`/api/skills/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ tags }),
  });
  const index = state.skillLib.findIndex(item => item.id === id);
  if (index >= 0) state.skillLib[index] = { ...state.skillLib[index], ...updated };
  if (state.skillDetail?.id === id) state.skillDetail = { ...state.skillDetail, ...updated };
  syncSkillTagFilter();
  return updated;
}

export async function saveSkillTagsInline(id, source) {
  const input = document.getElementById(`skill-tags-${id}`);
  if (!input) return;
  const editor = input.closest(".skill-tag-editor");
  const button = source?.tagName === "BUTTON" ? source : editor?.querySelector("button");
  const tags = parseTagInput(input.value);
  if (button) {
    button.disabled = true;
    button.textContent = "保存中…";
  }
  try {
    await persistSkillTags(id, tags);
    renderSkillLib();
    toast(tags.length ? "标签已保存" : "已清除标签");
  } catch (e) {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "保存";
    }
    toast(e.message, true);
  }
}

function formatSkillBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function skillDetailSideHTML(skill) {
  return `
    <section class="side-panel">
      <div class="side-heading">技能信息</div>
      <div class="prop-row"><span class="k">名称</span><span class="v" title="${esc(skill.name)}">${esc(skill.name)}</span></div>
      <div class="prop-row"><span class="k">标签</span><span class="skill-tags">${skillTagsHTML(skill)}</span></div>
      <div class="prop-row"><span class="k">技能目录</span><code class="prop-mono" title="${esc(skill.dir)}">${esc(skill.dir)}</code></div>
      <div class="prop-row"><span class="k">来源路径</span><code class="prop-mono" title="${esc(skill.source_path || "-")}">${esc(skill.source_path || "-")}</code></div>
      <div class="prop-row"><span class="k">创建时间</span><span class="v">${esc((skill.created_at || "").slice(0, 16).replace("T", " ") || "-")}</span></div>
      <div class="prop-row"><span class="k">说明文件</span><span class="v">SKILL.md${skill.size_bytes !== undefined ? ` · ${formatSkillBytes(skill.size_bytes)}` : ""}</span></div>
    </section>
    <div class="side-actions">
      <div class="side-heading">标签管理</div>
      <input id="sdTags" class="skill-tags-input" value="${esc(skillTags(skill).join(", "))}" placeholder="如：编程, 文档, 代码审查">
      <div class="field-help">多个标签用逗号分隔，保存后可在角色创建时按标签筛选。</div>
      <button class="btn sm primary" onclick="saveSkillTags()">保存标签</button>
    </div>
    <div class="side-actions">
      <div class="side-heading">操作</div>
      <div class="detail-actions">
        <button class="btn" onclick="copySkillContent()">${icon("copy")}复制 SKILL.md</button>
        <button class="btn danger" onclick="deleteSkillFromDetail()">${icon("trash")}删除技能</button>
      </div>
    </div>`;
}

function renderSkillDetailShell(skill) {
  const main = document.getElementById("sdMain");
  const side = document.getElementById("sdSide");
  if (!main || !side) return;
  document.getElementById("sdCrumb").innerHTML = `技能 / <b>${esc(skill.name)}</b>`;
  document.getElementById("sdBadge").innerHTML = `<span class="badge" style="--st-color:var(--brand)">SKILL.md</span>`;
  main.innerHTML = `
    <section class="skill-hero">
      <span class="avatar lg skill-avatar">${esc((skill.name || "?").slice(0, 1))}</span>
      <div class="skill-hero-copy">
        <div class="detail-id">技能说明 · Markdown</div>
        <h2>${esc(skill.name)}</h2>
        ${skill.description ? `<div class="skill-hero-desc">${esc(skill.description)}</div>` : ""}
        <div id="sdTagsDisplay" class="skill-tags skill-hero-tags">${skillTagsHTML(skill)}</div>
      </div>
    </section>
    <div class="skill-doc-head">
      <div>
        <div class="section-title">SKILL.md</div>
        <div class="section-sub" id="sdDocMeta">正在读取技能说明…</div>
      </div>
      <button class="btn ghost xs" onclick="copySkillContent()">${icon("copy")}复制</button>
    </div>
    <pre class="skill-doc" id="sdDoc">加载中…</pre>`;
  side.innerHTML = skillDetailSideHTML(skill);
}

function renderSkillDocument(detail) {
  const doc = document.getElementById("sdDoc");
  const meta = document.getElementById("sdDocMeta");
  if (!doc || !meta) return;
  const content = String(detail.content || "");
  doc.textContent = content || "（SKILL.md 为空）";
  doc.classList.toggle("is-empty", !content);
  meta.textContent = content ? `${formatSkillBytes(detail.size_bytes ?? content.length)} · ${content.split("\n").length} 行` : "空文件";
  const side = document.getElementById("sdSide");
  if (side) side.innerHTML = skillDetailSideHTML(detail);
}

export function openSkillDetail(id) {
  location.hash = "#/skill/" + id;
}

export function closeSkillDetail() {
  location.hash = "#/";
}

export function hideSkillDetail() {
  document.getElementById("skillDetailShell")?.classList.add("hidden");
  document.getElementById("skillShell")?.classList.remove("hidden");
  state.skillDetail = null;
  document.getElementById("skillDisplaySeg")?.classList.remove("hidden");
  document.getElementById("skillFilterControls")?.classList.remove("hidden");
  document.getElementById("skillManageControls")?.classList.remove("hidden");
}

export async function showSkillDetail(id) {
  let skill = state.skillLib.find(x => x.id === id);
  if (!skill) {
    await loadSkillLib();
    renderSkillLib();
    skill = state.skillLib.find(x => x.id === id);
  }
  if (!skill) {
    toast("技能不存在或已被删除", true);
    return;
  }
  state.skillDetail = skill;
  document.getElementById("skillShell")?.classList.add("hidden");
  document.getElementById("skillDetailShell")?.classList.remove("hidden");
  document.getElementById("skillDisplaySeg")?.classList.add("hidden");
  document.getElementById("skillFilterControls")?.classList.add("hidden");
  document.getElementById("skillManageControls")?.classList.add("hidden");
  renderSkillDetailShell(skill);
  try {
    const detail = await api(`/api/skills/${id}`);
    if (state.skillDetail?.id !== id) return;
    state.skillDetail = detail;
    renderSkillDocument(detail);
  } catch (e) {
    if (state.skillDetail?.id !== id) return;
    const doc = document.getElementById("sdDoc");
    const meta = document.getElementById("sdDocMeta");
    if (doc) { doc.textContent = `读取失败：${e.message}`; doc.classList.add("is-error"); }
    if (meta) meta.textContent = "无法读取 SKILL.md";
  }
}

export async function copySkillContent() {
  const content = state.skillDetail?.content;
  if (content === undefined) return toast("技能说明还在加载中", true);
  try {
    await navigator.clipboard.writeText(content);
    toast("已复制 SKILL.md");
  } catch (_) {
    toast("复制失败，请手动选择内容", true);
  }
}

export async function saveSkillTags() {
  const skill = state.skillDetail;
  if (!skill) return;
  const input = document.getElementById("sdTags");
  const tags = parseTagInput(input?.value || "");
  try {
    await persistSkillTags(skill.id, tags);
    const side = document.getElementById("sdSide");
    if (side) side.innerHTML = skillDetailSideHTML(state.skillDetail);
    const display = document.getElementById("sdTagsDisplay");
    if (display) display.innerHTML = skillTagsHTML(state.skillDetail);
    toast(tags.length ? "标签已保存" : "已清除标签");
  } catch (e) { toast(e.message, true); }
}

export function deleteSkillFromDetail() {
  const id = state.skillDetail?.id;
  if (id !== undefined) deleteSkill(id);
}

export function openSkillModal() {
  document.getElementById("sSkillPath").value = "";
  document.getElementById("sSkillTags").value = "";
  loadProjDatalist();
  openModal("skillModal");
}

export async function submitSkill() {
  const path = document.getElementById("sSkillPath").value.trim();
  if (!path) return toast("需要技能目录路径", true);
  const tags = parseTagInput(document.getElementById("sSkillTags")?.value || "");
  try {
    const sk = await api("/api/skills", { method: "POST", body: JSON.stringify({ source_path: path, tags }) });
    closeModal("skillModal");
    toast(`已导入 skill: ${sk.name}`);
    await loadSkillLib();
    renderSkillLib();
  } catch (e) { toast(e.message, true); }
}

export async function scanSkills() {
  const path = document.getElementById("sSkillPath").value.trim();
  if (!path) return toast("需要扫描根目录路径", true);
  const tags = parseTagInput(document.getElementById("sSkillTags")?.value || "");
  try {
    const result = await api("/api/skills/scan", { method: "POST", body: JSON.stringify({ source_path: path, tags }) });
    closeModal("skillModal");
    const imported = (result.imported || []).length;
    const skipped = (result.skipped || []).length;
    const failed = (result.errors || []).length;
    let summary = `发现 ${result.found || 0} 个 skill，已导入 ${imported} 个`;
    if (skipped) summary += `，跳过已导入 ${skipped} 个`;
    if (failed) summary += `，失败 ${failed} 个`;
    toast(summary, failed > 0);
    await loadSkillLib();
    renderSkillLib();
  } catch (e) { toast(e.message, true); }
}

export async function deleteSkill(id) {
  const s = state.skillLib.find(x => x.id === id);
  if (!confirm(`删除 skill「${s ? s.name : id}」？将同时移除工作目录中的副本，已引用它的角色配置会失效。`)) return;
  try {
    await api(`/api/skills/${id}`, { method: "DELETE" });
    toast("已删除");
    state.skillSelected.delete(id);
    await loadSkillLib();
    renderSkillLib();
    if (state.skillDetail?.id === id) {
      hideSkillDetail();
      if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
    }
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   设置页
   ============================================================ */
