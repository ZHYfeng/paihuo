// 模块 skills（由 scripts/split-frontend.py 生成）
import { api, closeModal, esc, icon, openModal, state, toast } from "./core.js";
import { loadProjDatalist } from "./projects.js";

export function setSkillTab(tab) {
  const skills = tab === "skills";
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
    <div class="skill-card">
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
          <button class="btn xs danger" onclick="deleteSkill(${s.id})">${icon("trash")}删除</button>
        </span>
      </div>
    </div>`).join("");
  const empty = document.getElementById("skillEmpty");
  if (empty) empty.classList.toggle("hidden", lib.length > 0);
  const cnt = document.getElementById("skillCount");
  if (cnt) cnt.textContent = `${lib.length} 个技能`;
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
