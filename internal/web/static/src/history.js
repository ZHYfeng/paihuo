// 模块 history（由 scripts/split-frontend.py 生成）
import { PERM_LABEL, STATUS_LABEL, ST_COLOR, api, esc, icon, state, toast } from "./core.js";
import { loadAll } from "./main.js";
import { deleteTask, setTaskStatus } from "./task.js";
import { openTerminal } from "./terminal.js";

export function loadHistory() {
  const agentId = document.getElementById("hAgent").value;
  const status = document.getElementById("hStatus").value;
  const days = Number(document.getElementById("hDays").value) || 0;
  state.history = state.tasks.filter(t => {
    if (agentId && t.agent_id !== Number(agentId)) return false;
    if (status && t.status !== status) return false;
    if (days > 0) {
      const end = t.finished_at || t.created_at;
      if (!end || Date.now() - new Date(end).getTime() > days * 86400000) return false;
    }
    return true;
  });
  state.historySel.clear();
  renderHistory();
}

export function renderHistory() {
  const body = document.getElementById("historyBody");
  if (!body) return;
  body.innerHTML = state.history.map(t => `
    <tr data-id="${t.id}" class="${state.historySel.has(t.id) ? "selected" : ""}" onclick="toggleRow(this)">
      <td class="chk"><input type="checkbox" ${state.historySel.has(t.id) ? "checked" : ""} onclick="event.stopPropagation()"></td>
      <td class="num">#${t.id}</td>
      <td class="t-title"><span class="t-link" onclick="event.stopPropagation();openTerminal(${t.id})">${esc(t.title)}</span></td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${esc(t.project_name || "-")}</td>
      <td>${PERM_LABEL[t.perm] || t.perm}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          ${["succeeded", "failed", "cancelled"].includes(t.status)
            ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}重试</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("historyEmpty");
  if (empty) empty.classList.toggle("hidden", state.history.length > 0);
  const cnt = document.getElementById("hSelCount");
  if (cnt) cnt.textContent = state.historySel.size;
}

export function toggleRow(tr) {
  const id = Number(tr.dataset.id);
  if (state.historySel.has(id)) state.historySel.delete(id); else state.historySel.add(id);
  tr.classList.toggle("selected", state.historySel.has(id));
  const cb = tr.querySelector("input[type=checkbox]");
  if (cb) cb.checked = state.historySel.has(id);
  const cnt = document.getElementById("hSelCount");
  if (cnt) cnt.textContent = state.historySel.size;
}

export function toggleAll() {
  const all = document.getElementById("hCheckAll").checked;
  state.historySel.clear();
  if (all) state.history.forEach(t => state.historySel.add(t.id));
  renderHistory();
}

export async function deleteSelected() {
  const ids = [...state.historySel];
  if (!ids.length) return toast("先勾选要删除的任务", true);
  if (!confirm(`删除选中的 ${ids.length} 条任务？不可恢复。`)) return;
  try {
    for (const id of ids) await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast(`已删除 ${ids.length} 条`);
    await loadAll();
    loadHistory();
  } catch (e) { toast(e.message, true); }
}

export async function cleanupHistory() {
  const agentId = Number(document.getElementById("hAgent").value) || null;
  const days = Number(document.getElementById("hDays").value) || 0;
  const before = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : "";
  if (!confirm(`删除${agentId ? "该角色" : "全部角色"}${before ? "、" + days + " 天前" : ""}的终态任务？不可恢复！`)) return;
  try {
    const r = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
    toast(`已删除 ${r.deleted} 条历史`);
    await loadAll();
    loadHistory();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   项目页（维度二：任务管理）
   ============================================================ */
