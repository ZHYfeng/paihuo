// 模块 templates（由 scripts/gen-globals.py 维护导入/导出）
import { api, closeModal, esc, openModal, state, toast, icon } from "./core.js";
import { applyTemplate, openNewTask } from "./task.js";

// 加载模板：全站共享（新建任务弹窗的「从模板填充」下拉 + 本页列表）。
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
      <td class="t-name"><b>${esc(t.name)}</b></td>
      <td class="t-agent" data-label="角色">${esc(t.agent_name || "-")}</td>
      <td class="t-body" data-label="内容预览" title="${esc(t.body || "")}">${esc((t.body || "").slice(0, 90)) || "—"}</td>
      <td class="t-created num" data-label="创建时间">${(t.created_at || "").slice(0, 16).replace("T", " ")}</td>
      <td class="t-ops">
        <span class="ops">
          <button class="btn xs" onclick="openTemplateModal(${t.id})">编辑</button>
          <button class="btn xs" onclick="newTaskFromTemplate(${t.id})">${icon("plus")}新建任务</button>
          <button class="btn xs danger" onclick="deleteTemplate(${t.id})">${icon("trash")}删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("templateEmpty");
  if (empty) empty.classList.toggle("hidden", state.templates.length > 0);
}

function fillTemplateAgentSelect(selected) {
  const sel = document.getElementById("tpAgent");
  if (!sel) return;
  const opts = state.agents.filter(a => a.enabled);
  sel.innerHTML = `<option value="">不指定（创建任务时选择）</option>` + opts.map(a =>
    `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}</option>`).join("");
}

export function openTemplateModal(id) {
  const t = id ? state.templates.find(x => x.id === id) : null;
  document.getElementById("templateModalTitle").textContent = t ? "编辑模板" : "新建模板";
  document.getElementById("tpId").value = t ? t.id : "";
  document.getElementById("tpName").value = t ? t.name : "";
  document.getElementById("tpBody").value = t ? t.body : "";
  fillTemplateAgentSelect(t?.agent_id || 0);
  openModal("templateModal");
}

export async function submitTemplate() {
  const id = Number(document.getElementById("tpId").value) || 0;
  const name = document.getElementById("tpName").value.trim();
  const body = document.getElementById("tpBody").value.trim();
  const agent_id = Number(document.getElementById("tpAgent").value) || null;
  if (!name) { toast("模板名称不能为空", true); return; }
  if (!body) { toast("模板内容不能为空", true); return; }
  try {
    if (id) {
      await api(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify({ name, body, agent_id }) });
      toast("已保存");
    } else {
      await api("/api/templates", { method: "POST", body: JSON.stringify({ name, body, agent_id }) });
      toast("已创建");
    }
    closeModal("templateModal");
    await loadTemplates();
  } catch (e) { toast(e.message, true); }
}

export async function deleteTemplate(id) {
  if (!confirm("删除该模板？")) return;
  try {
    await api(`/api/templates/${id}`, { method: "DELETE" });
    await loadTemplates();
  } catch (e) { toast(e.message, true); }
}

// 用模板直接打开新建任务弹窗并填充内容与角色。
export function newTaskFromTemplate(id) {
  openNewTask();
  const sel = document.getElementById("tTemplate");
  if (sel) sel.value = String(id);
  applyTemplate();
}
