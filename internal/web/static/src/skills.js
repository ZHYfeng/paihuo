// 模块 skills（由 scripts/split-frontend.py 生成）
import { api, closeModal, esc, icon, openModal, state, toast } from "./core.js";
import { loadProjDatalist } from "./projects.js";

export function setSkillTab(tab) {
  const skills = tab === "skills";
  if (!skills && /^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
  if (!skills) hideSkillDetail();
  document.getElementById("segSkillLib").classList.toggle("active", skills);
  document.getElementById("segExt").classList.toggle("active", !skills);
  document.getElementById("skillShell").classList.toggle("hidden", !skills);
  document.getElementById("extShell").classList.toggle("hidden", skills);
  document.getElementById("btnAddSkill").classList.toggle("hidden", !skills);
  document.getElementById("btnAddExt").classList.toggle("hidden", skills);
  if (!skills) loadExtensions();
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
  } catch (_) { state.skillLib = []; }
}

export function renderSkillLib() {
  const grid = document.getElementById("skillGrid");
  if (!grid) return;
  const lib = state.skillLib;
  grid.innerHTML = lib.map(s => `
    <article class="skill-card" tabindex="0" role="button" aria-label="查看技能 ${esc(s.name)}" onclick="openSkillDetail(${s.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSkillDetail(${s.id})}">
      <div class="sk-top">
        <span class="avatar">${esc((s.name || "?").slice(0, 1))}</span>
        <div class="sk-id">
          <div class="sk-name">${esc(s.name)}</div>
          <div class="sk-desc">${esc(s.description || "无描述")}</div>
        </div>
      </div>
      <div class="sk-meta">
        <span class="chip" title="${esc(s.dir)}">${esc(s.dir)}</span>
      </div>
      <div class="sk-foot">
        <span class="count-info">来源：${esc(s.source_path || "-")} · ${(s.created_at || "").slice(0, 10)}</span>
        <span class="ac-ops">
          <button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s.id})">详情${icon("expand")}</button>
          <button class="btn xs danger" onclick="deleteSkill(${s.id});event.stopPropagation()">${icon("trash")}删除</button>
        </span>
      </div>
    </article>`).join("");
  const empty = document.getElementById("skillEmpty");
  if (empty) empty.classList.toggle("hidden", lib.length > 0);
  const cnt = document.getElementById("skillCount");
  if (cnt) cnt.textContent = `${lib.length} 个技能`;
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
      <div class="prop-row"><span class="k">技能目录</span><code class="prop-mono" title="${esc(skill.dir)}">${esc(skill.dir)}</code></div>
      <div class="prop-row"><span class="k">来源路径</span><code class="prop-mono" title="${esc(skill.source_path || "-")}">${esc(skill.source_path || "-")}</code></div>
      <div class="prop-row"><span class="k">创建时间</span><span class="v">${esc((skill.created_at || "").slice(0, 16).replace("T", " ") || "-")}</span></div>
      <div class="prop-row"><span class="k">说明文件</span><span class="v">SKILL.md${skill.size_bytes !== undefined ? ` · ${formatSkillBytes(skill.size_bytes)}` : ""}</span></div>
    </section>
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

export function deleteSkillFromDetail() {
  const id = state.skillDetail?.id;
  if (id !== undefined) deleteSkill(id);
}

export function openSkillModal() {
  document.getElementById("sSkillPath").value = "";
  loadProjDatalist();
  openModal("skillModal");
}

export async function submitSkill() {
  const path = document.getElementById("sSkillPath").value.trim();
  if (!path) return toast("需要技能目录路径", true);
  try {
    const sk = await api("/api/skills", { method: "POST", body: JSON.stringify({ source_path: path }) });
    closeModal("skillModal");
    toast(`已导入 skill: ${sk.name}`);
    await loadSkillLib();
    renderSkillLib();
  } catch (e) { toast(e.message, true); }
}

export async function scanSkills() {
  const path = document.getElementById("sSkillPath").value.trim();
  if (!path) return toast("需要扫描根目录路径", true);
  try {
    const result = await api("/api/skills/scan", { method: "POST", body: JSON.stringify({ source_path: path }) });
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
    await loadSkillLib();
    renderSkillLib();
    if (state.skillDetail?.id === id) {
      hideSkillDetail();
      if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
    }
  } catch (e) { toast(e.message, true); }
}

/* ---- 模板列表（提示词模板，任务详情「保存为模板」沉淀） ---- */

export async function loadTemplates() {
  try {
    state.templates = await api("/api/templates");
  } catch (_) { return; }
  const sel = document.getElementById("tTemplate");
  if (sel) sel.innerHTML = `<option value="">—</option>` + state.templates.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  renderTemplateList();
}

export function renderTemplateList() {
  const body = document.getElementById("templateList");
  if (!body) return;
  body.innerHTML = state.templates.map(t => `
    <tr>
      <td><b>${esc(t.name)}</b></td>
      <td style="font-size:12px;color:var(--fg-muted);max-width:480px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((t.body || "").slice(0, 90))}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td class="num">${(t.created_at || "").slice(0, 16).replace("T", " ")}</td>
      <td><button class="btn xs danger" onclick="deleteTemplate(${t.id})">${icon("trash")}删除</button></td>
    </tr>`).join("");
  const empty = document.getElementById("templateEmpty");
  if (empty) empty.classList.toggle("hidden", state.templates.length > 0);
}

export async function deleteTemplate(id) {
  if (!confirm("删除该模板？")) return;
  try {
    await api(`/api/templates/${id}`, { method: "DELETE" });
    await loadTemplates();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   设置页
   ============================================================ */
