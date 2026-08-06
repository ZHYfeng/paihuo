// 模块 history（由 scripts/split-frontend.py 生成）
import { PERM_LABEL, STATUS_LABEL, ST_COLOR, api, esc, icon, state, toast } from "./core.js";
import { loadAll } from "./main.js";
import { canDeleteTask, canRetryTask, deleteTask, isMergeTask, openTask, retryTaskLabel, setTaskStatus } from "./task.js";

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
      <td class="chk"><input type="checkbox" ${state.historySel.has(t.id) ? "checked" : ""} onclick="event.stopPropagation()" onchange="toggleRow(this.closest('tr'), this.checked)" aria-label="选择任务 #${t.id}"></td>
      <td class="num">#${t.id}</td>
      <td class="t-title"><span class="t-link" onclick="event.stopPropagation();openTask(${t.id})">${esc(t.title)}</span>${isMergeTask(t) ? ` <span class="chip merge">合并 #${t.merge_of}</span>` : ""}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${esc(t.project_name || "-")}</td>
      <td>${PERM_LABEL[t.perm] || t.perm}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          ${canRetryTask(t)
            ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}${retryTaskLabel(t)}</button>` : ""}
          ${canDeleteTask(t) ? `<button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}删除</button>` : ""}
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("historyEmpty");
  if (empty) empty.classList.toggle("hidden", state.history.length > 0);
  const cnt = document.getElementById("hSelCount");
  if (cnt) cnt.textContent = state.historySel.size;
  syncHistorySelectionControls();
}

function syncHistorySelectionControls() {
  const checkAll = document.getElementById("hCheckAll");
  if (!checkAll) return;
  const selectedCount = state.history.reduce((count, t) => count + (state.historySel.has(t.id) ? 1 : 0), 0);
  const hasHistory = state.history.length > 0;
  checkAll.checked = hasHistory && selectedCount === state.history.length;
  checkAll.indeterminate = selectedCount > 0 && selectedCount < state.history.length;
}

export function toggleRow(tr, checked) {
  const id = Number(tr.dataset.id);
  const selected = typeof checked === "boolean" ? checked : !state.historySel.has(id);
  if (selected) state.historySel.add(id); else state.historySel.delete(id);
  tr.classList.toggle("selected", selected);
  const cb = tr.querySelector("input[type=checkbox]");
  if (cb) cb.checked = selected;
  const cnt = document.getElementById("hSelCount");
  if (cnt) cnt.textContent = state.historySel.size;
  syncHistorySelectionControls();
}

export function toggleAll(checked) {
  const checkAll = document.getElementById("hCheckAll");
  const all = typeof checked === "boolean" ? checked : Boolean(checkAll?.checked);
  state.historySel.clear();
  if (all) state.history.forEach(t => state.historySel.add(t.id));
  renderHistory();
}

export function selectAllNonMergeTasks() {
  state.historySel.clear();
  state.history.filter(t => !isMergeTask(t)).forEach(t => state.historySel.add(t.id));
  renderHistory();
}

export async function deleteSelected() {
  const ids = [...state.historySel];
  if (!ids.length) return toast("先勾选要删除的任务", true);
  if (ids.some(id => isMergeTask(state.history.find(t => t.id === id)))) {
    return toast("代码合并任务不能单独删除；请删除其源任务以放弃整组代码", true);
  }
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
