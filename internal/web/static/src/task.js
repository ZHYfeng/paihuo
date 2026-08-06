// 模块 task（由 scripts/split-frontend.py 生成）
import { BOARD_COLS, STATUS_LABEL, ST_COLOR, api, closeModal, esc, fetchTaskLogs, icon, openModal, state, toast } from "./core.js";
import { loadDashboard } from "./dashboard.js";
import { loadHistory } from "./history.js";
import { fillSelects, loadAll, refreshOverview } from "./main.js";
import { refreshProjectDetail } from "./projects.js";
import { loadTemplates } from "./skills.js";
import { INTERACTIVE_TERM_COLS, INTERACTIVE_TERM_ROWS, closeTaskTerminal, openTaskTerminal, openTerminal, sendTaskInput, taskTermAppendLog, taskTerminalText, termAppendLog } from "./terminal.js";

// 任务详情是全站共享的视图。打开时只临时隐藏当前页面原本可见的直属内容，
// 关闭后精确恢复，避免破坏项目/角色页自身的列表与详情切换状态。
let detailBackground = null;
let detailReturnHash = "#/";

export function currentFilters() {
  return {
    agent: Number(document.getElementById("fAgent")?.value) || null,
    project: Number(document.getElementById("fProject")?.value) || null,
    status: document.getElementById("fStatus")?.value || "",
  };
}

export function filteredTasks() {
  const f = currentFilters();
  return state.tasks.filter(t => {
    if (f.agent && t.agent_id !== f.agent) return false;
    if (f.project && t.project_id !== f.project) return false;
    if (f.status && t.status !== f.status) return false;
    return true;
  });
}

export function isMergeTask(t) {
  return t?.merge_of !== null && t?.merge_of !== undefined;
}

export function mergeTaskFor(source) {
  if (!source || isMergeTask(source)) return null;
  return state.tasks.find(t => isMergeTask(t) && t.merge_of === source.id) || null;
}

export function mergeBlockReason(t) {
  if (!isMergeTask(t) || t.status !== "queued") return "";
  if (!t.agent_id) return "未指派角色";
  const agent = state.agents.find(a => a.id === t.agent_id);
  if (!agent) return "角色不可用";
  return agent.enabled ? "" : "角色已停用";
}

export function taskKindChip(t) {
  return isMergeTask(t)
    ? `<span class="chip merge" title="由源任务 #${t.merge_of} 自动创建">代码合并 · #${t.merge_of}</span>`
    : `<span class="chip task-kind">实现</span>`;
}

function sourceMergeChip(t) {
  if (isMergeTask(t)) return "";
  const merge = mergeTaskFor(t);
  if (!merge) {
    return t.status === "succeeded" && t.worktree_branch
      ? `<span class="chip merge-pending">正在创建合并</span>` : "";
  }
  return `<span class="chip merge-state ${merge.status}" title="代码合并任务 #${merge.id}">合并：${STATUS_LABEL[merge.status] || merge.status}</span>`;
}

// 一个项目任务的“完成”是交付完成：源任务本身成功还不够，Git 项目还要等
// 它的系统合并任务成功写入主分支。这里和 Store.CheckTaskDependency 使用
// 相同的判定，让看板能准确解释为何一个 queued 任务还没有启动。
function sourceDeliveryInfo(source) {
  if (!source) return { state: "missing", reason: "前置任务已不存在" };
  if (isMergeTask(source)) return { state: "failed", reason: `任务 #${source.id} 是合并任务，不能作为前置` };
  switch (source.status) {
    case "queued": case "claimed": case "running":
      return { state: "pending", reason: `任务 #${source.id} 正在执行` };
    case "awaiting_review":
      return { state: "pending", reason: `任务 #${source.id} 等待审批` };
    case "failed":
      return { state: "failed", reason: `任务 #${source.id} 执行失败` };
    case "cancelled":
      return { state: "failed", reason: `任务 #${source.id} 已取消` };
    case "succeeded": {
      const merge = mergeTaskFor(source);
      if (!merge) {
        return source.worktree_branch
          ? { state: "pending", reason: `任务 #${source.id} 正在创建代码合并任务` }
          : { state: "succeeded", reason: `任务 #${source.id} 已完成` };
      }
      if (merge.status === "succeeded") return { state: "succeeded", reason: `合并任务 #${merge.id} 已完成` };
      if (merge.status === "failed") return { state: "failed", reason: `合并任务 #${merge.id} 失败` };
      if (merge.status === "cancelled") return { state: "failed", reason: `合并任务 #${merge.id} 已取消` };
      return { state: "pending", reason: `合并任务 #${merge.id} 正在处理` };
    }
    default:
      return { state: "pending", reason: `任务 #${source.id} 状态未知` };
  }
}

// dependencyInfo 将“弱依赖可跳过 / 强依赖必须成功”的后端调度规则翻译为
// 统一的界面信息。它只依赖已经加载的任务列表；真正是否领取仍以后端为准。
export function dependencyInfo(t) {
  if (isMergeTask(t)) return { mode: "system", state: "ready", label: "系统合并" };
  const mode = t.dependency_mode || "none";
  if (mode === "none") return { mode, state: "ready", label: "独立任务", reason: "不等待项目中的其他交付" };
  if (mode === "weak" && !t.depends_on) {
    return { mode, state: "ready", label: "自动顺序 · 首项", reason: "当前项目执行顺序中的第一项" };
  }
  const source = state.tasks.find(x => x.id === t.depends_on);
  const prefix = mode === "strong" ? "强依赖" : "自动顺序";
  const label = `${prefix} · #${t.depends_on || "?"}`;
  if (!source) {
    if (mode === "weak") return { mode, state: "skipped", label, reason: `前序任务 #${t.depends_on} 已删除，已跳过`, stateLabel: "前序已跳过" };
    return { mode, state: "blocked", label, reason: `明确依赖的任务 #${t.depends_on} 已删除`, stateLabel: "前序不存在" };
  }
  const delivery = sourceDeliveryInfo(source);
  if (mode === "strong") {
    if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
    return { mode, state: "blocked", label, reason: `明确依赖未成功：${delivery.reason}`, stateLabel: `等待 #${source.id}` };
  }
  if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
  if (delivery.state === "failed" || delivery.state === "missing") {
    if (!source.block_on_failure) {
      return { mode, state: "skipped", label, reason: `前序失败，已跳过：${delivery.reason}`, stateLabel: `#${source.id} 失败已跳过` };
    }
    return { mode, state: "blocked", label, reason: `前序阻塞任务未完成：${delivery.reason}`, stateLabel: `#${source.id} 失败阻塞` };
  }
  return { mode, state: "blocked", label, reason: `等待前序交付：${delivery.reason}`, stateLabel: `等待 #${source.id}` };
}

export function dependencyChip(t) {
  const info = dependencyInfo(t);
  if (info.mode === "system") return "";
  const kind = info.mode === "strong" ? "strong" : info.mode === "weak" ? "weak" : "none";
  return `<span class="chip dependency ${kind}" title="${esc(info.reason || info.label)}">${esc(info.label)}</span>`;
}

function dependencyStateChip(t) {
  if (t.status !== "queued") return "";
  const info = dependencyInfo(t);
  if (info.state === "blocked") return `<span class="chip dependency blocked" title="${esc(info.reason)}">${esc(info.stateLabel || "等待前序")}</span>`;
  if (info.state === "skipped") return `<span class="chip dependency skipped" title="${esc(info.reason)}">${esc(info.stateLabel || "前序已跳过")}</span>`;
  return "";
}

function boardColumnsHTML(tasks, mergeSection) {
  // 合并任务的失败/取消意味着源代码尚未进入主分支，不能像普通历史任务
  // 一样从看板中消失；单列保留它们，直接提供“重试合并”入口。
  const columns = mergeSection
    ? [...BOARD_COLS, ["merge-attention", "需处理", ["failed", "cancelled"]]]
    : BOARD_COLS;
  return columns.map(([key, label, statuses]) => {
    const items = tasks.filter(t => statuses.includes(t.status));
    return `<div class="board-col" style="--st-color:${ST_COLOR[statuses[0]]}">
      <div class="board-col-head">
        <span class="st-dot"></span><span>${label}</span>
        <span class="count">${items.length}</span>
      </div>
      <div class="board-col-body">
        ${items.map(cardHTML).join("") || `<div class="empty">—</div>`}
      </div>
    </div>`;
  }).join("");
}

function boardSectionHTML(kind, title, note, tasks) {
  const blocked = tasks.filter(t => mergeBlockReason(t)).length;
  const empty = kind === "merge" ? "还没有代码合并任务；实现任务完成后会自动出现在这里。" : "没有符合条件的实现任务。";
  return `<section class="board-section ${kind === "merge" ? "merge-section" : "source-section"}">
    <div class="board-section-head">
      <div><h2>${title}</h2><p>${note}</p></div>
      <div class="board-section-counts">
        <span>${tasks.length} 个</span>
        ${blocked ? `<span class="chip merge-blocked">${blocked} 个角色不可用</span>` : ""}
      </div>
    </div>
    <div class="board-section-lanes">${tasks.length ? boardColumnsHTML(tasks, kind === "merge") : `<div class="board-section-empty">${empty}</div>`}</div>
  </section>`;
}

export function renderBoard() {
  const el = document.getElementById("boardView");
  if (!el) return;
  const tasks = filteredTasks();
  const sourceTasks = tasks.filter(t => !isMergeTask(t));
  const mergeTasks = tasks.filter(isMergeTask);
  el.innerHTML =
    boardSectionHTML("source", "实现任务", "项目任务默认按创建时间顺序交付，也可在项目页调整；每项完成后会先处理自己的代码合并。", sourceTasks) +
    boardSectionHTML("merge", "代码合并", "使用新的独立 worktree 验证、解决冲突并自动写入主分支。", mergeTasks);
  const c = document.getElementById("viewCount");
  if (c) c.textContent = `${sourceTasks.length} 个实现 · ${mergeTasks.length} 个合并`;
}

export function cardHTML(t) {
  const blocked = mergeBlockReason(t);
  return `<article class="card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${taskKindChip(t)}
      ${dependencyChip(t)}
      ${dependencyStateChip(t)}
      ${sourceMergeChip(t)}
      ${blocked ? `<span class="chip merge-blocked">${blocked}</span>` : ""}
      ${t.perm === "review" ? `<span class="chip review">审批</span>` : ""}
      ${t.run_mode === "interactive" ? `<span class="chip">交互</span>` : ""}
      ${t.concurrent ? `<span class="chip">并发</span>` : ""}
      ${t.review_rounds > 0 ? `<span class="chip">第${t.review_rounds}轮</span>` : ""}
    </div>
    <a class="c-title card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
    ${t.body ? `<div class="c-desc">${esc(t.body)}</div>` : ""}
    <div class="c-meta">
      ${t.project_id && t.project_name ? `<a class="chip chip-link" href="/projects#/project/${t.project_id}" title="打开项目页" onclick="event.stopPropagation()">${esc(t.project_name)}</a>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">未指派</span>`}
        ${t.error ? `<span style="color:var(--danger)">✗</span>` : ""}
      </span>
    </div>
  </article>`;
}

export function renderList() {
  const el = document.getElementById("listBody");
  if (!el) return;
  const tasks = filteredTasks();
  el.innerHTML = tasks.map(taskListRowHTML).join("");
  const empty = document.getElementById("listEmpty");
  if (empty) empty.classList.toggle("hidden", tasks.length > 0);
  const c = document.getElementById("viewCount");
  if (c) c.textContent = `${tasks.filter(t => !isMergeTask(t)).length} 个实现 · ${tasks.filter(isMergeTask).length} 个合并`;
}

function taskListRowHTML(t) {
  const blocked = mergeBlockReason(t);
  const title = esc(t.title);
  const agent = esc(t.agent_name || "-");
  const project = esc(t.project_name || "-");
  const created = (t.created_at || "").slice(5, 16).replace("T", " ") || "—";
  const finished = (t.finished_at || "").slice(5, 16).replace("T", " ") || "—";
  const rounds = t.review_rounds || "—";
  const chips = `${taskKindChip(t)}${dependencyChip(t)}${dependencyStateChip(t)}${blocked ? `<span class="chip merge-blocked">${esc(blocked)}</span>` : ""}`;
  const status = STATUS_LABEL[t.status] || t.status || "未知";
  return `
    <tr class="task-list-row" tabindex="0" aria-label="打开任务 #${t.id}：${title}"
      onclick="openTask(${t.id})"
      onkeydown="if (event.target !== this) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTask(${t.id}); }">
      <td class="task-list-id num" data-label="ID">#${t.id}</td>
      <td class="task-list-title t-title" data-label="标题">
        <a class="table-primary-action" href="#/issue/${t.id}" title="${title}" onclick="event.stopPropagation();openTask(${t.id});return false">${title}</a>
      </td>
      <td class="task-list-type" data-label="类型"><span class="task-list-chips">${chips}</span></td>
      <td class="task-list-agent" data-label="角色"><span class="task-list-text" title="${agent}">${agent}</span></td>
      <td class="task-list-project" data-label="项目">${t.project_id ? `<a class="t-link task-list-text" href="/projects#/project/${t.project_id}" title="${project}" onclick="event.stopPropagation()">${project}</a>` : `<span class="task-list-text" title="${project}">${project}</span>`}</td>
      <td class="task-list-status" data-label="状态"><span class="badge ${esc(t.status || "unknown")}" style="--st-color:${ST_COLOR[t.status] || "var(--fg-faint)"}"><span class="st-dot"></span>${esc(status)}</span></td>
      <td class="task-list-rounds" data-label="轮次">${esc(rounds)}</td>
      <td class="task-list-date task-list-created num" data-label="创建"><time>${esc(created)}</time></td>
      <td class="task-list-date task-list-finished num" data-label="结束"><time>${esc(finished)}</time></td>
      <td class="task-list-actions" data-label="操作">
        <span class="ops">
          <button type="button" class="btn xs" title="打开任务详情" aria-label="打开任务详情" onclick="event.stopPropagation();openTask(${t.id})">${icon("expand")}<span class="task-list-action-label">详情</span></button>
          ${canRetryTask(t)
            ? `<button type="button" class="btn xs" title="${esc(retryTaskLabel(t))}" aria-label="${esc(retryTaskLabel(t))}" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}<span class="task-list-action-label">${esc(retryTaskLabel(t))}</span></button>` : ""}
          ${canDeleteTask(t) ? `<button type="button" class="btn xs danger" title="删除任务" aria-label="删除任务" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}<span class="task-list-action-label">删除</span></button>` : ""}
        </span>
      </td>
      <td class="task-list-mobile-meta" colspan="3" aria-label="任务时间与轮次">
        <span><small>轮次</small><b>${esc(rounds)}</b></span>
        <span><small>创建</small><b>${esc(created)}</b></span>
        <span><small>结束</small><b>${esc(finished)}</b></span>
      </td>
    </tr>`;
}

export function setView(v) {
  state.view = v;
  document.getElementById("segBoard").classList.toggle("active", v === "board");
  document.getElementById("segList").classList.toggle("active", v === "list");
  document.getElementById("boardView").classList.toggle("hidden", v !== "board");
  document.getElementById("listView").classList.toggle("hidden", v !== "list");
  if (v === "list") renderList(); else renderBoard();
}

export function applyFilters() {
  const pl = document.getElementById("fProjectLink");
  const pv = Number(document.getElementById("fProject")?.value) || null;
  if (pl) {
    if (pv) { pl.href = `/projects#/project/${pv}`; pl.style.display = ""; }
    else pl.style.display = "none";
  }
  state.view === "list" ? renderList() : renderBoard();
}

/* ============================================================
   任务详情（两栏）
   ============================================================ */

export function openTask(id) {
  if (!/^#\/issue\/\d+$/.test(location.hash)) detailReturnHash = location.hash || "#/";
  location.hash = "#/issue/" + id;
}

export function closeDetail() {
  const back = detailReturnHash || "#/";
  detailReturnHash = "#/";
  location.hash = back;
}

export function showDetail(id) {
  const changed = state.selected !== id;
  state.selected = id;
  if (changed) {
    state.logsTask = id;
    state.logs = [];
    state.logsHasMore = false;
    state.logsLoading = false;
    state.logsOldestSeq = 0;
    state.logsTotal = 0;
  }
  const main = document.querySelector(".main");
  const detailShell = document.getElementById("detailShell");
  if (!detailShell) return;
  // 详情两栏页接管主区。项目、角色等页面也各有自己的详情壳，不能只按
  // board/dashboard 的 id 隐藏；记录本来可见的直属元素，返回时原样恢复。
  if (detailBackground === null) {
    detailBackground = [];
    for (const child of main?.children || []) {
      if (child === detailShell || child.classList.contains("hidden")) continue;
      child.classList.add("hidden");
      detailBackground.push(child);
    }
  }
  detailShell.classList.remove("hidden");
  const t = state.tasks.find(x => x.id === id);
  if (t) {
    document.getElementById("dCrumb").innerHTML = `任务 / <b>#${t.id}</b>`;
    document.getElementById("dBadge").innerHTML =
      `<span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>`;
  }
  refreshDetail(changed);
}

export function hideDetail() {
  closeTaskTerminal();
  document.getElementById("detailShell")?.classList.add("hidden");
  for (const child of detailBackground || []) child.classList.remove("hidden");
  detailBackground = null;
  state.selected = null;
  state.logsTask = null;
  state.logs = [];
  state.logsHasMore = false;
  state.logsOldestSeq = 0;
  state.logsTotal = 0;
}

export async function refreshDetail(reloadLogs = false) {
  if (!state.selected) return;
  const id = state.selected;
  const shouldLoadLogs = reloadLogs || state.logsTask !== id;
  const liveLogs = shouldLoadLogs ? state.logs : [];
  try {
    const [task, page] = await Promise.all([
      api(`/api/tasks/${id}`), shouldLoadLogs ? fetchTaskLogs(id, { limit: 200 }) : Promise.resolve(null),
    ]);
    if (state.selected !== id) return;
    const i = state.tasks.findIndex(x => x.id === task.id);
    if (i >= 0) state.tasks[i] = task; else state.tasks.unshift(task);
    if (page) {
      const byID = new Map(page.logs.map(l => [l.id, l]));
      for (const l of liveLogs) if (!byID.has(l.id)) byID.set(l.id, l);
      const merged = [...byID.values()].sort((a, b) => a.seq - b.seq);
      state.logsTask = id;
      state.logs = merged;
      state.logsHasMore = page.has_more;
      state.logsOldestSeq = merged.length ? merged[0].seq : 0;
      state.logsTotal = Math.max(page.total, merged.length);
    }
    renderDetail(task);
  } catch (_) { /* 任务已删除 */ }
}

export function renderDetail(t) {
  const main = document.getElementById("dMain");
  if (!main) return;
  const mergeTask = isMergeTask(t);
  const mergeSource = mergeTask ? state.tasks.find(x => x.id === t.merge_of) : null;
  const dependency = dependencyInfo(t);
  const interactive = t.run_mode === "interactive";
  const isInteractive = interactive && t.status === "running";
  const isLive = ["claimed", "running"].includes(t.status);
  const agent = state.agents.find(a => a.id === t.agent_id);
  const agentName = t.agent_name || "未指派";
  const agentCli = agent?.cli || "";
  const runMode = t.run_mode === "interactive" ? "交互式" : "批处理";
  const bodyLength = (t.body || "").length;
  const createdAt = (t.created_at || "").slice(0, 16).replace("T", " ");
  const { visible: visibleLogs, errors: logErrors } = logStats();
  const logMeta = interactive
    ? `${isLive ? "实时画面" : "已归档画面"} · ${INTERACTIVE_TERM_COLS} × ${INTERACTIVE_TERM_ROWS}`
    : state.logsHasMore
      ? `已加载 ${visibleLogs}/${state.logsTotal} 条`
      : `${visibleLogs} 条`;
  const dependencyAlert = !mergeTask && t.status === "queued" && dependency.state !== "ready"
    ? `<div class="task-alert"><span class="task-alert-title">${dependency.state === "skipped" ? "前序交付已跳过" : "等待前置交付"}</span><span>${esc(dependency.reason || "等待调度")}</span></div>` : "";
  const input = isInteractive ? `<div class="term-input detail-input terminal-input-help">
      <span>点击终端直接输入 · Tab / ↑ / ↓ 由当前 CLI 处理 · <code>/exit</code> 结束</span>
      <button class="btn sm" onclick="focusTaskTerminal()">聚焦输入</button>
    </div>` : "";
  main.innerHTML = `
    <section class="task-hero">
      <div class="task-kicker"><span>${mergeTask ? `代码合并任务 · 来源 #${t.merge_of}` : `实现任务 #${t.id}`}</span><span>创建于 ${esc(createdAt)}</span></div>
      <h2>${esc(t.title)}</h2>
      <div class="task-meta">
        <span class="task-meta-item"><span class="avatar sm${agentCli ? ` av-${esc(agentCli)}` : ""}">${esc(agentName.slice(0, 1))}</span>${esc(agentName)}</span>
        ${t.project_name ? `<span class="task-meta-item">${esc(t.project_name)}</span>` : ""}
        <span class="task-meta-item">${runMode}</span>
        ${mergeTask ? "" : dependencyChip(t)}
        ${!mergeTask && dependencyStateChip(t)}
        ${mergeTask ? `<span class="task-meta-item task-meta-accent">${mergeSource ? `源任务：#${mergeSource.id}` : `源任务：#${t.merge_of}`}</span>` : sourceMergeChip(t)}
        ${t.resume_of ? `<span class="task-meta-item task-meta-accent">续跑自 #${t.resume_of}</span>` : ""}
      </div>
    </section>
    ${t.body ? `<details class="task-section task-prompt"${bodyLength <= 160 ? " open" : ""}>
      <summary><span>任务说明</span><span class="section-meta">${bodyLength} 字</span></summary>
      <div class="task-prompt-body">${esc(t.body)}</div>
    </details>` : ""}
    ${dependencyAlert}
    ${t.error ? `<div class="task-alert"><span class="task-alert-title">${mergeTask ? "代码合并失败" : "任务失败"}</span><span>${esc(t.error)}</span></div>` : ""}
    <div id="childrenBox"></div>
    ${t.status === "awaiting_review" ? `<details class="task-section task-diff" open>
      <summary><span>代码改动</span><span class="section-meta">等待审批</span></summary>
      <div id="diffBox"><div class="empty">加载改动中...</div></div>
    </details>` : ""}
    <details class="task-section task-log-section${interactive ? " interactive-task-log" : ""}"${isLive ? " open" : ""}>
      <summary><span>${interactive ? "交互终端" : "执行记录"}</span><span class="section-meta" id="logMeta">${logMeta}${logErrors && !interactive ? ` · ${logErrors} 个错误` : ""}</span></summary>
      <div class="section-head">
        <div class="section-sub">${esc(agentName)} · ${runMode}</div>
        <div class="section-tools">
          <button class="btn ghost xs" onclick="copyLogs()">${icon("copy")}${interactive ? "复制画面" : "复制"}</button>
          <button class="btn ghost xs" onclick="openTerminal(${t.id})">${icon("expand")}全屏</button>
        </div>
      </div>
      <div class="term">
      <div class="term-head">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="t-title" title="${esc(t.project_dir || "")}">${esc(agentName)} · ${runMode}</span>
      </div>
      ${interactive
        ? `<div class="term-body interactive-term-body" id="logBox" role="region" aria-label="${esc(agentName)} 交互式终端画面"><div class="interactive-term-canvas" id="taskTermX"></div></div>`
        : `<div class="term-body" id="logBox">${logsHTML()}</div>`}
      ${input}
      </div>
    </details>
    <details class="task-section task-workspace">
      <summary><span>工作空间</span><span class="section-meta">Git / worktree 信息</span></summary>
      <div id="wsBox"><div class="empty">加载中...</div></div>
    </details>`;
  const box = document.getElementById("logBox");
  const logSection = main.querySelector(".task-log-section");
  const mountInteractiveTerminal = () => {
    if (interactive && logSection?.open) openTaskTerminal(t.id, state.logs, t.status === "running");
    else closeTaskTerminal();
  };
  if (interactive) {
    mountInteractiveTerminal();
    logSection?.addEventListener("toggle", mountInteractiveTerminal);
  } else if (box) {
    closeTaskTerminal();
    box.scrollTop = box.scrollHeight;
    box.addEventListener("scroll", () => {
      if (box.scrollTop <= 64) loadOlderLogs(box, t.id);
    }, { passive: true });
  }
  if (t.status === "awaiting_review") loadDiff(t.id);
  loadChildren(t.id);
  loadWorkspace(t.id);
  renderSide(t);
}

/* ---- 工作空间（git worktree 隔离） ---- */

export async function loadWorkspace(id) {
  const box = document.getElementById("wsBox");
  if (!box) return;
  try {
    const w = await api(`/api/workspace/${id}`);
    const t = state.tasks.find(x => x.id === id) || {};
    const done = ["succeeded", "failed", "cancelled"].includes(t.status);
    const mergeTask = isMergeTask(t);
    const sourceMerge = mergeTaskFor(t);
    const sourceAwaitingMerge = !mergeTask && t.status === "succeeded";
    if (!w.is_git) {
      box.innerHTML = `<div class="ws-row"><span class="ws-label">隔离</span><span class="ws-val">项目非 git 仓库，任务直接在项目目录执行</span>` +
        `<button class="btn xs" onclick="gitInitProject('${esc(w.path)}', ${id})">git init</button></div>`;
      return;
    }
    if (!w.is_worktree) {
      box.innerHTML = `<div class="ws-row"><span class="ws-label">隔离</span><span class="ws-val">${esc(w.note || "无独立工作空间")}</span></div>`;
      return;
    }
    box.innerHTML = `
      <div class="ws-row"><span class="ws-label">分支</span><span class="ws-val mono">${esc(w.branch)}</span></div>
      <div class="ws-row"><span class="ws-label">HEAD</span><span class="ws-val mono">${esc(w.head || "-")}` +
      (w.dirty ? ` <span class="ws-tag dirty">dirty</span>` : "") +
      (w.ahead > 0 ? ` <span class="ws-tag ahead">+${w.ahead}</span>` : "") +
      `</span></div>
      <div class="ws-row"><span class="ws-label">路径</span><span class="ws-val mono" title="${esc(w.path)}">${esc(w.path)}</span></div>` +
      (done ? workspaceActionsHTML(t, sourceMerge, sourceAwaitingMerge, id) : "");
  } catch (_) { box.innerHTML = `<div class="empty">工作空间信息不可用</div>`; }
}

function workspaceActionsHTML(t, sourceMerge, sourceAwaitingMerge, id) {
  if (isMergeTask(t)) {
    if (t.status === "succeeded") {
      return `<div class="ws-actions"><span class="ws-val">代码已由本合并任务自动写入主分支</span>` +
        `<button class="btn sm danger" onclick="wsDiscard(${id})">清理工作空间</button></div>`;
    }
    const action = t.status === "failed" || t.status === "cancelled" ? "请使用“重试合并”继续处理。" : "代码将由本合并任务成功结算时自动写入主分支。";
    return `<div class="ws-actions"><span class="ws-val">${action}</span></div>`;
  }
  if (sourceAwaitingMerge) {
    if (sourceMerge) {
      return `<div class="ws-actions"><span class="ws-val">代码由合并任务 #${sourceMerge.id}（${STATUS_LABEL[sourceMerge.status] || sourceMerge.status}）处理</span></div>`;
    }
    return `<div class="ws-actions"><span class="ws-val">代码已完成，系统正在补建代码合并任务</span></div>`;
  }
  return `<div class="ws-actions"><button class="btn sm danger" onclick="wsDiscard(${id})">丢弃</button></div>`;
}

export async function wsDiscard(id) {
  if (!confirm(`丢弃任务 #${id} 的工作空间？分支与 worktree 将删除，改动不可恢复。`)) return;
  try {
    await api(`/api/workspace/${id}/discard`, { method: "POST" });
    toast("已丢弃");
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

export async function gitInitProject(path, id) {
  if (!confirm(`在 ${path} 初始化 git 仓库？之后的任务将获得独立 worktree。`)) return;
  try {
    await api("/api/workspace/git-init", { method: "POST", body: JSON.stringify({ path }) });
    toast("已初始化");
    loadWorkspace(id);
  } catch (e) { toast(e.message, true); }
}

export function renderSide(t) {
  const side = document.getElementById("dSide");
  if (!side) return;
  const mergeTask = isMergeTask(t);
  const dependency = dependencyInfo(t);
  const mergeBlocked = mergeBlockReason(t);
  const statusOpts = Object.keys(STATUS_LABEL).map(s =>
    `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
  // 和新建任务保持一致：只能新指派启用中的角色；但若当前角色后来被
  // 停用，仍保留该选项，避免详情页显示为空、也方便改派到其他角色。
  const agentOpts = `<option value="">不指派</option>` + state.agents
    .filter(a => a.enabled || a.id === t.agent_id)
    .map(a => `<option value="${a.id}" ${a.id === t.agent_id ? "selected" : ""}>${esc(a.name)}</option>`)
    .join("");
  const pOpts = `<option value="">无项目</option>` + state.projects.map(p =>
    `<option value="${p.id}" ${t.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const canMoveProject = t.dependency_mode === "none" && !t.depends_on;
  let primaryActions = "";
  let secondaryActions = "";
  if (["queued", "claimed", "running"].includes(t.status)) {
    primaryActions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}取消任务</button>`;
  }
  if (t.run_mode === "interactive" && t.status === "running") {
    primaryActions += `<button class="btn sm" onclick="endInteractiveTask(${t.id})">${icon("terminal")}结束会话</button>`;
  }
  if (t.status === "awaiting_review") {
    primaryActions += `<button class="btn sm brand" onclick="setTaskStatus(${t.id},'succeeded')">${icon("check")}通过并派发合并</button>`;
    primaryActions += `<button class="btn sm" onclick="rejectTask(${t.id})">${icon("retry")}驳回重做</button>`;
    primaryActions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}取消</button>`;
  }
  if (canRetryTask(t)) {
    primaryActions += `<button class="btn sm" onclick="setTaskStatus(${t.id},'queued')">${icon("retry")}${retryTaskLabel(t)}</button>`;
    if (!mergeTask) secondaryActions += `<button class="btn sm" onclick="resumeTask(${t.id})">${icon("terminal")}继续对话</button>`;
  }
  if (mergeTask) {
    if (mergeBlocked) primaryActions += `<span class="side-muted">${mergeBlocked}；启用原角色后将自动执行。</span>`;
    secondaryActions += `<button class="btn sm" onclick="openTask(${t.merge_of})">${icon("back")}打开源任务 #${t.merge_of}</button>`;
  } else {
    secondaryActions += `<button class="btn sm" onclick="openSubTask(${t.id})">${icon("plus")}拆分子任务</button>`;
    if (t.body) secondaryActions += `<button class="btn sm" onclick="saveAsTemplate(${t.id})">${icon("bookmark")}保存为模板</button>`;
    secondaryActions += `<button class="btn sm danger" onclick="deleteTask(${t.id})">${icon("trash")}删除任务</button>`;
  }

  const runInfo = `
    <div class="prop-row"><span class="k">执行器</span><span class="v">tmux · ${["claimed", "running"].includes(t.status) ? `paihuo:task-${t.id}` : "日志已归档"}</span></div>
    <div class="prop-row"><span class="k">目录</span><span class="v prop-mono" title="${esc(t.project_dir || "")}">${esc(t.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">审批轮次</span><span class="v">${t.review_rounds || "-"}</span></div>
    <div class="prop-row"><span class="k">开始</span><span class="v">${esc((t.started_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="prop-row"><span class="k">结束</span><span class="v">${esc((t.finished_at || "-").slice(0, 16).replace("T", " "))}</span></div>`;

  const properties = mergeTask ? `
    <details class="side-collapse side-properties" open>
      <summary><span>合并任务属性</span><span class="section-meta">系统管理</span></summary>
      <div class="side-collapse-body">
        <div class="prop-row"><span class="k">来源</span><span class="v"><button class="btn xs" onclick="openTask(${t.merge_of})">任务 #${t.merge_of}</button></span></div>
        <div class="prop-row"><span class="k">状态</span><span class="v">${STATUS_LABEL[t.status] || t.status}</span></div>
        <div class="prop-row"><span class="k">角色</span><span class="v">${esc(t.agent_name || "未指派")}${mergeBlocked ? ` · ${mergeBlocked}` : ""}</span></div>
        <div class="prop-row"><span class="k">策略</span><span class="v">独立 worktree · 串行 · 自动写入主分支${mergeSource?.block_on_failure ? " · 失败阻塞后续自动任务" : " · 失败可跳过"}</span></div>
      </div>
    </details>` : `
    <details class="side-collapse side-properties">
      <summary><span>任务属性</span><span class="section-meta">可编辑</span></summary>
      <div class="side-collapse-body">
        <div class="prop-row"><span class="k">状态</span>
          <span class="v"><select onchange="patchTask(${t.id},{status:this.value})">${statusOpts}</select></span></div>
        <div class="prop-row"><span class="k">项目</span>
          <span class="v"><select ${canMoveProject ? "" : "disabled title=\"有前置依赖的任务不能改项目\""} onchange="patchTask(${t.id},{project_id:this.value||null})">${pOpts}</select></span></div>
        <div class="prop-row"><span class="k">角色</span>
          <span class="v"><select aria-label="任务角色" onchange="patchTask(${t.id},{agent_id:Number(this.value)||null})">${agentOpts}</select></span></div>
        <div class="prop-row"><span class="k">权限</span><span class="v">${t.perm === "full" ? "自动合并" : "审批后合并"}</span></div>
        <div class="prop-row"><span class="k">方式</span><span class="v">${t.run_mode === "interactive" ? "交互式" : "批处理"}</span></div>
        <div class="prop-row"><span class="k">前置交付</span><span class="v">${dependencyChip(t)}${dependency.state !== "ready" ? ` <span title="${esc(dependency.reason || "")}">${esc(dependency.stateLabel || dependency.reason || "等待")}</span>` : ""}</span></div>
        <div class="prop-row"><span class="k">失败后</span>
          <span class="v"><select onchange="patchTask(${t.id},{block_on_failure:this.value==='1'})">
            <option value="0" ${t.block_on_failure ? "" : "selected"}>后续弱依赖可跳过</option>
            <option value="1" ${t.block_on_failure ? "selected" : ""}>阻塞后续弱依赖</option>
          </select></span></div>
        <div class="prop-row"><span class="k">并发</span>
          <span class="v"><select onchange="patchTask(${t.id},{concurrent:this.value==='1'})">
            <option value="0" ${t.concurrent ? "" : "selected"}>不重叠执行（默认）</option>
            <option value="1" ${t.concurrent ? "selected" : ""}>允许资源并发</option>
          </select></span></div>
      </div>
    </details>`;

  side.innerHTML = `
    ${properties}
    <details class="side-collapse">
      <summary><span>运行信息</span><span class="section-meta">技术细节</span></summary>
      <div class="side-collapse-body">${runInfo}</div>
    </details>
    <section class="side-actions">
      <div class="side-heading">下一步</div>
      <div class="detail-actions">${primaryActions || `<span class="side-muted">暂无需要处理的操作</span>`}</div>
      ${secondaryActions ? `<details class="side-more-actions">
        <summary>更多操作</summary>
        <div class="detail-actions">${secondaryActions}</div>
      </details>` : ""}
    </section>`;
}

export async function patchTask(id, set) {
  try {
    const task = await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(set) });
    const i = state.tasks.findIndex(t => t.id === task.id);
    if (i >= 0) state.tasks[i] = task; else state.tasks.unshift(task);
    if (state.selected === id) renderDetail(task);
    if (location.pathname === "/board") {
      state.view === "list" ? renderList() : renderBoard();
    } else if (location.pathname === "/") {
      loadDashboard();
    } else if (location.pathname === "/history") {
      loadHistory();
    } else if (location.pathname === "/projects" && state.projectView) {
      refreshProjectDetail();
    }
    toast("已更新");
  } catch (e) { toast(e.message, true); }
}

export async function setTaskStatus(id, status) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (status === "succeeded") toast("已审批，代码合并任务已派发");
    if (status === "queued" && location.pathname === "/history") { location.href = "/"; return; }
    await loadAll();
    const p = location.pathname;
    if (p === "/" || p === "/board") {
      if (state.selected === id && location.hash.startsWith("#/issue/")) showDetail(id);
      if (p === "/") loadDashboard();
    } else if (p === "/history") {
      loadHistory();
    } else if (p === "/projects" && state.projectView) {
      refreshProjectDetail();
    }
  } catch (e) { toast(e.message, true); }
}

export async function endInteractiveTask(id) {
  if (!confirm("向当前终端发送 /exit 并结束交互会话？任务会按正常退出结果结算。")) return;
  if (await sendTaskInput(id, "", "/exit")) {
    toast("已发送 /exit，等待当前 CLI 退出");
  }
}

export async function rejectTask(id) {
  const note = prompt("驳回原因 / 修改意见（将追加到任务提示词，重新执行）");
  if (note === null) return;
  try {
    await api(`/api/tasks/${id}`, {
      method: "PATCH", body: JSON.stringify({ status: "queued", review_note: note }),
    });
    toast("已驳回，任务重新执行");
    await loadAll();
    showDetail(id);
  } catch (e) { toast(e.message, true); }
}

export async function deleteTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (isMergeTask(task)) return toast("代码合并任务不能单独删除；请重试它，或删除源任务以放弃整组代码", true);
  if (!confirm(`删除任务 #${id}？执行日志、worktree、任务分支及其合并子任务将一并删除。`)) return;
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast("已删除");
    await loadAll();
    const p = location.pathname;
    if (state.selected === id) closeDetail();
    if (p === "/history") loadHistory();
    if (p === "/projects" && state.projectView) refreshProjectDetail();
    if (p === "/") loadDashboard();
    if (p === "/board") { renderBoard(); renderList(); }
  } catch (e) { toast(e.message, true); }
}

export function canRetryTask(t) {
  if (!["succeeded", "failed", "cancelled"].includes(t.status)) return false;
  if (isMergeTask(t)) return ["failed", "cancelled"].includes(t.status);
  return !(t.status === "succeeded" && (t.worktree_branch || mergeTaskFor(t)));
}

export function retryTaskLabel(t) {
  return isMergeTask(t) ? "重试合并" : "重试";
}

export function canDeleteTask(t) {
  return !isMergeTask(t);
}

/* 子任务 */
export async function loadChildren(id) {
  try {
    const kids = await api(`/api/tasks/${id}/children`);
    const box = document.getElementById("childrenBox");
    if (!box || !kids.length) return;
    const sourceKids = kids.filter(k => !isMergeTask(k));
    const mergeKids = kids.filter(isMergeTask);
    const section = (title, items, open, merge) => {
      if (!items.length) return "";
      const done = items.filter(k => ["succeeded", "failed", "cancelled"].includes(k.status)).length;
      return `<details class="task-section task-subtasks ${merge ? "task-merge-children" : ""}"${open ? " open" : ""}>
        <summary><span>${title}</span><span class="section-meta">${done}/${items.length} 已结束</span></summary>
        <div class="task-subtask-list">` +
        items.map(k => `<div class="task-subtask" onclick="openTask(${k.id})">
          <a class="c-title card-primary-action" href="#/issue/${k.id}" onclick="event.stopPropagation();openTask(${k.id});return false">#${k.id} ${esc(k.title)}</a>
          <div class="c-meta">${isMergeTask(k) ? `<span class="chip merge">代码合并</span>` : ""}<span class="badge ${k.status}" style="--st-color:${ST_COLOR[k.status]}"><span class="st-dot"></span>${STATUS_LABEL[k.status]}</span>
          <span style="font-size:11px;color:var(--fg-faint)">${esc(k.agent_name || "")}</span></div>
        </div>`).join("") + `</div></details>`;
    };
    const sourceActive = sourceKids.some(k => ["queued", "claimed", "running", "awaiting_review"].includes(k.status));
    const mergeActive = mergeKids.some(k => ["queued", "claimed", "running", "awaiting_review"].includes(k.status));
    box.innerHTML = section("子任务", sourceKids, sourceActive, false) + section("代码合并任务", mergeKids, mergeActive, true);
  } catch (_) {}
}

export function openSubTask(parentId) {
  fillSelects();
  const t = state.tasks.find(x => x.id === parentId);
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = t ? t.perm : "full";
  document.getElementById("tRunMode").value = "batch";
  document.getElementById("tConcurrent").checked = false;
  document.getElementById("tProject").value = t && t.project_id ? t.project_id : "";
  document.getElementById("tDependencyMode").value = t && t.project_id ? "weak" : "none";
  document.getElementById("tBlockOnFailure").checked = false;
  document.getElementById("tParentId").value = parentId;
  document.getElementById("taskModalTitle").textContent = "拆分子任务";
  syncTaskRunMode();
  syncTaskDependency();
  openModal("taskModal");
}

/* ---- 续跑：原任务继续 ---- */

export async function resumeTask(id) {
  if (!confirm(`继续任务 #${id}？将保留任务编号、任务会话目录、工作空间和历史记录，重新排队执行。`)) return;
  try {
    const t = await api(`/api/tasks/${id}/resume`, { method: "POST" });
    toast(`任务 #${t.id} 已在原任务中重新排队`);
    await loadAll();
    openTask(t.id);
    if (state.selected === t.id) showDetail(t.id);
  } catch (e) { toast(e.message, true); }
}

/* diff */
export async function loadDiff(id) {
  try {
    const d = await api(`/api/tasks/${id}/diff`);
    const box = document.getElementById("diffBox");
    if (!box) return;
    const stat = d.stat.trim();
    const diff = d.diff.trim();
    if (!stat && !diff) {
      box.innerHTML = `<div class="detail-desc">无文件改动或非 git 仓库${d.note ? "（" + esc(d.note) + "）" : ""}</div>`;
      return;
    }
    box.innerHTML = `<div class="detail-desc" style="color:var(--success)">文件改动（git diff）${d.branch ? ` · 分支 <code class="mono">${esc(d.branch)}</code>` : ""}：</div>
      <div class="term"><div class="term-body" style="max-height:180px">${esc(stat)}</div></div>
      ${diff ? `<div class="term"><div class="term-body" style="max-height:300px">${esc(diff).split("\n").map(l =>
        `<div class="line"><span class="c ${l.startsWith("+") && !l.startsWith("+++") ? "out" : l.startsWith("-") && !l.startsWith("---") ? "err" : "sys"}">${esc(l)}</span></div>`).join("")}</div></div>` : ""}`;
  } catch (_) {}
}

/* 终端对话 */
export function tsOf(l) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(l.created_at || "");
  return m ? m[1] : "";
}

// Codex 等 CLI 会把颜色、光标移动和进度条控制符写进 stdout。详情页是
// 阅读视图，不需要这些终端控制码；全屏 xterm 仍保留原始输出以便排查。
const ANSI_OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const ANSI_CHAR_RE = /\u001b[()][0-2A-Z]/g;
const ANSI_RE = /\u001b[@-_]/g;

export function cleanLogContent(content) {
  let text = String(content ?? "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_CHAR_RE, "")
    .replace(ANSI_RE, "")
    .replace(/\u0000/g, "");
  // \r 是终端进度条的“回到行首”。持久化时它和普通文本在同一行，
  // 阅读视图取最后一次绘制结果，避免出现一整串重叠的状态信息。
  text = text.split("\n").map(line => {
    const parts = line.split("\r");
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] !== "") return parts[i];
    }
    return "";
  }).join("\n");
  return text;
}

export function logStats() {
  let visible = 0;
  let errors = 0;
  for (const l of state.logs) {
    if (cleanLogContent(l.content).trim()) visible++;
    if (l.stream === "err") errors++;
  }
  return { visible, errors };
}

function updateLogMeta() {
  const meta = document.getElementById("logMeta");
  if (!meta) return;
  const task = state.tasks.find(t => t.id === state.selected);
  if (task?.run_mode === "interactive") {
    const live = ["claimed", "running"].includes(task.status);
    meta.textContent = `${live ? "实时画面" : "已归档画面"} · ${INTERACTIVE_TERM_COLS} × ${INTERACTIVE_TERM_ROWS}`;
    return;
  }
  const { visible, errors } = logStats();
  const count = state.logsHasMore ? `已加载 ${visible}/${state.logsTotal} 条` : `${visible} 条`;
  meta.textContent = count + (errors ? ` · ${errors} 个错误` : "");
}

// 详情页只保留当前日志窗口。向顶部滑动时加载更早的一页，并补偿新增
// DOM 高度，避免用户的阅读位置因 prepend 跳动。
async function loadOlderLogs(box, id) {
  if (state.selected !== id || state.logsTask !== id || !state.logsHasMore || state.logsLoading) return;
  const before = state.logsOldestSeq;
  if (!before) return;
  state.logsLoading = true;
  try {
    const page = await fetchTaskLogs(id, { before, limit: 200 });
    if (state.selected !== id || !box.isConnected) return;
    const existing = new Set(state.logs.map(l => l.id));
    const older = page.logs.filter(l => !existing.has(l.id));
    if (!older.length) {
      state.logsHasMore = false;
      updateLogMeta();
      return;
    }
    const height = box.scrollHeight;
    const top = box.scrollTop;
    state.logs = [...older, ...state.logs];
    state.logsHasMore = page.has_more;
    state.logsOldestSeq = state.logs[0]?.seq || 0;
    state.logsTotal = page.total;
    box.insertAdjacentHTML("afterbegin", older.map(logLineHTML).filter(Boolean).join(""));
    requestAnimationFrame(() => { box.scrollTop = top + box.scrollHeight - height; });
    updateLogMeta();
  } catch (_) {
    // 下次继续滑到顶部时重试，避免一次网络抖动把历史日志永久隐藏。
  } finally {
    state.logsLoading = false;
  }
}

export function logLineHTML(l) {
  const content = cleanLogContent(l.content);
  if (!content.trim() && l.stream !== "sys") return "";
  return `<div class="line"><span class="ts">${tsOf(l)}</span><span class="c ${l.stream}">${esc(content)}</span></div>`;
}

export function logsHTML() {
  return state.logs.map(logLineHTML).filter(Boolean).join("");
}

export function appendLog(l) {
  if (state.selected === l.task_id) {
    if (state.logs.some(existing => existing.id === l.id)) return;
    state.logs.push(l);
    state.logsTotal = Math.max(state.logsTotal + 1, state.logs.length);
    const box = document.getElementById("logBox");
    if (box) {
      const task = state.tasks.find(t => t.id === l.task_id);
      if (task?.run_mode === "interactive") {
        taskTermAppendLog(l);
      } else {
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
        box.insertAdjacentHTML("beforeend", logLineHTML(l));
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
      updateLogMeta();
    }
  }
  termAppendLog(l);
}

export async function copyLogs() {
  try {
    if (!state.selected) return;
    const task = state.tasks.find(t => t.id === state.selected);
    const terminalView = task?.run_mode === "interactive" ? taskTerminalText() : "";
    if (terminalView.trim()) {
      await navigator.clipboard.writeText(terminalView);
      toast("已复制当前终端画面");
      return;
    }
    const page = await fetchTaskLogs(state.selected, { all: true });
    await navigator.clipboard.writeText(page.logs.map(l => cleanLogContent(l.content)).filter(Boolean).join("\n"));
    toast("已复制对话内容");
  } catch (_) { toast("复制失败", true); }
}

/* ---- 全屏终端（xterm.js 渲染：ANSI 颜色 / 真实终端感） ---- */
export function openNewTask() {
  fillSelects();
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = "full";
  document.getElementById("tRunMode").value = "batch";
  document.getElementById("tConcurrent").checked = false;
  document.getElementById("tProject").value = "";
  document.getElementById("tDependencyMode").value = "none";
  document.getElementById("tBlockOnFailure").checked = false;
  document.getElementById("tParentId").value = "";
  document.getElementById("taskModalTitle").textContent = "新建任务";
  syncTaskRunMode();
  syncTaskDependency();
  openModal("taskModal");
}

// 项目页直接派活：打开新建任务弹窗并预选项目
// （当前项目状态 active 才允许派活，已归档项目不提供入口）
export function openProjectTask(projectId) {
  const p = state.projects.find(x => x.id === projectId);
  fillSelects();
  document.getElementById("tTitle").value = "";
  document.getElementById("tBody").value = "";
  document.getElementById("tPerm").value = "full";
  document.getElementById("tRunMode").value = "batch";
  document.getElementById("tConcurrent").checked = false;
  document.getElementById("tProject").value = projectId;
  document.getElementById("tDependencyMode").value = "weak";
  document.getElementById("tBlockOnFailure").checked = false;
  document.getElementById("tParentId").value = "";
  document.getElementById("taskModalTitle").textContent = p ? `新建任务 · ${esc(p.name)}` : "新建任务";
  syncTaskRunMode();
  syncTaskDependency();
  openModal("taskModal");
}

// 交互式是任务级能力，必须先指派角色。前端即时说明限制，服务端会再次
// 验证，避免手写请求创建没有执行目标的交互任务。
export function syncTaskRunMode() {
  const agentID = Number(document.getElementById("tAgent")?.value) || 0;
  const agent = state.agents.find(a => a.id === agentID);
  const select = document.getElementById("tRunMode");
  const help = document.getElementById("tRunModeHelp");
  if (!select) return;
  const interactive = select.querySelector('option[value="interactive"]');
  if (interactive) interactive.disabled = !agent;
  if (!agent && select.value === "interactive") select.value = "batch";
  if (help) {
    help.textContent = agent
      ? `批处理会自动结算；交互式会保留 ${agent.name} 的原生终端，直到你发送 /exit。`
      : "批处理会自动结算；选择角色后可启用其交互式终端。";
  }
}

// 项目任务默认采用弱依赖：Store 会在同一事务中把它连到此前创建的实现
// 任务。强依赖只在这里让用户选择目标；合并子任务不会出现在候选中。
export function syncTaskDependency() {
  const projectID = Number(document.getElementById("tProject")?.value) || null;
  const modeEl = document.getElementById("tDependencyMode");
  const dependsEl = document.getElementById("tDependsOn");
  const row = document.getElementById("tDependsOnRow");
  const help = document.getElementById("tDependencyHelp");
  if (!modeEl || !dependsEl || !row) return;
  if (!projectID) modeEl.value = "none";
  let mode = modeEl.value || (projectID ? "weak" : "none");
  if (!["none", "weak", "strong"].includes(mode)) mode = projectID ? "weak" : "none";
  if (!projectID && mode !== "none") mode = "none";
  modeEl.value = mode;

  const selected = Number(dependsEl.value) || null;
  const candidates = projectID ? state.tasks
    .filter(t => t.project_id === projectID && !isMergeTask(t))
    .sort((a, b) => b.id - a.id) : [];
  dependsEl.innerHTML = `<option value="">选择前置实现任务</option>` + candidates.map(t =>
    `<option value="${t.id}">#${t.id} · ${esc(t.title)}</option>`).join("");
  if (selected && candidates.some(t => t.id === selected)) dependsEl.value = selected;

  const strong = projectID && mode === "strong";
  row.classList.toggle("hidden", !strong);
  dependsEl.disabled = !strong;
  if (help) {
    if (!projectID) {
      help.textContent = "无项目任务默认独立执行；如需按代码基线顺序，请先选择项目。";
    } else if (mode === "strong") {
      help.textContent = "明确前置是强依赖：无论前置是否设置失败可跳过，本任务都必须等它和其合并任务成功。";
    } else if (mode === "none") {
      help.textContent = "独立任务不等待此前交付；后续默认任务仍会按项目执行顺序以本任务为前序。";
    } else {
      help.textContent = "自动弱依赖：等待当前项目此前顺序中的交付；若前序失败且未设置阻塞，会跳过它继续执行。";
    }
  }
}

// “允许资源并发”不等于“忽略代码基线”。为避免新建时误以为已并行，勾选
// 它会把默认弱依赖改为独立；用户若随后明确选择强依赖，强依赖仍优先。
export function syncTaskConcurrency() {
  const concurrent = document.getElementById("tConcurrent")?.checked;
  const modeEl = document.getElementById("tDependencyMode");
  if (concurrent && modeEl?.value === "weak") modeEl.value = "none";
  syncTaskDependency();
}

export async function submitTask() {
  const title = document.getElementById("tTitle").value.trim();
  if (!title) return toast("标题不能为空", true);
  const parentId = Number(document.getElementById("tParentId").value) || null;
  const projectId = Number(document.getElementById("tProject").value) || null;
  let dependencyMode = document.getElementById("tDependencyMode").value || "none";
  if (!projectId) dependencyMode = "none";
  const dependsOn = dependencyMode === "strong" ? Number(document.getElementById("tDependsOn").value) || null : null;
  if (dependencyMode === "strong" && !dependsOn) return toast("请选择明确前置任务", true);
  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: document.getElementById("tBody").value,
        agent_id: Number(document.getElementById("tAgent").value) || null,
        project_id: projectId,
        perm: document.getElementById("tPerm").value,
        run_mode: document.getElementById("tRunMode").value,
        concurrent: document.getElementById("tConcurrent").checked,
        dependency_mode: dependencyMode,
        depends_on: dependsOn,
        block_on_failure: document.getElementById("tBlockOnFailure").checked,
        parent_id: parentId,
      }),
    });
    closeModal("taskModal");
    toast("任务已创建");
    await loadAll();
    renderBoard(); renderList();
    refreshOverview();
    if (location.pathname === "/projects" && state.projectView) refreshProjectDetail();
  } catch (e) { toast(e.message, true); }
}

export function applyTemplate() {
  const t = state.templates.find(x => x.id === Number(document.getElementById("tTemplate").value));
  if (!t) return;
  document.getElementById("tBody").value = t.body || "";
  if (t.agent_id) document.getElementById("tAgent").value = t.agent_id;
  syncTaskRunMode();
}

export async function saveAsTemplate(taskId) {
  // 列表接口的 body 是截断版（省载荷），模板必须用完整提示词
  let t;
  try { t = await api(`/api/tasks/${taskId}`); } catch (_) { return; }
  const name = prompt("模板名称（用于复用该任务的提示词）", t.title);
  if (!name) return;
  try {
    await api("/api/templates", { method: "POST", body: JSON.stringify({ name, body: t.body, agent_id: t.agent_id }) });
    toast("已保存为模板");
    loadTemplates();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   历史页
   ============================================================ */
