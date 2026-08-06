// 模块 main（由 scripts/split-frontend.py 生成）
import { addChip, agentTab, agentTabFromCard, closeAgentDetail, deleteAgent, filterSkillOptions, hideAgentDetail, openAgentDetail, openAgentModal, refreshAgentCatalog, removeChip, renderAgentList, renderAgentModalSchema, renderAgentOverview, saveAgentConcurrency, saveAgentConfig, setAgentView, showAgentDetail, submitAgent, syncModelThinking, toggleAgent, toggleSkill } from "./agents.js";
import { activeModal, api, closeModal, esc, fmtDur, fmtPct, logout, state, toast } from "./core.js";
import { loadDashboard } from "./dashboard.js";
import { cleanupHistory, deleteSelected, loadHistory, selectAllNonMergeTasks, toggleAll, toggleRow } from "./history.js";
import { closeProjectDetail, deleteProject, dirLoad, hideProjectDetail, mkdirCurrent, openDirPicker, openProject, openProjectModal, patchProject, pickDir, refreshProjectDetail, renderProjectList, showProjectDetail, submitProject } from "./projects.js";
import { appendInstLine, closeInstTerminal, copyText, createDefaultRole, installProvision, loadProvision, provState, refreshProvision } from "./provision.js";
import { changeRoleStudioCli, openRoleStudio, openRoleStudioManual, roleStudioQuickAsk, saveRoleStudio, sendRoleStudioChat, sendRoleStudioTest } from "./role_studio.js";
import { deleteSchedule, openScheduleModal, renderScheduleList, submitSchedule, syncScheduleFields, toggleSchedule } from "./schedules.js";
import { loadSettings, runCleanup, saveRetention, saveWtRetention } from "./settings.js";
import { closeSkillDetail, copySkillContent, deleteSelectedSkills, deleteSkill, deleteSkillFromDetail, deleteTemplate, hideSkillDetail, loadSkillLib, loadTemplates, openExtModal, openSkillDetail, openSkillModal, removeExt, renderSkillLib, saveSkillTags, scanSkills, setSkillTab, setSkillView, showSkillDetail, submitExt, submitSkill, toggleAllSkills, toggleSkillGroup, toggleSkillSelection } from "./skills.js";
import { appendLog, applyFilters, applyTemplate, closeDetail, copyLogs, deleteTask, endInteractiveTask, gitInitProject, hideDetail, openNewTask, openProjectTask, openSubTask, openTask, patchTask, refreshDetail, rejectTask, renderBoard, renderList, resumeTask, saveAsTemplate, setTaskStatus, setView, showDetail, submitTask, syncTaskConcurrency, syncTaskDependency, syncTaskRunMode, wsDiscard } from "./task.js";
import { closeTerminal, openTerminal, sendTaskInput, sendTerminalInput, syncTerminalInput } from "./terminal.js";

export async function loadAll() {
  const [tasks, agents, schedules, projects] = await Promise.all([
    api("/api/tasks"), api("/api/agents"), api("/api/schedules"), api("/api/projects"),
  ]);
  state.tasks = tasks;
  state.agents = agents;
  state.schedules = schedules;
  state.projects = projects;
  fillSelects();
}

// forceRefresh=true 会让服务端绕过模型目录内存缓存，重新读取当前 Linux 主机。
// 普通打开页面仍复用缓存，避免每次角色表单都拉起多个 CLI 子进程。
export async function loadSchema(forceRefresh = false) {
  try {
    const list = forceRefresh
      ? await api("/api/agents/schema/refresh", { method: "POST" })
      : await api("/api/agents/schema");
    state.schema = {};
    list.forEach(s => state.schema[s.id] = s);
    const sel = document.getElementById("aCli");
    const previous = sel ? sel.value : "";
    if (sel) {
      sel.innerHTML = list.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
      sel.value = state.schema[previous] ? previous : (list.length ? list[0].id : "");
    }
    return true;
  } catch (e) {
    // 首屏 schema 是非阻塞加载，保留原先的静默降级；手动刷新则交给调用方提示错误。
    if (forceRefresh) throw e;
    return false;
  }
}

export function fillSelects() {
  const opts = a => a.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  const enOpts = state.agents.filter(a => a.enabled);
  for (const id of ["tAgent", "sAgent"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = (id === "tAgent" ? `<option value="">不指派</option>` : "") + opts(enOpts);
  }
  for (const id of ["fAgent", "hAgent", "cleanupAgent"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<option value="">全部角色</option>` + opts(state.agents);
  }
  const pOpts = state.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  for (const id of ["fProject", "tProject", "sProject"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const empty = id === "fProject"
      ? "全部项目"
      : id === "sProject" ? "无项目（通用定时任务）" : "无项目";
    el.innerHTML = `<option value="">${empty}</option>` + pOpts;
  }
  const cnt = document.getElementById("sbBoardCount");
  if (cnt) cnt.textContent = state.tasks.filter(t =>
    ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
  const pc = document.getElementById("sbProjectCount");
  if (pc) pc.textContent = state.projects.filter(p => p.status === "active").length || "";
}

/* ============================================================
   统计条（看板页顶部）
   ============================================================ */

export async function refreshOverview() {
  try { state.overview = await api("/api/stats/overview"); } catch (_) { return; }
  renderStatsStrip();
}

export function renderStatsStrip() {
  const el = document.getElementById("dashStats");
  if (!el) return;
  const o = state.overview;
  if (!o) { el.innerHTML = ""; return; }
  const counts = o.status_counts || [];
  const review = counts.find(s => s.status === "awaiting_review");
  const today = o.daily && o.daily.length ? o.daily[o.daily.length - 1] : null;
  const chips = [
    ["进行中", o.in_flight || 0, "var(--st-running)", "LIVE"],
    ["待审批", review ? review.count : 0, "var(--st-review)", "REVIEW"],
    ["今日完成", today ? today.count : 0, "var(--st-done)", "TODAY"],
    ["完成率", fmtPct(o.success_rate), "var(--st-done)", "RATE"],
    ["平均耗时", fmtDur(o.avg_duration), "var(--fg-muted)", "SPEED"],
    ["活跃项目", o.projects || 0, "var(--fg-muted)", "SCOPE"],
  ];
  el.innerHTML = chips.map((c, i) => `<div class="stat-chip" style="--metric-color:${c[2]}" aria-label="${c[0]} ${c[1]}">
    <span class="sc-index">0${i + 1}</span>
    <span class="sc-dot"></span>
    <b>${c[1]}</b>
    <span class="sc-label">${c[0]}</span>
    <small>${c[3]}</small>
  </div>`).join("");
}

/* ============================================================
   看板页：board / list 视图
   ============================================================ */

function isMobileNav() {
  return window.matchMedia?.("(max-width: 900px)").matches || false;
}

function syncSidebarControls() {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const mobile = isMobileNav();
  const open = sb.classList.contains("mobile-open");
  const btn = document.getElementById("sbToggle");
  if (btn) {
    const title = mobile ? "关闭导航" : (sb.classList.contains("collapsed") ? "展开侧边栏 (Ctrl+B)" : "收起侧边栏 (Ctrl+B)");
    btn.title = title;
    btn.setAttribute("aria-expanded", mobile ? String(open) : String(!sb.classList.contains("collapsed")));
    btn.setAttribute("aria-label", btn.title);
  }
  const mobileBtn = document.getElementById("mobileNavToggle");
  if (mobileBtn) {
    mobileBtn.setAttribute("aria-expanded", mobile ? String(open) : "false");
    mobileBtn.setAttribute("aria-label", mobile && open ? "关闭导航" : "打开导航");
    mobileBtn.title = mobile && open ? "关闭导航" : "打开导航";
  }
  const backdrop = document.getElementById("sidebarBackdrop");
  if (backdrop) backdrop.setAttribute("aria-hidden", mobile && open ? "false" : "true");
  document.body.classList.toggle("nav-open", mobile && open);
}

export function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  if (isMobileNav()) {
    sb.classList.toggle("mobile-open");
    sb.classList.remove("collapsed");
    syncSidebarControls();
    return;
  }
  const collapsed = sb.classList.toggle("collapsed");
  sb.classList.remove("mobile-open");
  syncSidebarControls();
  try { localStorage.setItem("paihuo.sb", collapsed ? "1" : "0"); } catch (_) {}
}
export function restoreSidebar() {
  let collapsed = false;
  try { collapsed = localStorage.getItem("paihuo.sb") === "1"; } catch (_) {}
  const sb = document.getElementById("sidebar");
  if (sb) {
    sb.classList.remove("mobile-open");
    if (isMobileNav()) sb.classList.remove("collapsed");
    else if (collapsed) sb.classList.add("collapsed");
    syncSidebarControls();
  }
  const media = window.matchMedia?.("(max-width: 900px)");
  if (media && !media.__paihuoBound) {
    media.__paihuoBound = true;
    media.addEventListener?.("change", () => {
      const current = document.getElementById("sidebar");
      if (!current) return;
      current.classList.remove("mobile-open");
      if (media.matches) current.classList.remove("collapsed");
      else {
        let saved = false;
        try { saved = localStorage.getItem("paihuo.sb") === "1"; } catch (_) {}
        current.classList.toggle("collapsed", saved);
      }
      syncSidebarControls();
    });
  }
}

/* ---- 全局快捷键 ----
   N 新建任务（看板页）  / 聚焦搜索  Esc 关闭弹窗  Ctrl/Cmd+B 折叠侧边栏 */
export function initShortcuts() {
  document.addEventListener("keydown", e => {
    const t = e.target;
    const inField = t && (t.matches("input, textarea, select") || t.isContentEditable);
    const modal = activeModal();
    if (e.key === "Tab" && modal) {
      const focusable = [...modal.querySelectorAll("button:not([disabled]), [href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter(el => !el.closest(".hidden") && el.getClientRects().length);
      if (focusable.length) {
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (!modal.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault(); toggleSidebar(); return;
    }
    if (e.key === "Escape") {
      const sb = document.getElementById("sidebar");
      if (isMobileNav() && sb?.classList.contains("mobile-open")) {
        sb.classList.remove("mobile-open");
        syncSidebarControls();
        return;
      }
      const modal = activeModal();
      if (modal) closeModal(modal.id);
      return;
    }
    if (inField) return;
    if (e.key === "n" || e.key === "N") {
      const taskModal = document.getElementById("taskModal");
      const inDetail = !document.getElementById("detailShell")?.classList.contains("hidden");
      if (!taskModal || inDetail) return; // 仅看板页、且未打开任务详情时生效
      openNewTask();
    }
    if (e.key === "/") {
      const s = document.querySelector("#pSearch, #aSearch");
      if (s) { e.preventDefault(); s.focus(); }
    }
  });
  // 点击弹窗背景关闭
  document.addEventListener("click", e => {
    if (e.target && e.target.classList && e.target.classList.contains("modal")) {
      closeModal(e.target.id);
    }
  });
  // 目录选择器事件委托（全站共享：agents / projects / skills）
  document.addEventListener("click", e => {
    const row = e.target.closest?.(".dir-row");
    if (row) { dirLoad(row.dataset.path); return; }
    const seg = e.target.closest?.(".crumb-seg");
    if (seg && !seg.classList.contains("cur")) dirLoad(seg.dataset.p);
  });
  document.querySelector(".sidebar-nav")?.addEventListener("click", e => {
    if (isMobileNav() && e.target.closest("a")) {
      const sb = document.getElementById("sidebar");
      if (sb) { sb.classList.remove("mobile-open"); syncSidebarControls(); }
    }
  });
  document.querySelectorAll(".modal").forEach(modal => modal.setAttribute("aria-hidden", modal.classList.contains("hidden") ? "true" : "false"));
}


export function route() {
  const h = location.hash;
  const path = location.pathname;
  // 任务详情是所有页面共用的最高优先级路由。此前 projects/roles 在这里
  // 提前 return，导致从它们的任务列表只能打开简陋终端而不能进入统一详情。
  const task = /^#\/issue\/(\d+)/.exec(h);
  if (task) {
    showDetail(Number(task[1]));
    return;
  }
  if (state.selected !== null || !document.getElementById("detailShell").classList.contains("hidden")) {
    hideDetail();
  }
  if (path === "/projects") {
    const m = /^#\/project\/(\d+)/.exec(h);
    if (m) showProjectDetail(Number(m[1]));
    else if (state.projectView !== null) hideProjectDetail();
    return;
  }
  if (path === "/roles") {
    const m = /^#\/agent\/(\d+)/.exec(h);
    if (m) {
      const id = Number(m[1]);
      // 详情内允许直接切到另一个角色（比如从项目成员表点进来再切换）
      if (state.agentEditing === null || state.agentEditing.id !== id) showAgentDetail(id);
    } else if (state.agentEditing !== null) {
      hideAgentDetail();
    }
    return;
  }
  if (path === "/skills") {
    const m = /^#\/skill\/(\d+)/.exec(h);
    if (m) showSkillDetail(Number(m[1]));
    else if (state.skillDetail !== null) hideSkillDetail();
    return;
  }
}

export let ovTimer = null;

export function refreshOverviewSoon() {
  clearTimeout(ovTimer);
  ovTimer = setTimeout(refreshOverview, 600);
}

// SSE 连接管理：
// - 页面隐藏（后台标签页）时主动断开：浏览器对同域名 HTTP/1.1 最多 6 个
//   并发连接，每个页面的 SSE 长连接占一个名额；页面开多了连接池被占满，
//   新页面导航会一直排队转圈。隐藏即释放，可见时重连。
// - pagehide（导航/关页）时主动 close，不依赖浏览器异步 abort。
export function sse() {
  if (state.es) return; // 已有连接（可见性切换重连时避免重复）
  const es = new EventSource("/api/events");
  state.es = es;
  es.addEventListener("task", ev => {
    try {
      const t = JSON.parse(ev.data).payload;
      const i = state.tasks.findIndex(x => x.id === t.id);
      if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
      if (state.termTask === t.id) syncTerminalInput(t);
      const path = location.pathname;
      if (path === "/board") {
        state.view === "list" ? renderList() : renderBoard();
        refreshOverviewSoon();
      } else if (path === "/") {
        loadDashboard();
      } else if (path === "/history") {
        loadHistory();
      } else if (path === "/roles") {
        if (state.agentTab === "overview") renderAgentOverview(state.agentEditing);
      } else if (path === "/projects") {
        renderProjectList();
        if (state.projectView) refreshProjectDetail();
      }
      fillSelects();
      // 任务详情可从任一页面打开；不要只在 Dashboard / Board 收到事件时刷新。
      if (state.selected === t.id) refreshDetail();
    } catch (_) {}
  });
  es.addEventListener("log", ev => {
    try { appendLog(JSON.parse(ev.data).payload); } catch (_) {}
  });
  es.addEventListener("provision", ev => {
    try {
      const d = JSON.parse(ev.data).payload;
      if (provState.instCli && d.cli === provState.instCli) appendInstLine(d.line || "");
      if (d.line && d.line.includes("[install] 完成")) {
        setTimeout(loadProvision, 1500);
      }
    } catch (_) {}
  });
  es.addEventListener("error", () => {
    // EventSource 自动重连；只有 es.close() 后不再重连
    if (!state.es) return;
  });
}

// 页面隐藏：断开 SSE 释放连接名额；可见：重连并刷新数据（隐藏期间可能错过事件）。
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.es) { state.es.close(); state.es = null; }
    return;
  }
  if (!state.es) {
    sse();
    loadAll().then(() => {
      const path = location.pathname;
      if (path === "/") loadDashboard();
      else if (path === "/board") { renderBoard(); renderList(); refreshOverview(); }
      else if (path === "/history") loadHistory();
      else if (path === "/roles") renderAgentList();
      else if (path === "/agents") loadProvision();
      else if (path === "/projects") renderProjectList();
      else if (path === "/autopilots") renderScheduleList();
      else if (path === "/skills") loadSkillLib().then(() => { renderSkillLib(); route(); });
      else if (path === "/settings") loadSettings();
    }).catch(() => {});
  }
});

// 导航/关页：主动关闭 SSE，避免连接残留占住浏览器连接池。
window.addEventListener("pagehide", () => {
  if (state.es) { state.es.close(); state.es = null; }
});

document.addEventListener("DOMContentLoaded", async () => {
  restoreSidebar();
  initShortcuts();
  // schema（/api/agents/schema）只被角色表单/详情用到，且冷缓存时后端
  // 要跑各 CLI 的模型探测（秒级）——后台并行加载，不 await，避免首屏白屏。
  const schemaP = loadSchema();
  try { await loadAll(); } catch (e) { toast("加载失败: " + e.message, true); }
  const path = location.pathname;
  if (path === "/") {
    loadDashboard();
    loadTemplates();
  } else if (path === "/board") {
    renderBoard();
    loadTemplates();
    refreshOverview();
  } else if (path === "/history") {
    loadHistory();
  } else if (path === "/roles") {
    let av = "grid";
    try { av = localStorage.getItem("paihuo.agentView") || "grid"; } catch (_) {}
    setAgentView(av === "table" ? "table" : "grid");
  } else if (path === "/agents") {
    loadProvision();
  } else if (path === "/projects") {
    renderProjectList();
  } else if (path === "/autopilots") {
    renderScheduleList();
  } else if (path === "/skills") {
    let sv = "grid";
    try { sv = localStorage.getItem("paihuo.skillView") || "grid"; } catch (_) {}
    setSkillView(sv === "list" ? "list" : "grid");
    setSkillTab("skills");
    await loadSkillLib();
    renderSkillLib();
  } else if (path === "/settings") {
    loadSettings();
  }
  // 所有页面都能从任务列表/直链进入同一详情视图。
  route();
  window.addEventListener("hashchange", route);
  sse();
  await schemaP; // 首屏渲染不受 schema 拖累；等它落定后角色表单/详情即可直接用
});


// ===== 模板 onclick 等引用的全局函数（脚本自动生成，勿手改） =====
window.addChip = addChip;
window.agentTab = agentTab;
window.agentTabFromCard = agentTabFromCard;
window.applyFilters = applyFilters;
window.applyTemplate = applyTemplate;
window.changeRoleStudioCli = changeRoleStudioCli;
window.cleanupHistory = cleanupHistory;
window.closeAgentDetail = closeAgentDetail;
window.closeDetail = closeDetail;
window.closeInstTerminal = closeInstTerminal;
window.closeModal = closeModal;
window.closeProjectDetail = closeProjectDetail;
window.closeSkillDetail = closeSkillDetail;
window.closeTerminal = closeTerminal;
window.copyLogs = copyLogs;
window.copySkillContent = copySkillContent;
window.copyText = copyText;
window.createDefaultRole = createDefaultRole;
window.deleteAgent = deleteAgent;
window.deleteProject = deleteProject;
window.deleteSchedule = deleteSchedule;
window.deleteSelected = deleteSelected;
window.deleteSelectedSkills = deleteSelectedSkills;
window.deleteSkill = deleteSkill;
window.deleteSkillFromDetail = deleteSkillFromDetail;
window.deleteTask = deleteTask;
window.deleteTemplate = deleteTemplate;
window.endInteractiveTask = endInteractiveTask;
window.filterSkillOptions = filterSkillOptions;
window.gitInitProject = gitInitProject;
window.installProvision = installProvision;
window.loadHistory = loadHistory;
window.logout = logout;
window.mkdirCurrent = mkdirCurrent;
window.openAgentDetail = openAgentDetail;
window.openAgentModal = openAgentModal;
window.openDirPicker = openDirPicker;
window.openExtModal = openExtModal;
window.openNewTask = openNewTask;
window.openProject = openProject;
window.openProjectModal = openProjectModal;
window.openProjectTask = openProjectTask;
window.openRoleStudio = openRoleStudio;
window.openRoleStudioManual = openRoleStudioManual;
window.openScheduleModal = openScheduleModal;
window.openSkillDetail = openSkillDetail;
window.openSkillModal = openSkillModal;
window.openSubTask = openSubTask;
window.openTask = openTask;
window.openTerminal = openTerminal;
window.patchProject = patchProject;
window.patchTask = patchTask;
window.pickDir = pickDir;
window.refreshAgentCatalog = refreshAgentCatalog;
window.refreshProvision = refreshProvision;
window.rejectTask = rejectTask;
window.removeChip = removeChip;
window.removeExt = removeExt;
window.renderAgentList = renderAgentList;
window.renderAgentModalSchema = renderAgentModalSchema;
window.renderProjectList = renderProjectList;
window.renderSkillLib = renderSkillLib;
window.resumeTask = resumeTask;
window.roleStudioQuickAsk = roleStudioQuickAsk;
window.runCleanup = runCleanup;
window.saveAgentConcurrency = saveAgentConcurrency;
window.saveAgentConfig = saveAgentConfig;
window.saveAsTemplate = saveAsTemplate;
window.saveRetention = saveRetention;
window.saveRoleStudio = saveRoleStudio;
window.saveSkillTags = saveSkillTags;
window.saveWtRetention = saveWtRetention;
window.scanSkills = scanSkills;
window.selectAllNonMergeTasks = selectAllNonMergeTasks;
window.sendRoleStudioChat = sendRoleStudioChat;
window.sendRoleStudioTest = sendRoleStudioTest;
window.sendTaskInput = sendTaskInput;
window.sendTerminalInput = sendTerminalInput;
window.setAgentView = setAgentView;
window.setSkillTab = setSkillTab;
window.setSkillView = setSkillView;
window.setTaskStatus = setTaskStatus;
window.setView = setView;
window.submitAgent = submitAgent;
window.submitExt = submitExt;
window.submitProject = submitProject;
window.submitSchedule = submitSchedule;
window.submitSkill = submitSkill;
window.submitTask = submitTask;
window.syncModelThinking = syncModelThinking;
window.syncScheduleFields = syncScheduleFields;
window.syncTaskConcurrency = syncTaskConcurrency;
window.syncTaskDependency = syncTaskDependency;
window.syncTaskRunMode = syncTaskRunMode;
window.toggleAgent = toggleAgent;
window.toggleAll = toggleAll;
window.toggleAllSkills = toggleAllSkills;
window.toggleRow = toggleRow;
window.toggleSchedule = toggleSchedule;
window.toggleSidebar = toggleSidebar;
window.toggleSkill = toggleSkill;
window.toggleSkillGroup = toggleSkillGroup;
window.toggleSkillSelection = toggleSkillSelection;
window.wsDiscard = wsDiscard;

// ===== 页面生命周期 =====
