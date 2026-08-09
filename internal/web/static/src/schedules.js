// 模块 schedules（由 scripts/gen-globals.py 维护导入/导出）
import { api, closeModal, esc, openModal, state, toast, icon } from "./core.js";
import { fillSelects, loadAll } from "./main.js";

export function renderScheduleList() {
  const body = document.getElementById("scheduleList");
  if (!body) return;
  body.innerHTML = state.schedules.map(sc => `
    <tr>
      <td class="t-name"><b>${esc(sc.name)}</b></td>
      <td class="t-cron"><span class="cron-chip">${icon("clock")}${esc(scheduleLabel(sc.cron))}</span></td>
      <td class="t-agent">${esc(sc.agent_name || "-")}</td>
      <td class="t-type">${sc.project_id
        ? `<span class="chip" title="项目定时任务：创建后按项目顺序执行">项目 · ${esc(sc.project_name || "#" + sc.project_id)}</span>${sc.block_on_failure ? `<span class="chip merge-blocked">失败阻塞</span>` : ""}`
        : `<span class="chip">通用</span>`}</td>
      <td class="t-tpl">${esc(sc.title_template || "-")}</td>
      <td class="t-last num">${esc((sc.last_run_at || "-").slice(0, 16).replace("T", " "))}</td>
      <td class="t-enable"><label class="sw" title="${sc.enabled ? "停用" : "启用"}"><input type="checkbox" ${sc.enabled ? "checked" : ""} onchange="toggleSchedule(${sc.id})"><span class="sw-slider"></span></label></td>
      <td class="t-ops">
        <span class="ops">
          <button class="btn xs" onclick="openScheduleModal(${sc.id})">编辑</button>
          <button class="btn xs danger" onclick="deleteSchedule(${sc.id})">删除</button>
        </span>
      </td>
    </tr>`).join("");
  const empty = document.getElementById("scheduleEmpty");
  if (empty) empty.classList.toggle("hidden", state.schedules.length > 0);
}

const WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DEFAULT_TIME = "09:00";
let scheduleOriginalCron = "";
let scheduleUnsupported = false;
let scheduleDirty = false;

// 调度器仍以 cron 保存规则，但只把常用的周期映射到表单，避免用户直接
// 编写表达式。这里同时兼容旧版保存的五段 cron 和现在生成的六段 cron。
function parseScheduleCron(cron) {
  const raw = String(cron || "").trim().toLowerCase();
  if (raw === "@daily") return { frequency: "daily", time: "00:00" };
  if (raw === "@weekly") return { frequency: "weekly", weekday: "7", time: "00:00" };
  if (raw === "@monthly") return { frequency: "monthly", monthday: "1", time: "00:00" };
  const fields = raw.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const [second, minute, hour, dom, month, dow] = fields.length === 6
    ? fields
    : ["0", fields[0], fields[1], fields[2], fields[3], fields[4]];
  if (second !== "0" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const minuteNum = Number(minute), hourNum = Number(hour);
  if (minuteNum < 0 || minuteNum > 59 || hourNum < 0 || hourNum > 23) return null;
  const time = `${String(hourNum).padStart(2, "0")}:${String(minuteNum).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { frequency: "daily", time };
  if (dom === "*" && dow === "1-5") return { frequency: "weekdays", time };
  if (dom === "*" && /^\d$/.test(dow) && Number(dow) >= 0 && Number(dow) <= 7) {
    return { frequency: "weekly", weekday: String(Number(dow) === 0 ? 7 : Number(dow)), time };
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { frequency: "monthly", monthday: String(Number(dom)), time };
  }
  return null;
}

function scheduleCronFromFields() {
  const time = document.getElementById("sTime")?.value || "";
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
  const frequency = document.getElementById("sFrequency")?.value || "daily";
  const minute = Number(match[2]);
  const hour = Number(match[1]);
  let dom = "*", dow = "*";
  if (frequency === "weekdays") dow = "1-5";
  if (frequency === "weekly") {
    const weekday = Number(document.getElementById("sWeekday")?.value || 1);
    dow = weekday === 7 ? "0" : String(weekday);
  }
  if (frequency === "monthly") dom = String(Number(document.getElementById("sMonthday")?.value || 1));
  return `0 ${minute} ${hour} ${dom} * ${dow}`;
}

function scheduleLabel(cron) {
  const parsed = parseScheduleCron(cron);
  if (!parsed) return "自定义周期";
  if (parsed.frequency === "daily") return `每天 ${parsed.time}`;
  if (parsed.frequency === "weekdays") return `工作日 ${parsed.time}`;
  if (parsed.frequency === "weekly") return `每周${WEEKDAYS[Number(parsed.weekday)] || ""} ${parsed.time}`;
  return `每月${parsed.monthday}日 ${parsed.time}`;
}

function fillScheduleDays() {
  const select = document.getElementById("sMonthday");
  if (!select || select.options.length) return;
  select.innerHTML = Array.from({ length: 31 }, (_, i) =>
    `<option value="${i + 1}">${i + 1} 日</option>`).join("");
}

function updateSchedulePreview() {
  const preview = document.getElementById("sSchedulePreview");
  if (!preview) return;
  if (scheduleUnsupported && !scheduleDirty) {
    preview.textContent = "当前任务使用了自定义周期；调整上面的选项后会转换为常用周期。";
    preview.classList.add("warning");
    return;
  }
  preview.classList.remove("warning");
  preview.textContent = `将按“${scheduleLabel(scheduleCronFromFields())}”执行`;
}

export function syncScheduleFields(markDirty = true) {
  if (markDirty) scheduleDirty = true;
  const frequency = document.getElementById("sFrequency")?.value || "daily";
  document.getElementById("sWeekdayField")?.classList.toggle("hidden", frequency !== "weekly");
  document.getElementById("sMonthdayField")?.classList.toggle("hidden", frequency !== "monthly");
  updateSchedulePreview();
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
  fillScheduleDays();
  const sc = id ? state.schedules.find(x => x.id === id) : null;
  document.getElementById("scheduleModalTitle").textContent = sc ? "编辑定时任务" : "新建定时任务";
  document.getElementById("sId").value = sc ? sc.id : "";
  document.getElementById("sName").value = sc ? sc.name : "";
  const parsed = parseScheduleCron(sc?.cron);
  scheduleOriginalCron = sc?.cron || "";
  scheduleUnsupported = !!sc && !parsed;
  scheduleDirty = false;
  document.getElementById("sFrequency").value = parsed?.frequency || "daily";
  document.getElementById("sWeekday").value = parsed?.weekday || "1";
  document.getElementById("sMonthday").value = parsed?.monthday || "1";
  document.getElementById("sTime").value = parsed?.time || DEFAULT_TIME;
  syncScheduleFields(false);
  document.getElementById("sTitle").value = sc ? sc.title_template : "";
  document.getElementById("sBody").value = sc ? sc.body_template : "";
  document.getElementById("sPerm").value = sc ? (sc.perm || "full") : "full";
  document.getElementById("sProject").value = sc && sc.project_id ? sc.project_id : "";
  document.getElementById("sBlockOnFailure").checked = !!sc?.block_on_failure;
  if (sc) document.getElementById("sAgent").value = sc.agent_id;
  openModal("scheduleModal");
}

export async function submitSchedule() {
  const id = document.getElementById("sId").value;
  const cron = scheduleUnsupported && !scheduleDirty ? scheduleOriginalCron : scheduleCronFromFields();
  if (!cron) return toast("请选择有效的执行时间", true);
  const body = {
    name: document.getElementById("sName").value.trim(),
    cron,
    title_template: document.getElementById("sTitle").value.trim(),
    body_template: document.getElementById("sBody").value,
    agent_id: Number(document.getElementById("sAgent").value),
    project_id: Number(document.getElementById("sProject").value) || null,
    perm: document.getElementById("sPerm").value,
    block_on_failure: document.getElementById("sBlockOnFailure").checked,
  };
  try {
    if (id) await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/schedules", { method: "POST", body: JSON.stringify({ ...body, enabled: true }) });
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
