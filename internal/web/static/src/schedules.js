// 模块 schedules（由 scripts/split-frontend.py 生成）
import { api, closeModal, esc, openModal, state, toast, icon } from "./core.js";
import { fillSelects, loadAll } from "./main.js";

export function renderScheduleList() {
  const body = document.getElementById("scheduleList");
  if (!body) return;
  body.innerHTML = state.schedules.map(sc => `
    <tr>
      <td class="t-name"><b>${esc(sc.name)}</b></td>
      <td><span class="cron-chip">${icon("clock")}${esc(sc.cron)}</span></td>
      <td>${esc(sc.agent_name || "-")}</td>
      <td class="t-tpl">${esc(sc.title_template || "-")}</td>
      <td class="num">${esc((sc.last_run_at || "-").slice(0, 16).replace("T", " "))}</td>
      <td><label class="sw" title="${sc.enabled ? "停用" : "启用"}"><input type="checkbox" ${sc.enabled ? "checked" : ""} onchange="toggleSchedule(${sc.id})"><span class="sw-slider"></span></label></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="openScheduleModal(${sc.id})">编辑</button>
          <button class="btn xs danger" onclick="deleteSchedule(${sc.id})">删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("scheduleEmpty");
  if (empty) empty.classList.toggle("hidden", state.schedules.length > 0);
}

export async function toggleSchedule(id) {
  const sc = state.schedules.find(x => x.id === id);
  try {
    await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !sc.enabled }) });
    await loadAll();
    renderScheduleList();
  } catch (e) { toast(e.message, true); }
}

export function openScheduleModal(id) {
  fillSelects();
  const sc = id ? state.schedules.find(x => x.id === id) : null;
  document.getElementById("scheduleModalTitle").textContent = sc ? "编辑定时任务" : "新建定时任务";
  document.getElementById("sId").value = sc ? sc.id : "";
  document.getElementById("sName").value = sc ? sc.name : "";
  document.getElementById("sCron").value = sc ? sc.cron : "0 9 * * *";
  document.getElementById("sTitle").value = sc ? sc.title_template : "";
  document.getElementById("sBody").value = sc ? sc.body_template : "";
  document.getElementById("sEnabled").checked = sc ? sc.enabled : true;
  if (sc) document.getElementById("sAgent").value = sc.agent_id;
  openModal("scheduleModal");
}

export async function submitSchedule() {
  const id = document.getElementById("sId").value;
  const body = {
    name: document.getElementById("sName").value.trim(),
    cron: document.getElementById("sCron").value.trim(),
    title_template: document.getElementById("sTitle").value.trim(),
    body_template: document.getElementById("sBody").value,
    agent_id: Number(document.getElementById("sAgent").value),
    enabled: document.getElementById("sEnabled").checked,
  };
  try {
    if (id) await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/schedules", { method: "POST", body: JSON.stringify(body) });
    closeModal("scheduleModal");
    await loadAll();
    renderScheduleList();
  } catch (e) { toast(e.message, true); }
}

export async function deleteSchedule(id) {
  if (!confirm("删除该定时任务？")) return;
  try {
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    await loadAll();
    renderScheduleList();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   skills 页：技能库管理（定向添加 → 复制到 paihuo 工作目录 → 角色按名称勾选）
   + Pi Extensions 管理（pi install/list/remove）
   ============================================================ */
