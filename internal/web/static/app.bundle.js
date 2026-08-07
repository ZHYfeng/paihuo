(() => {
  // internal/web/static/src/core.js
  var state = {
    tasks: [],
    agents: [],
    schedules: [],
    templates: [],
    projects: [],
    schema: {},
    // cli -> {id, name, docs, fields}
    overview: null,
    // 总览统计
    agentStats: {},
    // agentId -> stats
    projectStats: {},
    // projectId -> stats
    view: "board",
    selected: null,
    logs: [],
    logsTask: null,
    logsHasMore: false,
    logsLoading: false,
    logsOldestSeq: 0,
    logsTotal: 0,
    termTask: null,
    es: null,
    // SSE 连接（隐藏时断开、可见时重连）
    history: [],
    historySel: /* @__PURE__ */ new Set(),
    agentEditing: null,
    agentTab: "overview",
    roleStudio: null,
    // 唯一角色编辑器的草稿、助手对话与测试对话
    projectView: null,
    // 项目详情中的项目 id
    projectReorderBusy: false,
    agentView: "grid",
    agentSort: "name-asc",
    skillLib: [],
    // 注册到 paihuo 工作目录的技能库 [{id,name,description,tags,dir}]
    skillSelected: /* @__PURE__ */ new Set(),
    // Skills 管理页当前勾选的技能 id
    skillDetail: null,
    // 当前打开的技能详情（含 SKILL.md 内容）
    skillView: "grid"
    // Skills 管理页显示模式：grid | list
  };
  var STATUS_LABEL = {
    queued: "\u5F85\u6267\u884C",
    claimed: "\u9886\u53D6\u4E2D",
    running: "\u6267\u884C\u4E2D",
    awaiting_review: "\u5F85\u5BA1\u6279",
    succeeded: "\u5B8C\u6210",
    failed: "\u5931\u8D25",
    cancelled: "\u5DF2\u53D6\u6D88"
  };
  var PERM_LABEL = { full: "\u81EA\u52A8\u6D3E\u53D1\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1", review: "\u5BA1\u6279\u540E Agent \u5408\u5E76" };
  var ST_COLOR = {
    queued: "var(--st-queued)",
    claimed: "var(--st-claimed)",
    running: "var(--st-running)",
    awaiting_review: "var(--st-review)",
    succeeded: "var(--st-done)",
    failed: "var(--st-failed)",
    cancelled: "var(--st-cancel)"
  };
  var BOARD_COLS = [
    ["queue", "\u6392\u961F", ["queued", "claimed"]],
    ["running", "\u6267\u884C\u4E2D", ["running"]],
    ["awaiting_review", "\u5F85\u5BA1\u6279", ["awaiting_review"]]
  ];
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  var ICONS = {
    plus: "M12 5v14M5 12h14",
    back: "M19 12H5M12 19l-7-7 7-7",
    retry: "M16 8H5M9 12l-4-4 4-4M5 8v5a9 9 0 0 0 14 5",
    trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6",
    copy: "M9 9h12v12H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    expand: "M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7",
    check: "M20 6 9 17l-5-5",
    x: "M18 6 6 18M6 6l12 12",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
    folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
    robot: "M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Zm5-2V6a3 3 0 0 1 6 0v2M9 15h.01M15 15h.01",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 3",
    bookmark: "M6 3h12v18l-6-4-6 4V3Z",
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
    board: "M3 3h7v8H3zM14 3h7v5h-7zM14 11h7v10h-7zM3 14h7v7H3z",
    calendar: "M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    zap: "M13 2 3 14h7l-1 8 10-12h-7l1-8Z",
    sparkle: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3Z",
    history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 3",
    terminal: "M4 17l6-5-6-5m8 10h8",
    chevL: "M15 18l-6-6 6-6",
    alert: "M12 3 2.5 20h19L12 3Zm0 7v5m0 3.5v.5",
    arrowUp: "M12 19V5m-6 6 6-6 6 6",
    arrowDown: "M12 5v14m6-6-6 6-6-6",
    grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
  };
  function icon(name, cls) {
    return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ""}"/></svg>`;
  }
  function fmtPct(x) {
    return Math.round(x * 10) / 10 + "%";
  }
  function fmtDur(sec) {
    if (!sec || sec <= 0) return "-";
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    return Math.round(sec / 360) / 10 + "h";
  }
  function toast(msg, isErr) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.innerHTML = `${icon(isErr ? "alert" : "check")}<span>${esc(msg)}</span>`;
    t.className = "toast" + (isErr ? " error" : "");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hidden"), 3e3);
  }
  async function api(path, opts = {}) {
    const headers = { ...opts.headers || {} };
    if (opts.body !== void 0) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error || msg;
      } catch (_) {
      }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  async function fetchTaskLogs(id, options = {}) {
    const params = new URLSearchParams();
    if (options.all) params.set("all", "1");
    else {
      params.set("limit", String(options.limit || 200));
      if (options.before) params.set("before", String(options.before));
    }
    const data = await api(`/api/tasks/${id}/logs?${params}`);
    if (Array.isArray(data)) return { logs: data, has_more: false, total: data.length };
    return {
      logs: Array.isArray(data?.logs) ? data.logs : [],
      has_more: Boolean(data?.has_more),
      total: Number(data?.total) || 0
    };
  }
  function activeModal() {
    const modals = document.querySelectorAll(".modal:not(.hidden)");
    return modals.length ? modals[modals.length - 1] : null;
  }
  function syncModalLayer() {
    const main = document.querySelector(".main");
    if (!main) return;
    main.classList.toggle("modal-layer", Boolean(main.querySelector(".modal:not(.hidden)")));
  }
  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const previous = activeModal();
    if (previous && previous !== modal) {
      previous.setAttribute("aria-hidden", "true");
      previous.removeAttribute("aria-modal");
    }
    modal._returnFocus = document.activeElement;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "false");
    const label = modal.querySelector("[data-modal-title], h1, h2, h3, .t-title");
    if (label) {
      if (!label.id) label.id = `${id}Label`;
      modal.setAttribute("aria-labelledby", label.id);
    }
    modal.classList.remove("hidden");
    syncModalLayer();
    const target = modal.querySelector("[data-autofocus], [autofocus]") || modal.querySelector("input:not([type='hidden']), textarea, select, button, [href], [tabindex]:not([tabindex='-1'])");
    target?.focus({ preventScroll: true });
  }
  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("hidden");
    syncModalLayer();
    modal.setAttribute("aria-hidden", "true");
    modal.removeAttribute("aria-modal");
    const previous = activeModal();
    if (previous) {
      previous.setAttribute("aria-hidden", "false");
      previous.setAttribute("aria-modal", "true");
    }
    const trigger = modal._returnFocus;
    modal._returnFocus = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  async function logout() {
    try {
      await fetch("/logout", { method: "POST" });
    } catch (_) {
    }
    location.href = "/login";
  }

  // internal/web/static/src/dashboard.js
  function dashCardHTML(t, actions) {
    return `<article class="card dash-card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">\u5BA1\u6279</span>` : ""}
    </div>
    <a class="c-title card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
    <div class="c-meta">
      ${t.project_name ? `<span class="chip">${esc(t.project_name)}</span>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm av-${esc(t.agent_name)}">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">\u672A\u6307\u6D3E</span>`}
      </span>
    </div>
    ${actions ? `<div class="dash-actions" onclick="event.stopPropagation()">${actions}</div>` : ""}
  </article>`;
  }
  function dashEmpty(title, detail, action) {
    return `<div class="dash-empty">
    <span class="dash-empty-mark" aria-hidden="true"><i></i></span>
    <b>${title}</b><span>${detail}</span>
    ${action || ""}
  </div>`;
  }
  function loadDashboard() {
    refreshOverview();
    renderDashTasks();
    renderDashProjects();
    loadDashAgents();
  }
  function renderDashTasks() {
    const run = document.getElementById("dashRunning");
    const rev = document.getElementById("dashReview");
    if (!run || !rev) return;
    const running = state.tasks.filter((t) => ["queued", "claimed", "running"].includes(t.status)).sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 6);
    const review = state.tasks.filter((t) => t.status === "awaiting_review").sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 6);
    run.innerHTML = running.map((t) => dashCardHTML(t)).join("") || dashEmpty(
      "\u6267\u884C\u961F\u5217\u5DF2\u6E05\u7A7A",
      "\u521B\u5EFA\u4EFB\u52A1\u540E\uFF0C\u8FDB\u5EA6\u4F1A\u5728\u8FD9\u91CC\u5B9E\u65F6\u66F4\u65B0\u3002",
      `<button type="button" class="btn xs" onclick="openNewTask()">\u6D3E\u53D1\u4EFB\u52A1</button>`
    );
    rev.innerHTML = review.map((t) => dashCardHTML(
      t,
      `<button class="btn xs brand" onclick="setTaskStatus(${t.id},'succeeded')">\u901A\u8FC7\u5E76\u5408\u5E76</button><button class="btn xs" onclick="rejectTask(${t.id})">\u9A73\u56DE</button><button class="btn xs" onclick="openTask(${t.id})">\u67E5\u770B\u8BE6\u60C5</button>`
    )).join("") || dashEmpty(
      "\u5F53\u524D\u65E0\u9700\u5BA1\u6279",
      "\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4\u7684\u4EA4\u4ED8\u4F1A\u96C6\u4E2D\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
      `<a class="btn xs" href="/history">\u67E5\u770B\u5386\u53F2</a>`
    );
    const rc = document.getElementById("dashRunningCount");
    if (rc) rc.textContent = running.length;
    const vc = document.getElementById("dashReviewCount");
    if (vc) vc.textContent = review.length;
  }
  function renderDashProjects() {
    const box = document.getElementById("dashProjects");
    if (!box) return;
    const active = state.projects.filter((p) => p.status === "active");
    if (!active.length) {
      box.innerHTML = `<div class="dash-onboard">
      <div class="ob-title">\u5F00\u59CB\u7B2C\u4E00\u6B21\u4EA4\u4ED8</div>
      <a class="ob-step" href="/agents"><b>01</b><span>\u914D\u7F6E\u672C\u673A\u667A\u80FD\u4F53</span></a>
      <a class="ob-step" href="/roles"><b>02</b><span>\u521B\u5EFA\u4EFB\u52A1\u89D2\u8272</span></a>
      <a class="ob-step" href="/projects"><b>03</b><span>\u5EFA\u7ACB\u9879\u76EE\u5DE5\u4F5C\u533A</span></a>
      <a class="ob-step" href="/board"><b>04</b><span>\u6D3E\u53D1\u9996\u4E2A\u4EFB\u52A1</span></a>
    </div>`;
      return;
    }
    const ranked = active.map((p) => {
      const ts = state.tasks.filter((t) => t.project_id === p.id);
      const done = ts.filter((t) => t.status === "succeeded").length;
      const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
      const inflight = ts.filter((t) => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
      return { p, ts, pct, inflight };
    }).sort((a, b) => b.inflight - a.inflight || a.p.name.localeCompare(b.p.name, "zh-CN"));
    const visible = ranked.slice(0, 4);
    box.innerHTML = visible.map(({ p, ts, pct, inflight }) => {
      return `<a class="dash-proj" href="/projects#/project/${p.id}">
      <div class="dp-top"><b title="${esc(p.name)}">${esc(p.name)}</b>
        ${inflight ? `<span class="badge running">${inflight} \u6D3B\u8DC3</span>` : `<span class="badge">${ts.length} \u4EFB\u52A1</span>`}</div>
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${pct}%</span></div>
    </a>`;
    }).join("") + (ranked.length > visible.length ? `<a class="dash-more" href="/projects">\u67E5\u770B\u5176\u4F59 ${ranked.length - visible.length} \u4E2A\u9879\u76EE <span aria-hidden="true">\u2192</span></a>` : "");
  }
  async function loadDashAgents() {
    try {
      const prov = await api("/api/provision");
      const box = document.getElementById("dashAgents");
      if (!box) return;
      const installed = prov.filter((p) => p.installed);
      const agents = state.agents || [];
      box.innerHTML = `
      <div class="dash-prov">
        ${prov.map((p) => `<span class="prov-chip ${p.installed ? "ok" : ""} ${p.login ? "login" : ""}" title="${esc(p.name)}${p.installed ? " " + esc(p.version) : " \u2014 \u672A\u5B89\u88C5"}${p.installed && !p.login ? "\uFF08\u672A\u767B\u5F55\uFF09" : ""}"><i aria-hidden="true"></i>${esc(p.name)}<span class="sr-only">${p.installed ? p.login ? "\u5DF2\u5B89\u88C5\u5E76\u767B\u5F55" : "\u5DF2\u5B89\u88C5\uFF0C\u672A\u767B\u5F55" : "\u672A\u5B89\u88C5"}</span></span>`).join("")}
      </div>
      <div class="dash-prov-meta">
        <span><b>${installed.length}/${prov.length}</b> \u5DF2\u5B89\u88C5</span>
        <span><b>${agents.filter((a) => a.enabled).length}</b> \u89D2\u8272\u542F\u7528</span>
      </div>`;
    } catch (_) {
    }
  }

  // internal/web/static/src/history.js
  function loadHistory() {
    const agentId = document.getElementById("hAgent").value;
    const status = document.getElementById("hStatus").value;
    const days = Number(document.getElementById("hDays").value) || 0;
    state.history = state.tasks.filter((t) => {
      if (agentId && t.agent_id !== Number(agentId)) return false;
      if (status && t.status !== status) return false;
      if (days > 0) {
        const end = t.finished_at || t.created_at;
        if (!end || Date.now() - new Date(end).getTime() > days * 864e5) return false;
      }
      return true;
    });
    state.historySel.clear();
    renderHistory();
  }
  function renderHistory() {
    const body = document.getElementById("historyBody");
    if (!body) return;
    body.innerHTML = state.history.map((t) => `
    <tr data-id="${t.id}" class="${state.historySel.has(t.id) ? "selected" : ""}" onclick="toggleRow(this)">
      <td class="chk"><input type="checkbox" ${state.historySel.has(t.id) ? "checked" : ""} onclick="event.stopPropagation()" onchange="toggleRow(this.closest('tr'), this.checked)" aria-label="\u9009\u62E9\u4EFB\u52A1 #${t.id}"></td>
      <td class="num">#${t.id}</td>
      <td class="t-title"><span class="t-link" onclick="event.stopPropagation();openTask(${t.id})">${esc(t.title)}</span>${isMergeTask(t) ? ` <span class="chip merge">\u5408\u5E76 #${t.merge_of}</span>` : ""}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${esc(t.project_name || "-")}</td>
      <td>${PERM_LABEL[t.perm] || t.perm}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          ${canRetryTask(t) ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}${retryTaskLabel(t)}</button>` : ""}
          ${canDeleteTask(t) ? `<button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}\u5220\u9664</button>` : ""}
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
  function toggleRow(tr, checked) {
    const id = Number(tr.dataset.id);
    const selected = typeof checked === "boolean" ? checked : !state.historySel.has(id);
    if (selected) state.historySel.add(id);
    else state.historySel.delete(id);
    tr.classList.toggle("selected", selected);
    const cb = tr.querySelector("input[type=checkbox]");
    if (cb) cb.checked = selected;
    const cnt = document.getElementById("hSelCount");
    if (cnt) cnt.textContent = state.historySel.size;
    syncHistorySelectionControls();
  }
  function toggleAll(checked) {
    const checkAll = document.getElementById("hCheckAll");
    const all = typeof checked === "boolean" ? checked : Boolean(checkAll?.checked);
    state.historySel.clear();
    if (all) state.history.forEach((t) => state.historySel.add(t.id));
    renderHistory();
  }
  function selectAllNonMergeTasks() {
    state.historySel.clear();
    state.history.filter((t) => !isMergeTask(t)).forEach((t) => state.historySel.add(t.id));
    renderHistory();
  }
  async function deleteSelected() {
    const ids = [...state.historySel];
    if (!ids.length) return toast("\u5148\u52FE\u9009\u8981\u5220\u9664\u7684\u4EFB\u52A1", true);
    if (ids.some((id) => isMergeTask(state.history.find((t) => t.id === id)))) {
      return toast("\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u4E0D\u80FD\u5355\u72EC\u5220\u9664\uFF1B\u8BF7\u5220\u9664\u5176\u6E90\u4EFB\u52A1\u4EE5\u653E\u5F03\u6574\u7EC4\u4EE3\u7801", true);
    }
    if (!confirm(`\u5220\u9664\u9009\u4E2D\u7684 ${ids.length} \u6761\u4EFB\u52A1\uFF1F\u4E0D\u53EF\u6062\u590D\u3002`)) return;
    try {
      for (const id of ids) await api(`/api/tasks/${id}`, { method: "DELETE" });
      toast(`\u5DF2\u5220\u9664 ${ids.length} \u6761`);
      await loadAll();
      loadHistory();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function cleanupHistory() {
    const agentId = Number(document.getElementById("hAgent").value) || null;
    const days = Number(document.getElementById("hDays").value) || 0;
    const before = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : "";
    if (!confirm(`\u5220\u9664${agentId ? "\u8BE5\u89D2\u8272" : "\u5168\u90E8\u89D2\u8272"}${before ? "\u3001" + days + " \u5929\u524D" : ""}\u7684\u7EC8\u6001\u4EFB\u52A1\uFF1F\u4E0D\u53EF\u6062\u590D\uFF01`)) return;
    try {
      const r = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
      toast(`\u5DF2\u5220\u9664 ${r.deleted} \u6761\u5386\u53F2`);
      await loadAll();
      loadHistory();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // internal/web/static/src/skills.js
  function setSkillTab(tab) {
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
  function setSkillView(view) {
    state.skillView = view === "list" ? "list" : "grid";
    document.getElementById("skillDisplaySeg")?.classList.remove("hidden");
    document.getElementById("segSkillGrid")?.classList.toggle("active", state.skillView === "grid");
    document.getElementById("segSkillList")?.classList.toggle("active", state.skillView === "list");
    try {
      localStorage.setItem("paihuo.skillView", state.skillView);
    } catch (_) {
    }
    renderSkillLib();
  }
  async function loadExtensions() {
    const raw = document.getElementById("extRaw");
    if (!raw) return;
    try {
      const d = await api("/api/extensions");
      raw.textContent = d.raw || "\uFF08\u7A7A\uFF09";
      if (d.error && d.raw) raw.textContent = d.raw + "\n\n[\u6267\u884C\u63D0\u793A] " + d.error;
    } catch (e) {
      raw.textContent = "\u52A0\u8F7D\u5931\u8D25: " + e.message;
    }
  }
  function openExtModal() {
    document.getElementById("extSource").value = "";
    openModal("extModal");
  }
  async function submitExt() {
    const source = document.getElementById("extSource").value.trim();
    if (!source) return toast("\u9700\u8981 extension \u6765\u6E90", true);
    try {
      const d = await api("/api/extensions/install", { method: "POST", body: JSON.stringify({ source }) });
      closeModal("extModal");
      toast("\u5DF2\u5B89\u88C5");
      loadExtensions();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function removeExt() {
    const name = prompt("\u8F93\u5165\u8981\u79FB\u9664\u7684 extension \u540D\u79F0\uFF08\u53EF\u4ECE\u4E0A\u65B9\u5217\u8868\u67E5\u770B\uFF09");
    if (!name) return;
    try {
      await api(`/api/extensions/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("\u5DF2\u79FB\u9664");
      loadExtensions();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function loadSkillLib() {
    try {
      state.skillLib = await api("/api/skills");
      const known = new Set(state.skillLib.map((s) => s.id));
      state.skillSelected.forEach((id) => {
        if (!known.has(id)) state.skillSelected.delete(id);
      });
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
    return tags.length ? tags.map((tag) => `<span class="skill-tag">${esc(tag)}</span>`).join("") : `<span class="skill-tag muted">\u672A\u5206\u7C7B</span>`;
  }
  function skillTagsEditorHTML(skill) {
    const inputId = `skill-tags-${skill.id}`;
    return `
    <div class="skill-tags-row">
      <div class="skill-tags" aria-label="\u5F53\u524D\u6807\u7B7E">${skillTagsHTML(skill)}</div>
      <button type="button" class="btn xs ghost skill-tags-edit" data-skill-tags-toggle="${skill.id}"
        aria-controls="skill-tag-editor-${skill.id}" aria-expanded="false"
        onclick="event.stopPropagation();toggleSkillTagsEditor(${skill.id})">\u7F16\u8F91\u6807\u7B7E</button>
    </div>
    <div class="skill-tag-editor hidden" id="skill-tag-editor-${skill.id}" onclick="event.stopPropagation()">
      <input id="${inputId}" class="skill-tags-input" value="${esc(skillTags(skill).join(", "))}"
        aria-label="\u7F16\u8F91 ${esc(skill.name)} \u7684\u6807\u7B7E" placeholder="\u6807\u7B7E\uFF0C\u7528\u9017\u53F7\u5206\u9694"
        onkeydown="if (event.key === 'Enter') { event.preventDefault(); saveSkillTagsInline(${skill.id}, this); }">
      <button type="button" class="btn xs primary" onclick="saveSkillTagsInline(${skill.id}, this)">\u4FDD\u5B58</button>
    </div>`;
  }
  function parseTagInput(raw) {
    const seen = /* @__PURE__ */ new Set();
    return String(raw || "").split(/[,，\n]/).map((tag) => tag.trim()).filter((tag) => {
      if (!tag) return false;
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function allSkillTags() {
    const tags = /* @__PURE__ */ new Map();
    state.skillLib.forEach((skill) => skillTags(skill).forEach((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tags.has(key)) tags.set(key, tag);
    }));
    return [...tags.values()].sort((a, b) => a.localeCompare(b));
  }
  function syncSkillTagFilter() {
    const select = document.getElementById("skillTagFilter");
    if (!select) return;
    const current = select.value;
    const options = [`<option value="">\u5168\u90E8\u6807\u7B7E</option>`].concat(allSkillTags().map((tag) => `<option value="${esc(tag)}">${esc(tag)}</option>`));
    if (state.skillLib.some((skill) => !skillTags(skill).length)) {
      options.push(`<option value="__untagged__">\u672A\u5206\u7C7B</option>`);
    }
    select.innerHTML = options.join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }
  function filteredSkills() {
    const query = (document.getElementById("skillSearch")?.value || "").trim().toLocaleLowerCase();
    const tag = document.getElementById("skillTagFilter")?.value || "";
    const list = state.skillLib.filter((skill) => {
      const tags = skillTags(skill);
      const matchesTag = !tag || (tag === "__untagged__" ? tags.length === 0 : tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase()));
      if (!matchesTag) return false;
      if (!query) return true;
      return [skill.name, skill.description, skill.dir, skill.source_path, ...tags].some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
    return { list, query, tag };
  }
  function skillGroupDirectory(skill) {
    const raw = String(skill.source_path || skill.dir || "").trim().replace(/[\\/]+$/, "");
    if (!raw) return "\u672A\u6307\u5B9A\u6765\u6E90\u76EE\u5F55";
    const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    if (slash < 0) return "\u6839\u76EE\u5F55";
    if (slash === 0) return raw.slice(0, 1);
    if (slash === 2 && raw[1] === ":") return raw.slice(0, 3);
    return raw.slice(0, slash) || "\u6839\u76EE\u5F55";
  }
  function skillPathName(path) {
    const raw = String(path || "").trim().replace(/[\\/]+$/, "");
    if (!raw) return "\u672A\u6307\u5B9A";
    const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    return slash >= 0 ? raw.slice(slash + 1) || raw : raw;
  }
  function skillCreatedDate(skill) {
    return String(skill.created_at || "").slice(0, 10) || "\u2014";
  }
  function skillGroups(skills = state.skillLib) {
    const groups = /* @__PURE__ */ new Map();
    skills.forEach((skill) => {
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
    <article class="skill-card${selected ? " selected" : ""}" tabindex="0" aria-label="\u6253\u5F00\u6280\u80FD ${esc(s.name)}"
      onclick="openSkillDetail(${s.id})"
      onkeydown="if (!event.target.closest('a,button,input,select,textarea') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSkillDetail(${s.id}); }">
      <div class="sk-top">
        <label class="skill-select" onclick="event.stopPropagation()" title="\u9009\u62E9 ${esc(s.name)}">
          <input type="checkbox" data-skill-id="${s.id}" ${selected ? "checked" : ""} aria-label="\u9009\u62E9\u6280\u80FD ${esc(s.name)}" onchange="toggleSkillSelection(${s.id}, this.checked)">
        </label>
        <span class="avatar">${esc((s.name || "?").slice(0, 1))}</span>
        <div class="sk-id">
          <a class="sk-name card-primary-action" href="#/skill/${s.id}" onclick="event.stopPropagation()">${esc(s.name)}</a>
          <div class="sk-desc">${esc(s.description || "\u65E0\u63CF\u8FF0")}</div>
        </div>
      </div>
      <div class="sk-meta">
        ${skillTagsEditorHTML(s)}
        <div class="skill-card-context">
          <span class="skill-card-context-item" title="${esc(sourcePath || "\u672A\u6307\u5B9A\u6765\u6E90\u8DEF\u5F84")}">
            ${icon("folder")}<span><small>\u6765\u6E90\u76EE\u5F55</small><b>${esc(sourceName)}</b></span>
          </span>
          <span class="skill-card-context-item">
            ${icon("clock")}<span><small>\u6DFB\u52A0\u65F6\u95F4</small><time>${esc(skillCreatedDate(s))}</time></span>
          </span>
        </div>
      </div>
      <div class="sk-foot">
        <span class="skill-copy-path" title="${esc(s.dir || "\u672A\u6307\u5B9A\u526F\u672C\u8DEF\u5F84")}">${icon("copy")}<span>\u526F\u672C</span><code>${esc(copyName)}</code></span>
        <span class="ac-ops">
          <button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s.id})">\u6253\u5F00\u8BE6\u60C5${icon("expand")}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteSkill(${s.id})">${icon("trash")}\u5220\u9664</button>
        </span>
      </div>
    </article>`;
  }
  function skillListRowHTML(s) {
    const selected = state.skillSelected.has(s.id);
    const sourcePath = s.source_path || s.dir || "";
    const sourceName = skillPathName(sourcePath);
    return `<tr class="skill-list-row${selected ? " selected" : ""}" tabindex="0" aria-label="\u6253\u5F00\u6280\u80FD ${esc(s.name)}"
    onclick="openSkillDetail(${s.id})"
    onkeydown="if (!event.target.closest('a,button,input,select,textarea') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSkillDetail(${s.id}); }">
    <td class="skill-list-check" data-label="\u9009\u62E9"><label class="skill-select" onclick="event.stopPropagation()" title="\u9009\u62E9 ${esc(s.name)}">
      <input type="checkbox" data-skill-id="${s.id}" ${selected ? "checked" : ""} aria-label="\u9009\u62E9\u6280\u80FD ${esc(s.name)}" onchange="toggleSkillSelection(${s.id}, this.checked)">
    </label></td>
    <td class="skill-list-main-cell" data-label="\u6280\u80FD"><span class="skill-list-name"><span class="avatar">${esc((s.name || "?").slice(0, 1))}</span><span><a class="table-primary-action" href="#/skill/${s.id}" onclick="event.stopPropagation()">${esc(s.name)}</a><small>${esc(s.description || "\u65E0\u63CF\u8FF0")}</small></span></span></td>
    <td class="skill-list-tags-cell" data-label="\u6807\u7B7E">${skillTagsEditorHTML(s)}</td>
    <td class="skill-list-source-cell" data-label="\u6765\u6E90\u76EE\u5F55">
      <span class="skill-list-source" title="${esc(sourcePath || "\u672A\u6307\u5B9A\u6765\u6E90\u8DEF\u5F84")}">
        <b>${esc(sourceName)}</b><code>${esc(skillGroupDirectory(s))}</code>
      </span>
    </td>
    <td class="skill-list-date-cell num" data-label="\u6DFB\u52A0\u65F6\u95F4"><time>${esc(skillCreatedDate(s))}</time></td>
    <td class="skill-list-actions-cell" data-label="\u64CD\u4F5C"><span class="ops"><button class="btn xs ghost" onclick="event.stopPropagation();openSkillDetail(${s.id})">\u6253\u5F00\u8BE6\u60C5${icon("expand")}</button><button class="btn xs danger" onclick="event.stopPropagation();deleteSkill(${s.id})">${icon("trash")}\u5220\u9664</button></span></td>
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
    document.querySelectorAll("#skillGrid input[data-skill-id]").forEach((cb) => {
      const on = selected.has(Number(cb.dataset.skillId));
      cb.checked = on;
      cb.closest(".skill-card")?.classList.toggle("selected", on);
      cb.closest("tr")?.classList.toggle("selected", on);
    });
    groups.forEach((group, i) => {
      const groupSelected = group.skills.filter((s) => selected.has(s.id)).length;
      const cb = document.querySelector(`#skillGrid input[data-skill-group="${i}"]`);
      if (!cb) return;
      cb.checked = groupSelected === group.skills.length;
      cb.indeterminate = groupSelected > 0 && groupSelected < group.skills.length;
    });
    const cnt = document.getElementById("skillSelectedCount");
    if (cnt) cnt.textContent = `\u5DF2\u9009 ${selectedCount}`;
    const del = document.getElementById("btnDeleteSkills");
    if (del) del.disabled = selectedCount === 0;
  }
  function renderSkillLib() {
    const grid = document.getElementById("skillGrid");
    if (!grid) return;
    const lib = state.skillLib;
    const { list, query, tag } = filteredSkills();
    const groups = skillGroups(list);
    grid.className = state.skillView === "list" ? "skill-list-shell" : "skill-groups";
    if (state.skillView === "list") {
      grid.innerHTML = `<div class="list-wrap skill-list-wrap"><table class="list-grid skill-list-grid" aria-label="\u6280\u80FD\u5217\u8868">
      <caption class="sr-only">\u6280\u80FD\u5217\u8868\uFF0C\u5171 ${list.length} \u4E2A\u6280\u80FD</caption>
      <thead><tr><th class="skill-list-check">\u9009\u62E9</th><th>\u6280\u80FD</th><th>\u6807\u7B7E</th><th>\u6765\u6E90\u76EE\u5F55</th><th>\u6DFB\u52A0\u65F6\u95F4</th><th class="skill-list-actions-head">\u64CD\u4F5C</th></tr></thead>
      <tbody>${list.map(skillListRowHTML).join("")}</tbody>
    </table></div>`;
    } else {
      grid.innerHTML = groups.map((group, i) => `
      <section class="skill-group">
        <header class="skill-group-head">
          <label class="skill-group-select" title="\u9009\u62E9\u76EE\u5F55 ${esc(group.directory)}">
            <input type="checkbox" data-skill-group="${i}" aria-label="\u9009\u62E9\u76EE\u5F55 ${esc(group.directory)}" onchange="toggleSkillGroup(${i}, this.checked)">
          </label>
          ${icon("folder")}
          <div class="skill-group-title">
            <b>\u6765\u6E90\u76EE\u5F55</b>
            <code title="${esc(group.directory)}">${esc(group.directory)}</code>
          </div>
          <span class="count-info">${group.skills.length} \u4E2A\u6280\u80FD</span>
        </header>
        <div class="skill-group-grid">${group.skills.map(skillCardHTML).join("")}</div>
      </section>`).join("");
    }
    const empty = document.getElementById("skillEmpty");
    if (empty) {
      empty.innerHTML = lib.length === 0 ? `<b class="empty-title">\u6C89\u6DC0\u7B2C\u4E00\u4E2A\u53EF\u590D\u7528\u6280\u80FD</b>
        <span class="empty-copy">\u5BFC\u5165\u5355\u4E2A\u6280\u80FD\u76EE\u5F55\uFF0C\u6216\u626B\u63CF\u4E00\u4E2A\u76EE\u5F55\u6811\u4E2D\u7684\u5168\u90E8 skills\u3002</span>
        <button type="button" class="btn brand sm" onclick="openSkillModal()">\u6DFB\u52A0\u6280\u80FD</button>` : `<b class="empty-title">\u6CA1\u6709\u7B26\u5408\u5F53\u524D\u6761\u4EF6\u7684\u6280\u80FD</b>
        <span class="empty-copy">\u6E05\u9664\u641C\u7D22\u8BCD\u4E0E\u6807\u7B7E\u7B5B\u9009\u540E\uFF0C\u518D\u67E5\u770B\u5B8C\u6574\u6280\u80FD\u5E93\u3002</span>
        <button type="button" class="btn sm" onclick="document.getElementById('skillSearch').value='';document.getElementById('skillTagFilter').value='';renderSkillLib()">\u6E05\u9664\u7B5B\u9009</button>`;
      empty.classList.toggle("hidden", list.length > 0);
    }
    const hasLibrary = lib.length > 0;
    document.getElementById("skillDisplaySeg")?.classList.toggle("hidden", !hasLibrary);
    document.getElementById("skillFilterControls")?.classList.toggle("hidden", !hasLibrary);
    document.getElementById("skillManageControls")?.classList.toggle("hidden", !hasLibrary);
    const cnt = document.getElementById("skillCount");
    if (cnt) cnt.textContent = list.length === lib.length ? `${lib.length} \u4E2A\u6280\u80FD` : `${list.length} / ${lib.length} \u4E2A\u6280\u80FD`;
    syncSkillSelectionControls(groups);
  }
  function toggleSkillSelection(id, checked) {
    if (checked) state.skillSelected.add(id);
    else state.skillSelected.delete(id);
    syncSkillSelectionControls();
  }
  function toggleSkillGroup(groupIndex, checked) {
    const group = skillGroups(filteredSkills().list)[groupIndex];
    if (!group) return;
    group.skills.forEach((skill) => {
      if (checked) state.skillSelected.add(skill.id);
      else state.skillSelected.delete(skill.id);
    });
    syncSkillSelectionControls();
  }
  function toggleAllSkills(checked) {
    state.skillSelected.clear();
    if (checked) state.skillLib.forEach((skill) => state.skillSelected.add(skill.id));
    syncSkillSelectionControls();
  }
  async function deleteSelectedSkills() {
    const ids = [...state.skillSelected];
    if (!ids.length) return toast("\u5148\u52FE\u9009\u8981\u5220\u9664\u7684\u6280\u80FD", true);
    if (!confirm(`\u5220\u9664\u9009\u4E2D\u7684 ${ids.length} \u4E2A\u6280\u80FD\uFF1F\u5C06\u540C\u65F6\u79FB\u9664\u5DE5\u4F5C\u76EE\u5F55\u4E2D\u7684\u526F\u672C\uFF0C\u5DF2\u5F15\u7528\u5B83\u4EEC\u7684\u89D2\u8272\u914D\u7F6E\u4F1A\u5931\u6548\u3002`)) return;
    try {
      const result = await api("/api/skills", { method: "DELETE", body: JSON.stringify({ ids }) });
      if (state.skillDetail && ids.includes(state.skillDetail.id)) {
        hideSkillDetail();
        if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
      }
      state.skillSelected.clear();
      await loadSkillLib();
      renderSkillLib();
      toast(`\u5DF2\u5220\u9664 ${result.count ?? ids.length} \u4E2A\u6280\u80FD`);
    } catch (e) {
      toast(e.message, true);
    }
  }
  function toggleSkillTagsEditor(id) {
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
      body: JSON.stringify({ tags })
    });
    const index = state.skillLib.findIndex((item) => item.id === id);
    if (index >= 0) state.skillLib[index] = { ...state.skillLib[index], ...updated };
    if (state.skillDetail?.id === id) state.skillDetail = { ...state.skillDetail, ...updated };
    syncSkillTagFilter();
    return updated;
  }
  async function saveSkillTagsInline(id, source) {
    const input = document.getElementById(`skill-tags-${id}`);
    if (!input) return;
    const editor = input.closest(".skill-tag-editor");
    const button = source?.tagName === "BUTTON" ? source : editor?.querySelector("button");
    const tags = parseTagInput(input.value);
    if (button) {
      button.disabled = true;
      button.textContent = "\u4FDD\u5B58\u4E2D\u2026";
    }
    try {
      await persistSkillTags(id, tags);
      renderSkillLib();
      toast(tags.length ? "\u6807\u7B7E\u5DF2\u4FDD\u5B58" : "\u5DF2\u6E05\u9664\u6807\u7B7E");
    } catch (e) {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = "\u4FDD\u5B58";
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
      <div class="side-heading">\u6280\u80FD\u4FE1\u606F</div>
      <div class="prop-row"><span class="k">\u540D\u79F0</span><span class="v" title="${esc(skill.name)}">${esc(skill.name)}</span></div>
      <div class="prop-row"><span class="k">\u6807\u7B7E</span><span class="skill-tags">${skillTagsHTML(skill)}</span></div>
      <div class="prop-row"><span class="k">\u6280\u80FD\u76EE\u5F55</span><code class="prop-mono" title="${esc(skill.dir)}">${esc(skill.dir)}</code></div>
      <div class="prop-row"><span class="k">\u6765\u6E90\u8DEF\u5F84</span><code class="prop-mono" title="${esc(skill.source_path || "-")}">${esc(skill.source_path || "-")}</code></div>
      <div class="prop-row"><span class="k">\u521B\u5EFA\u65F6\u95F4</span><span class="v">${esc((skill.created_at || "").slice(0, 16).replace("T", " ") || "-")}</span></div>
      <div class="prop-row"><span class="k">\u8BF4\u660E\u6587\u4EF6</span><span class="v">SKILL.md${skill.size_bytes !== void 0 ? ` \xB7 ${formatSkillBytes(skill.size_bytes)}` : ""}</span></div>
    </section>
    <div class="side-actions">
      <div class="side-heading">\u6807\u7B7E\u7BA1\u7406</div>
      <input id="sdTags" class="skill-tags-input" value="${esc(skillTags(skill).join(", "))}" placeholder="\u5982\uFF1A\u7F16\u7A0B, \u6587\u6863, \u4EE3\u7801\u5BA1\u67E5">
      <div class="field-help">\u591A\u4E2A\u6807\u7B7E\u7528\u9017\u53F7\u5206\u9694\uFF0C\u4FDD\u5B58\u540E\u53EF\u5728\u89D2\u8272\u521B\u5EFA\u65F6\u6309\u6807\u7B7E\u7B5B\u9009\u3002</div>
      <button class="btn sm primary" onclick="saveSkillTags()">\u4FDD\u5B58\u6807\u7B7E</button>
    </div>
    <div class="side-actions">
      <div class="side-heading">\u64CD\u4F5C</div>
      <div class="detail-actions">
        <button class="btn" onclick="copySkillContent()">${icon("copy")}\u590D\u5236 SKILL.md</button>
        <button class="btn danger" onclick="deleteSkillFromDetail()">${icon("trash")}\u5220\u9664\u6280\u80FD</button>
      </div>
    </div>`;
  }
  function renderSkillDetailShell(skill) {
    const main = document.getElementById("sdMain");
    const side = document.getElementById("sdSide");
    if (!main || !side) return;
    document.getElementById("sdCrumb").innerHTML = `\u6280\u80FD / <b>${esc(skill.name)}</b>`;
    document.getElementById("sdBadge").innerHTML = `<span class="badge" style="--st-color:var(--brand)">SKILL.md</span>`;
    main.innerHTML = `
    <section class="skill-hero">
      <span class="avatar lg skill-avatar">${esc((skill.name || "?").slice(0, 1))}</span>
      <div class="skill-hero-copy">
        <div class="detail-id">\u6280\u80FD\u8BF4\u660E \xB7 Markdown</div>
        <h2>${esc(skill.name)}</h2>
        ${skill.description ? `<div class="skill-hero-desc">${esc(skill.description)}</div>` : ""}
        <div id="sdTagsDisplay" class="skill-tags skill-hero-tags">${skillTagsHTML(skill)}</div>
      </div>
    </section>
    <div class="skill-doc-head">
      <div>
        <div class="section-title">SKILL.md</div>
        <div class="section-sub" id="sdDocMeta">\u6B63\u5728\u8BFB\u53D6\u6280\u80FD\u8BF4\u660E\u2026</div>
      </div>
      <button class="btn ghost xs" onclick="copySkillContent()">${icon("copy")}\u590D\u5236</button>
    </div>
    <pre class="skill-doc" id="sdDoc">\u52A0\u8F7D\u4E2D\u2026</pre>`;
    side.innerHTML = skillDetailSideHTML(skill);
  }
  function renderSkillDocument(detail) {
    const doc = document.getElementById("sdDoc");
    const meta = document.getElementById("sdDocMeta");
    if (!doc || !meta) return;
    const content = String(detail.content || "");
    doc.textContent = content || "\uFF08SKILL.md \u4E3A\u7A7A\uFF09";
    doc.classList.toggle("is-empty", !content);
    meta.textContent = content ? `${formatSkillBytes(detail.size_bytes ?? content.length)} \xB7 ${content.split("\n").length} \u884C` : "\u7A7A\u6587\u4EF6";
    const side = document.getElementById("sdSide");
    if (side) side.innerHTML = skillDetailSideHTML(detail);
  }
  function openSkillDetail(id) {
    location.hash = "#/skill/" + id;
  }
  function closeSkillDetail() {
    location.hash = "#/";
  }
  function hideSkillDetail() {
    document.getElementById("skillDetailShell")?.classList.add("hidden");
    document.getElementById("skillShell")?.classList.remove("hidden");
    state.skillDetail = null;
    document.getElementById("skillDisplaySeg")?.classList.remove("hidden");
    document.getElementById("skillFilterControls")?.classList.remove("hidden");
    document.getElementById("skillManageControls")?.classList.remove("hidden");
  }
  async function showSkillDetail(id) {
    let skill = state.skillLib.find((x) => x.id === id);
    if (!skill) {
      await loadSkillLib();
      renderSkillLib();
      skill = state.skillLib.find((x) => x.id === id);
    }
    if (!skill) {
      toast("\u6280\u80FD\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664", true);
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
      if (doc) {
        doc.textContent = `\u8BFB\u53D6\u5931\u8D25\uFF1A${e.message}`;
        doc.classList.add("is-error");
      }
      if (meta) meta.textContent = "\u65E0\u6CD5\u8BFB\u53D6 SKILL.md";
    }
  }
  async function copySkillContent() {
    const content = state.skillDetail?.content;
    if (content === void 0) return toast("\u6280\u80FD\u8BF4\u660E\u8FD8\u5728\u52A0\u8F7D\u4E2D", true);
    try {
      await navigator.clipboard.writeText(content);
      toast("\u5DF2\u590D\u5236 SKILL.md");
    } catch (_) {
      toast("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u5185\u5BB9", true);
    }
  }
  async function saveSkillTags() {
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
      toast(tags.length ? "\u6807\u7B7E\u5DF2\u4FDD\u5B58" : "\u5DF2\u6E05\u9664\u6807\u7B7E");
    } catch (e) {
      toast(e.message, true);
    }
  }
  function deleteSkillFromDetail() {
    const id = state.skillDetail?.id;
    if (id !== void 0) deleteSkill(id);
  }
  function openSkillModal() {
    document.getElementById("sSkillPath").value = "";
    document.getElementById("sSkillTags").value = "";
    loadProjDatalist();
    openModal("skillModal");
  }
  async function submitSkill() {
    const path = document.getElementById("sSkillPath").value.trim();
    if (!path) return toast("\u9700\u8981\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84", true);
    const tags = parseTagInput(document.getElementById("sSkillTags")?.value || "");
    try {
      const sk = await api("/api/skills", { method: "POST", body: JSON.stringify({ source_path: path, tags }) });
      closeModal("skillModal");
      toast(`\u5DF2\u5BFC\u5165 skill: ${sk.name}`);
      await loadSkillLib();
      renderSkillLib();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function scanSkills() {
    const path = document.getElementById("sSkillPath").value.trim();
    if (!path) return toast("\u9700\u8981\u626B\u63CF\u6839\u76EE\u5F55\u8DEF\u5F84", true);
    const tags = parseTagInput(document.getElementById("sSkillTags")?.value || "");
    try {
      const result = await api("/api/skills/scan", { method: "POST", body: JSON.stringify({ source_path: path, tags }) });
      closeModal("skillModal");
      const imported = (result.imported || []).length;
      const skipped = (result.skipped || []).length;
      const failed = (result.errors || []).length;
      let summary = `\u53D1\u73B0 ${result.found || 0} \u4E2A skill\uFF0C\u5DF2\u5BFC\u5165 ${imported} \u4E2A`;
      if (skipped) summary += `\uFF0C\u8DF3\u8FC7\u5DF2\u5BFC\u5165 ${skipped} \u4E2A`;
      if (failed) summary += `\uFF0C\u5931\u8D25 ${failed} \u4E2A`;
      toast(summary, failed > 0);
      await loadSkillLib();
      renderSkillLib();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function deleteSkill(id) {
    const s = state.skillLib.find((x) => x.id === id);
    if (!confirm(`\u5220\u9664 skill\u300C${s ? s.name : id}\u300D\uFF1F\u5C06\u540C\u65F6\u79FB\u9664\u5DE5\u4F5C\u76EE\u5F55\u4E2D\u7684\u526F\u672C\uFF0C\u5DF2\u5F15\u7528\u5B83\u7684\u89D2\u8272\u914D\u7F6E\u4F1A\u5931\u6548\u3002`)) return;
    try {
      await api(`/api/skills/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      state.skillSelected.delete(id);
      await loadSkillLib();
      renderSkillLib();
      if (state.skillDetail?.id === id) {
        hideSkillDetail();
        if (/^#\/skill\/\d+/.test(location.hash)) location.hash = "#/";
      }
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function loadTemplates() {
    try {
      state.templates = await api("/api/templates");
    } catch (_) {
      return;
    }
    const sel = document.getElementById("tTemplate");
    if (sel) sel.innerHTML = `<option value="">\u2014</option>` + state.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    renderTemplateList();
  }
  function renderTemplateList() {
    const body = document.getElementById("templateList");
    if (!body) return;
    body.innerHTML = state.templates.map((t) => `
    <tr>
      <td><b>${esc(t.name)}</b></td>
      <td style="font-size:12px;color:var(--fg-muted);max-width:480px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((t.body || "").slice(0, 90))}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td class="num">${(t.created_at || "").slice(0, 16).replace("T", " ")}</td>
      <td><button class="btn xs danger" onclick="deleteTemplate(${t.id})">${icon("trash")}\u5220\u9664</button></td>
    </tr>`).join("");
    const empty = document.getElementById("templateEmpty");
    if (empty) empty.classList.toggle("hidden", state.templates.length > 0);
  }
  async function deleteTemplate(id) {
    if (!confirm("\u5220\u9664\u8BE5\u6A21\u677F\uFF1F")) return;
    try {
      await api(`/api/templates/${id}`, { method: "DELETE" });
      await loadTemplates();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // internal/web/static/src/terminal.js
  var term = null;
  var termFit = null;
  var termLogs = [];
  var termHasMore = false;
  var termOldestSeq = 0;
  var termLoading = false;
  var ignoreTopScroll = false;
  var termInteractive = false;
  var termGeometryObserver = null;
  var termViewportResizeHandler = null;
  var taskTerm = null;
  var taskTermTask = null;
  var taskTermLogs = [];
  var terminalKeyQueues = /* @__PURE__ */ new Map();
  var INTERACTIVE_TERM_COLS = 80;
  var INTERACTIVE_TERM_ROWS = 24;
  var TERM_THEME = {
    background: "#070a08",
    foreground: "#c9d4e5",
    cursor: "#c7f36a",
    selectionBackground: "rgba(199, 243, 106, .24)",
    black: "#0b1019",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#38bdf8",
    magenta: "#a78bfa",
    cyan: "#22d3ee",
    white: "#c9d4e5",
    brightBlack: "#5d6b84",
    brightRed: "#fca5a5",
    brightGreen: "#6ee7b7",
    brightYellow: "#fde047",
    brightBlue: "#7dd3fc",
    brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9",
    brightWhite: "#f1f5f9"
  };
  function terminalOptions(interactive = false, running = false) {
    return {
      ...interactive ? { cols: INTERACTIVE_TERM_COLS, rows: INTERACTIVE_TERM_ROWS } : {},
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      lineHeight: 1.35,
      convertEol: true,
      scrollback: interactive ? 3e3 : 1e4,
      cursorBlink: interactive && running,
      disableStdin: !(interactive && running),
      theme: TERM_THEME
    };
  }
  function interactiveTaskRunning(taskID) {
    const task = state.tasks.find((t) => t.id === taskID);
    return task?.run_mode === "interactive" && task?.status === "running";
  }
  var geometryReportTimer = null;
  function reportTerminalGeometry(taskID, cols, rows) {
    if (!taskID || !cols || !rows) return;
    clearTimeout(geometryReportTimer);
    geometryReportTimer = setTimeout(() => {
      api(`/api/tasks/${taskID}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols, rows })
      }).catch(() => {
      });
    }, 150);
  }
  async function flushTerminalKeystrokes(taskID, queue) {
    queue.sending = true;
    try {
      while (queue.pending) {
        let end = Math.min(queue.pending.length, 4096);
        if (end < queue.pending.length && /[\uD800-\uDBFF]/.test(queue.pending[end - 1])) end--;
        const keys = queue.pending.slice(0, end);
        queue.pending = queue.pending.slice(end);
        try {
          await api(`/api/tasks/${taskID}/input`, {
            method: "POST",
            body: JSON.stringify({ keys })
          });
        } catch (e) {
          queue.pending = "";
          if (interactiveTaskRunning(taskID)) toast(`\u7EC8\u7AEF\u8F93\u5165\u53D1\u9001\u5931\u8D25\uFF1A${e.message}`, true);
          break;
        }
      }
    } finally {
      queue.sending = false;
      if (!queue.pending && terminalKeyQueues.get(taskID) === queue) terminalKeyQueues.delete(taskID);
    }
  }
  function queueTerminalKeystrokes(taskID, keys) {
    if (!keys || !interactiveTaskRunning(taskID)) return;
    let queue = terminalKeyQueues.get(taskID);
    if (!queue) {
      queue = { pending: "", sending: false };
      terminalKeyQueues.set(taskID, queue);
    }
    queue.pending += keys;
    if (!queue.sending) void flushTerminalKeystrokes(taskID, queue);
  }
  function configureTerminalInput(target, enabled) {
    if (!target) return;
    target.options.disableStdin = !enabled;
    target.options.cursorBlink = enabled;
    target.element?.classList.toggle("terminal-writable", enabled);
    if (target.textarea) {
      target.textarea.setAttribute("aria-label", enabled ? "Agent \u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u8F93\u5165" : "\u53EA\u8BFB\u7EC8\u7AEF\u8F93\u51FA");
      target.textarea.setAttribute("aria-disabled", String(!enabled));
    }
    if (!enabled) target.blur();
  }
  function writeTerminalLogs(target, logs, emptyMessage = "\uFF08\u6682\u65E0\u8F93\u51FA\uFF09") {
    if (!target) return;
    if (!logs.length) {
      target.write(`\x1B[90m${emptyMessage}\x1B[0m\r
`);
      return;
    }
    logs.forEach((l, index) => {
      target.write(String(l.content ?? "") + "\r\n", index === logs.length - 1 ? () => target.scrollToBottom() : void 0);
    });
  }
  function syncFullscreenTerminalGeometry() {
    if (!term) return;
    const host = document.getElementById("termX");
    if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    try {
      termFit?.fit();
      if (termInteractive && state.termTask) {
        reportTerminalGeometry(state.termTask, term.cols, term.rows);
      }
    } catch (_) {
    }
  }
  function observeFullscreenTerminalGeometry() {
    const host = document.getElementById("termX");
    if (!host || termGeometryObserver) return;
    termGeometryObserver = new ResizeObserver(() => {
      requestAnimationFrame(syncFullscreenTerminalGeometry);
    });
    termGeometryObserver.observe(host);
    termViewportResizeHandler = () => requestAnimationFrame(syncFullscreenTerminalGeometry);
    window.addEventListener("resize", termViewportResizeHandler, { passive: true });
    window.visualViewport?.addEventListener("resize", termViewportResizeHandler, { passive: true });
  }
  function initTerm() {
    if (term) return;
    term = new Terminal(terminalOptions(termInteractive, false));
    termFit = new FitAddon.FitAddon();
    term.loadAddon(termFit);
    term.open(document.getElementById("termX"));
    term.onData((keys) => {
      if (state.termTask && termInteractive) queueTerminalKeystrokes(state.termTask, keys);
    });
    term.onScroll((event) => {
      if (event.position === 0 && !ignoreTopScroll) loadOlderTerminalLogs();
    });
    observeFullscreenTerminalGeometry();
    syncFullscreenTerminalGeometry();
  }
  function termWrite(content) {
    if (term) term.write(String(content ?? "") + "\r\n");
  }
  function termAppendLog(l) {
    if (state.termTask !== l.task_id || !term) return;
    if (termLogs.some((existing) => existing.id === l.id)) return;
    termLogs.push(l);
    termWrite(l.content);
  }
  function renderTerminalWindow() {
    if (!term) return;
    syncFullscreenTerminalGeometry();
    term.reset();
    writeTerminalLogs(term, termLogs);
  }
  async function loadOlderTerminalLogs() {
    if (!state.termTask || !termHasMore || termLoading || !termOldestSeq) return;
    const id = state.termTask;
    termLoading = true;
    try {
      const page = await fetchTaskLogs(id, { before: termOldestSeq, limit: 200 });
      if (state.termTask !== id) return;
      const existing = new Set(termLogs.map((l) => l.id));
      const older = page.logs.filter((l) => !existing.has(l.id));
      if (!older.length) {
        termHasMore = false;
        return;
      }
      termLogs = [...older, ...termLogs];
      termHasMore = page.has_more;
      termOldestSeq = termLogs[0]?.seq || 0;
      ignoreTopScroll = true;
      const previousRows = term.buffer.active.length;
      renderTerminalWindow();
      term.scrollToTop();
      term.scrollLines(Math.max(1, term.buffer.active.length - previousRows));
      setTimeout(() => {
        ignoreTopScroll = false;
      }, 0);
    } catch (_) {
    } finally {
      termLoading = false;
    }
  }
  function openTerminal(id) {
    const t = state.tasks.find((x) => x.id === id) || {};
    termInteractive = t.run_mode === "interactive";
    document.getElementById("termTitle").textContent = `${t.agent_name || ""} \xB7 #${id} \u5BF9\u8BDD`;
    document.getElementById("termModal")?.classList.toggle("interactive-terminal-modal", termInteractive);
    document.getElementById("termX")?.classList.toggle("interactive-term-body", termInteractive);
    openModal("termModal");
    initTerm();
    setTimeout(syncFullscreenTerminalGeometry, 30);
    state.termTask = id;
    termLogs = [];
    termHasMore = false;
    termOldestSeq = 0;
    termLoading = false;
    ignoreTopScroll = true;
    term.reset();
    term.write("\x1B[90m# loading latest logs...\x1B[0m\r\n");
    syncTerminalInput(t);
    fetchTaskLogs(id, { limit: 200 }).then((page) => {
      if (state.termTask !== id) return;
      const byID = new Map(page.logs.map((l) => [l.id, l]));
      for (const l of termLogs) if (!byID.has(l.id)) byID.set(l.id, l);
      termLogs = [...byID.values()].sort((a, b) => a.seq - b.seq);
      termHasMore = page.has_more;
      termOldestSeq = termLogs[0]?.seq || 0;
      renderTerminalWindow();
      term.scrollToBottom();
      setTimeout(() => {
        ignoreTopScroll = false;
      }, 0);
    }).catch(() => {
      term.write("\x1B[31m\u65E5\u5FD7\u52A0\u8F7D\u5931\u8D25\x1B[0m\r\n");
    });
  }
  function closeTerminal() {
    clearTimeout(geometryReportTimer);
    configureTerminalInput(term, false);
    state.termTask = null;
    termLogs = [];
    termHasMore = false;
    termOldestSeq = 0;
    const bar = document.getElementById("termInputBar");
    if (bar) bar.classList.add("hidden");
    closeModal("termModal");
    document.getElementById("termModal")?.classList.remove("interactive-terminal-modal");
    document.getElementById("termX")?.classList.remove("interactive-term-body");
    termInteractive = false;
  }
  var taskTermFit = null;
  var taskTermResizeObserver = null;
  function observeTaskTerminalGeometry() {
    const host = document.getElementById("taskTermX");
    if (!host || taskTermResizeObserver) return;
    taskTermResizeObserver = new ResizeObserver(() => {
      if (!taskTerm || !taskTermFit) return;
      try {
        taskTermFit.fit();
      } catch (_) {
      }
      reportTerminalGeometry(taskTermTask, taskTerm.cols, taskTerm.rows);
    });
    taskTermResizeObserver.observe(host);
  }
  function closeTaskTerminal() {
    if (taskTerm) {
      try {
        taskTerm.dispose();
      } catch (_) {
      }
    }
    taskTermResizeObserver?.disconnect();
    taskTermResizeObserver = null;
    taskTermFit = null;
    taskTerm = null;
    taskTermTask = null;
    taskTermLogs = [];
  }
  function openTaskTerminal(id, logs = [], running = false) {
    const host = document.getElementById("taskTermX");
    if (!host) return;
    closeTaskTerminal();
    taskTermTask = id;
    taskTermLogs = [...logs];
    taskTerm = new Terminal(terminalOptions(true, running));
    taskTermFit = new FitAddon.FitAddon();
    taskTerm.loadAddon(taskTermFit);
    taskTerm.open(host);
    taskTermFit.fit();
    taskTerm.onData((keys) => queueTerminalKeystrokes(id, keys));
    configureTerminalInput(taskTerm, running);
    observeTaskTerminalGeometry();
    reportTerminalGeometry(id, taskTerm.cols, taskTerm.rows);
    writeTerminalLogs(taskTerm, taskTermLogs, "\uFF08\u4EA4\u4E92\u7EC8\u7AEF\u7B49\u5F85\u8F93\u51FA\uFF09");
  }
  function focusTaskTerminal() {
    taskTerm?.focus();
  }
  function taskTermAppendLog(l) {
    if (!taskTerm || taskTermTask !== l.task_id) return;
    if (taskTermLogs.some((existing) => existing.id === l.id)) return;
    taskTermLogs.push(l);
    taskTerm.write(String(l.content ?? "") + "\r\n", () => taskTerm?.scrollToBottom());
  }
  function taskTerminalText() {
    if (!taskTerm) return "";
    const buffer = taskTerm.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + taskTerm.rows);
    const lines = [];
    for (let row = start; row < end; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) || "");
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join("\n");
  }
  function syncTerminalInput(t) {
    const bar = document.getElementById("termInputBar");
    const enabled = t?.run_mode === "interactive" && t?.status === "running";
    bar?.classList.toggle("hidden", !enabled);
    configureTerminalInput(term, enabled);
  }
  function focusFullscreenTerminal() {
    term?.focus();
  }

  // internal/web/static/src/task.js
  var detailBackground = null;
  var detailReturnHash = "#/";
  function currentFilters() {
    return {
      agent: Number(document.getElementById("fAgent")?.value) || null,
      project: Number(document.getElementById("fProject")?.value) || null,
      status: document.getElementById("fStatus")?.value || ""
    };
  }
  function filteredTasks() {
    const f = currentFilters();
    return state.tasks.filter((t) => {
      if (f.agent && t.agent_id !== f.agent) return false;
      if (f.project && t.project_id !== f.project) return false;
      if (f.status && t.status !== f.status) return false;
      return true;
    });
  }
  function isMergeTask(t) {
    return t?.merge_of !== null && t?.merge_of !== void 0;
  }
  function mergeTaskFor(source) {
    if (!source || isMergeTask(source)) return null;
    return state.tasks.find((t) => isMergeTask(t) && t.merge_of === source.id) || null;
  }
  function mergeBlockReason(t) {
    if (!isMergeTask(t) || t.status !== "queued") return "";
    if (!t.agent_id) return "\u672A\u6307\u6D3E\u89D2\u8272";
    const agent = state.agents.find((a) => a.id === t.agent_id);
    if (!agent) return "\u89D2\u8272\u4E0D\u53EF\u7528";
    return agent.enabled ? "" : "\u89D2\u8272\u5DF2\u505C\u7528";
  }
  function taskKindChip(t) {
    return isMergeTask(t) ? `<span class="chip merge" title="\u7531\u6E90\u4EFB\u52A1 #${t.merge_of} \u81EA\u52A8\u521B\u5EFA">\u4EE3\u7801\u5408\u5E76 \xB7 #${t.merge_of}</span>` : `<span class="chip task-kind">\u5B9E\u73B0</span>`;
  }
  function sourceMergeChip(t) {
    if (isMergeTask(t)) return "";
    const merge = mergeTaskFor(t);
    if (!merge) {
      return t.status === "succeeded" && t.worktree_branch ? `<span class="chip merge-pending">\u6B63\u5728\u521B\u5EFA\u5408\u5E76</span>` : "";
    }
    return `<span class="chip merge-state ${merge.status}" title="\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1 #${merge.id}">\u5408\u5E76\uFF1A${STATUS_LABEL[merge.status] || merge.status}</span>`;
  }
  function sourceDeliveryInfo(source) {
    if (!source) return { state: "missing", reason: "\u524D\u7F6E\u4EFB\u52A1\u5DF2\u4E0D\u5B58\u5728" };
    if (isMergeTask(source)) return { state: "failed", reason: `\u4EFB\u52A1 #${source.id} \u662F\u5408\u5E76\u4EFB\u52A1\uFF0C\u4E0D\u80FD\u4F5C\u4E3A\u524D\u7F6E` };
    switch (source.status) {
      case "queued":
      case "claimed":
      case "running":
        return { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u6B63\u5728\u6267\u884C` };
      case "awaiting_review":
        return { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u7B49\u5F85\u5BA1\u6279` };
      case "failed":
        return { state: "failed", reason: `\u4EFB\u52A1 #${source.id} \u6267\u884C\u5931\u8D25` };
      case "cancelled":
        return { state: "failed", reason: `\u4EFB\u52A1 #${source.id} \u5DF2\u53D6\u6D88` };
      case "succeeded": {
        const merge = mergeTaskFor(source);
        if (!merge) {
          return source.worktree_branch ? { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u6B63\u5728\u521B\u5EFA\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1` } : { state: "succeeded", reason: `\u4EFB\u52A1 #${source.id} \u5DF2\u5B8C\u6210` };
        }
        if (merge.status === "succeeded") return { state: "succeeded", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u5DF2\u5B8C\u6210` };
        if (merge.status === "failed") return { state: "failed", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u5931\u8D25` };
        if (merge.status === "cancelled") return { state: "failed", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u5DF2\u53D6\u6D88` };
        return { state: "pending", reason: `\u5408\u5E76\u4EFB\u52A1 #${merge.id} \u6B63\u5728\u5904\u7406` };
      }
      default:
        return { state: "pending", reason: `\u4EFB\u52A1 #${source.id} \u72B6\u6001\u672A\u77E5` };
    }
  }
  function dependencyInfo(t) {
    if (isMergeTask(t)) return { mode: "system", state: "ready", label: "\u7CFB\u7EDF\u5408\u5E76" };
    const mode = t.dependency_mode || "none";
    if (mode === "none") return { mode, state: "ready", label: "\u72EC\u7ACB\u4EFB\u52A1", reason: "\u4E0D\u7B49\u5F85\u9879\u76EE\u4E2D\u7684\u5176\u4ED6\u4EA4\u4ED8" };
    if (mode === "weak" && !t.depends_on) {
      return { mode, state: "ready", label: "\u81EA\u52A8\u987A\u5E8F \xB7 \u9996\u9879", reason: "\u5F53\u524D\u9879\u76EE\u6267\u884C\u987A\u5E8F\u4E2D\u7684\u7B2C\u4E00\u9879" };
    }
    const source = state.tasks.find((x) => x.id === t.depends_on);
    const prefix = mode === "strong" ? "\u5F3A\u4F9D\u8D56" : "\u81EA\u52A8\u987A\u5E8F";
    const label = `${prefix} \xB7 #${t.depends_on || "?"}`;
    if (!source) {
      if (mode === "weak") return { mode, state: "skipped", label, reason: `\u524D\u5E8F\u4EFB\u52A1 #${t.depends_on} \u5DF2\u5220\u9664\uFF0C\u5DF2\u8DF3\u8FC7`, stateLabel: "\u524D\u5E8F\u5DF2\u8DF3\u8FC7" };
      return { mode, state: "blocked", label, reason: `\u660E\u786E\u4F9D\u8D56\u7684\u4EFB\u52A1 #${t.depends_on} \u5DF2\u5220\u9664`, stateLabel: "\u524D\u5E8F\u4E0D\u5B58\u5728" };
    }
    const delivery = sourceDeliveryInfo(source);
    if (mode === "strong") {
      if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
      return { mode, state: "blocked", label, reason: `\u660E\u786E\u4F9D\u8D56\u672A\u6210\u529F\uFF1A${delivery.reason}`, stateLabel: `\u7B49\u5F85 #${source.id}` };
    }
    if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
    if (delivery.state === "failed" || delivery.state === "missing") {
      if (!source.block_on_failure) {
        return { mode, state: "skipped", label, reason: `\u524D\u5E8F\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${delivery.reason}`, stateLabel: `#${source.id} \u5931\u8D25\u5DF2\u8DF3\u8FC7` };
      }
      return { mode, state: "blocked", label, reason: `\u524D\u5E8F\u963B\u585E\u4EFB\u52A1\u672A\u5B8C\u6210\uFF1A${delivery.reason}`, stateLabel: `#${source.id} \u5931\u8D25\u963B\u585E` };
    }
    return { mode, state: "blocked", label, reason: `\u7B49\u5F85\u524D\u5E8F\u4EA4\u4ED8\uFF1A${delivery.reason}`, stateLabel: `\u7B49\u5F85 #${source.id}` };
  }
  function dependencyChip(t) {
    const info = dependencyInfo(t);
    if (info.mode === "system") return "";
    const kind = info.mode === "strong" ? "strong" : info.mode === "weak" ? "weak" : "none";
    return `<span class="chip dependency ${kind}" title="${esc(info.reason || info.label)}">${esc(info.label)}</span>`;
  }
  function dependencyStateChip(t) {
    if (t.status !== "queued") return "";
    const info = dependencyInfo(t);
    if (info.state === "blocked") return `<span class="chip dependency blocked" title="${esc(info.reason)}">${esc(info.stateLabel || "\u7B49\u5F85\u524D\u5E8F")}</span>`;
    if (info.state === "skipped") return `<span class="chip dependency skipped" title="${esc(info.reason)}">${esc(info.stateLabel || "\u524D\u5E8F\u5DF2\u8DF3\u8FC7")}</span>`;
    return "";
  }
  function boardColumnsHTML(tasks, mergeSection) {
    const columns = mergeSection ? [...BOARD_COLS, ["merge-attention", "\u9700\u5904\u7406", ["failed", "cancelled"]]] : BOARD_COLS;
    return columns.map(([key, label, statuses]) => {
      const items = tasks.filter((t) => statuses.includes(t.status));
      return `<div class="board-col" style="--st-color:${ST_COLOR[statuses[0]]}">
      <div class="board-col-head">
        <span class="st-dot"></span><span>${label}</span>
        <span class="count">${items.length}</span>
      </div>
      <div class="board-col-body">
        ${items.map(cardHTML).join("") || `<div class="empty">\u2014</div>`}
      </div>
    </div>`;
    }).join("");
  }
  function boardSectionHTML(kind, title, note, tasks) {
    const blocked = tasks.filter((t) => mergeBlockReason(t)).length;
    const empty = kind === "merge" ? "\u8FD8\u6CA1\u6709\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\uFF1B\u5B9E\u73B0\u4EFB\u52A1\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u8FD9\u91CC\u3002" : "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u5B9E\u73B0\u4EFB\u52A1\u3002";
    return `<section class="board-section ${kind === "merge" ? "merge-section" : "source-section"}">
    <div class="board-section-head">
      <div><h2>${title}</h2><p>${note}</p></div>
      <div class="board-section-counts">
        <span>${tasks.length} \u4E2A</span>
        ${blocked ? `<span class="chip merge-blocked">${blocked} \u4E2A\u89D2\u8272\u4E0D\u53EF\u7528</span>` : ""}
      </div>
    </div>
    <div class="board-section-lanes">${tasks.length ? boardColumnsHTML(tasks, kind === "merge") : `<div class="board-section-empty">${empty}</div>`}</div>
  </section>`;
  }
  function renderBoard() {
    const el = document.getElementById("boardView");
    if (!el) return;
    const tasks = filteredTasks();
    const sourceTasks = tasks.filter((t) => !isMergeTask(t));
    const mergeTasks = tasks.filter(isMergeTask);
    el.innerHTML = boardSectionHTML("source", "\u5B9E\u73B0\u4EFB\u52A1", "\u9879\u76EE\u4EFB\u52A1\u9ED8\u8BA4\u6309\u521B\u5EFA\u65F6\u95F4\u987A\u5E8F\u4EA4\u4ED8\uFF0C\u4E5F\u53EF\u5728\u9879\u76EE\u9875\u8C03\u6574\uFF1B\u6BCF\u9879\u5B8C\u6210\u540E\u4F1A\u5148\u5904\u7406\u81EA\u5DF1\u7684\u4EE3\u7801\u5408\u5E76\u3002", sourceTasks) + boardSectionHTML("merge", "\u4EE3\u7801\u5408\u5E76", "\u4F7F\u7528\u65B0\u7684\u72EC\u7ACB worktree \u9A8C\u8BC1\u3001\u89E3\u51B3\u51B2\u7A81\u5E76\u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F\u3002", mergeTasks);
    const c = document.getElementById("viewCount");
    if (c) c.textContent = `${sourceTasks.length} \u4E2A\u5B9E\u73B0 \xB7 ${mergeTasks.length} \u4E2A\u5408\u5E76`;
  }
  function cardHTML(t) {
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
      ${t.perm === "review" ? `<span class="chip review">\u5BA1\u6279</span>` : ""}
      ${t.run_mode === "interactive" ? `<span class="chip">\u4EA4\u4E92</span>` : ""}
      ${t.concurrent ? `<span class="chip">\u5E76\u53D1</span>` : ""}
      ${t.review_rounds > 0 ? `<span class="chip">\u7B2C${t.review_rounds}\u8F6E</span>` : ""}
    </div>
    <a class="c-title card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
    ${t.body ? `<div class="c-desc">${esc(t.body)}</div>` : ""}
    <div class="c-meta">
      ${t.project_id && t.project_name ? `<a class="chip chip-link" href="/projects#/project/${t.project_id}" title="\u6253\u5F00\u9879\u76EE\u9875" onclick="event.stopPropagation()">${esc(t.project_name)}</a>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">\u672A\u6307\u6D3E</span>`}
        ${t.error ? `<span style="color:var(--danger)">\u2717</span>` : ""}
      </span>
    </div>
  </article>`;
  }
  function renderList() {
    const el = document.getElementById("listBody");
    if (!el) return;
    const tasks = filteredTasks();
    el.innerHTML = tasks.map(taskListRowHTML).join("");
    const empty = document.getElementById("listEmpty");
    if (empty) empty.classList.toggle("hidden", tasks.length > 0);
    const c = document.getElementById("viewCount");
    if (c) c.textContent = `${tasks.filter((t) => !isMergeTask(t)).length} \u4E2A\u5B9E\u73B0 \xB7 ${tasks.filter(isMergeTask).length} \u4E2A\u5408\u5E76`;
  }
  function taskListRowHTML(t) {
    const blocked = mergeBlockReason(t);
    const title = esc(t.title);
    const agent = esc(t.agent_name || "-");
    const project = esc(t.project_name || "-");
    const created = (t.created_at || "").slice(5, 16).replace("T", " ") || "\u2014";
    const finished = (t.finished_at || "").slice(5, 16).replace("T", " ") || "\u2014";
    const rounds = t.review_rounds || "\u2014";
    const chips = `${taskKindChip(t)}${dependencyChip(t)}${dependencyStateChip(t)}${blocked ? `<span class="chip merge-blocked">${esc(blocked)}</span>` : ""}`;
    const status = STATUS_LABEL[t.status] || t.status || "\u672A\u77E5";
    return `
    <tr class="task-list-row" tabindex="0" aria-label="\u6253\u5F00\u4EFB\u52A1 #${t.id}\uFF1A${title}"
      onclick="openTask(${t.id})"
      onkeydown="if (event.target !== this) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTask(${t.id}); }">
      <td class="task-list-id num" data-label="ID">#${t.id}</td>
      <td class="task-list-title t-title" data-label="\u6807\u9898">
        <a class="table-primary-action" href="#/issue/${t.id}" title="${title}" onclick="event.stopPropagation();openTask(${t.id});return false">${title}</a>
      </td>
      <td class="task-list-type" data-label="\u7C7B\u578B"><span class="task-list-chips">${chips}</span></td>
      <td class="task-list-agent" data-label="\u89D2\u8272"><span class="task-list-text" title="${agent}">${agent}</span></td>
      <td class="task-list-project" data-label="\u9879\u76EE">${t.project_id ? `<a class="t-link task-list-text" href="/projects#/project/${t.project_id}" title="${project}" onclick="event.stopPropagation()">${project}</a>` : `<span class="task-list-text" title="${project}">${project}</span>`}</td>
      <td class="task-list-status" data-label="\u72B6\u6001"><span class="badge ${esc(t.status || "unknown")}" style="--st-color:${ST_COLOR[t.status] || "var(--fg-faint)"}"><span class="st-dot"></span>${esc(status)}</span></td>
      <td class="task-list-rounds" data-label="\u8F6E\u6B21">${esc(rounds)}</td>
      <td class="task-list-date task-list-created num" data-label="\u521B\u5EFA"><time>${esc(created)}</time></td>
      <td class="task-list-date task-list-finished num" data-label="\u7ED3\u675F"><time>${esc(finished)}</time></td>
      <td class="task-list-actions" data-label="\u64CD\u4F5C">
        <span class="ops">
          <button type="button" class="btn xs" title="\u6253\u5F00\u4EFB\u52A1\u8BE6\u60C5" aria-label="\u6253\u5F00\u4EFB\u52A1\u8BE6\u60C5" onclick="event.stopPropagation();openTask(${t.id})">${icon("expand")}<span class="task-list-action-label">\u8BE6\u60C5</span></button>
          ${canRetryTask(t) ? `<button type="button" class="btn xs" title="${esc(retryTaskLabel(t))}" aria-label="${esc(retryTaskLabel(t))}" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}<span class="task-list-action-label">${esc(retryTaskLabel(t))}</span></button>` : ""}
          ${canDeleteTask(t) ? `<button type="button" class="btn xs danger" title="\u5220\u9664\u4EFB\u52A1" aria-label="\u5220\u9664\u4EFB\u52A1" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}<span class="task-list-action-label">\u5220\u9664</span></button>` : ""}
        </span>
      </td>
      <td class="task-list-mobile-meta" colspan="3" aria-label="\u4EFB\u52A1\u65F6\u95F4\u4E0E\u8F6E\u6B21">
        <span><small>\u8F6E\u6B21</small><b>${esc(rounds)}</b></span>
        <span><small>\u521B\u5EFA</small><b>${esc(created)}</b></span>
        <span><small>\u7ED3\u675F</small><b>${esc(finished)}</b></span>
      </td>
    </tr>`;
  }
  function setView(v) {
    state.view = v;
    document.getElementById("segBoard").classList.toggle("active", v === "board");
    document.getElementById("segList").classList.toggle("active", v === "list");
    document.getElementById("boardView").classList.toggle("hidden", v !== "board");
    document.getElementById("listView").classList.toggle("hidden", v !== "list");
    if (v === "list") renderList();
    else renderBoard();
  }
  function applyFilters() {
    const pl = document.getElementById("fProjectLink");
    const pv = Number(document.getElementById("fProject")?.value) || null;
    if (pl) {
      if (pv) {
        pl.href = `/projects#/project/${pv}`;
        pl.style.display = "";
      } else pl.style.display = "none";
    }
    state.view === "list" ? renderList() : renderBoard();
  }
  function openTask(id) {
    if (!/^#\/issue\/\d+$/.test(location.hash)) detailReturnHash = location.hash || "#/";
    location.hash = "#/issue/" + id;
  }
  function closeDetail() {
    const back = detailReturnHash || "#/";
    detailReturnHash = "#/";
    location.hash = back;
  }
  function showDetail(id) {
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
    if (detailBackground === null) {
      detailBackground = [];
      for (const child of main?.children || []) {
        if (child === detailShell || child.classList.contains("hidden")) continue;
        child.classList.add("hidden");
        detailBackground.push(child);
      }
    }
    detailShell.classList.remove("hidden");
    const t = state.tasks.find((x) => x.id === id);
    if (t) {
      document.getElementById("dCrumb").innerHTML = `\u4EFB\u52A1 / <b>#${t.id}</b>`;
      document.getElementById("dBadge").innerHTML = `<span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>`;
    }
    refreshDetail(changed);
  }
  function hideDetail() {
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
  async function refreshDetail(reloadLogs = false) {
    if (!state.selected) return;
    const id = state.selected;
    const shouldLoadLogs = reloadLogs || state.logsTask !== id;
    const liveLogs = shouldLoadLogs ? state.logs : [];
    try {
      const [task, page] = await Promise.all([
        api(`/api/tasks/${id}`),
        shouldLoadLogs ? fetchTaskLogs(id, { limit: 200 }) : Promise.resolve(null)
      ]);
      if (state.selected !== id) return;
      const i = state.tasks.findIndex((x) => x.id === task.id);
      if (i >= 0) state.tasks[i] = task;
      else state.tasks.unshift(task);
      if (page) {
        const byID = new Map(page.logs.map((l) => [l.id, l]));
        for (const l of liveLogs) if (!byID.has(l.id)) byID.set(l.id, l);
        const merged = [...byID.values()].sort((a, b) => a.seq - b.seq);
        state.logsTask = id;
        state.logs = merged;
        state.logsHasMore = page.has_more;
        state.logsOldestSeq = merged.length ? merged[0].seq : 0;
        state.logsTotal = Math.max(page.total, merged.length);
      }
      renderDetail(task);
    } catch (_) {
    }
  }
  function renderDetail(t) {
    const main = document.getElementById("dMain");
    if (!main) return;
    const mergeTask = isMergeTask(t);
    const mergeSource2 = mergeTask ? state.tasks.find((x) => x.id === t.merge_of) : null;
    const dependency = dependencyInfo(t);
    const interactive = t.run_mode === "interactive";
    const isInteractive = interactive && t.status === "running";
    const isLive = ["claimed", "running"].includes(t.status);
    const agent = state.agents.find((a) => a.id === t.agent_id);
    const agentName = t.agent_name || "\u672A\u6307\u6D3E";
    const agentCli = agent?.cli || "";
    const runMode = t.run_mode === "interactive" ? "\u4EA4\u4E92\u5F0F" : "\u6279\u5904\u7406";
    const bodyLength = (t.body || "").length;
    const createdAt = (t.created_at || "").slice(0, 16).replace("T", " ");
    const { visible: visibleLogs, errors: logErrors } = logStats();
    const logMeta = interactive ? `${isLive ? "\u5B9E\u65F6\u753B\u9762" : "\u5DF2\u5F52\u6863\u753B\u9762"} \xB7 ${INTERACTIVE_TERM_COLS} \xD7 ${INTERACTIVE_TERM_ROWS}` : state.logsHasMore ? `\u5DF2\u52A0\u8F7D ${visibleLogs}/${state.logsTotal} \u6761` : `${visibleLogs} \u6761`;
    const dependencyAlert = !mergeTask && t.status === "queued" && dependency.state !== "ready" ? `<div class="task-alert"><span class="task-alert-title">${dependency.state === "skipped" ? "\u524D\u5E8F\u4EA4\u4ED8\u5DF2\u8DF3\u8FC7" : "\u7B49\u5F85\u524D\u7F6E\u4EA4\u4ED8"}</span><span>${esc(dependency.reason || "\u7B49\u5F85\u8C03\u5EA6")}</span></div>` : "";
    const input = isInteractive ? `<div class="term-input detail-input terminal-input-help">
      <span>\u70B9\u51FB\u7EC8\u7AEF\u76F4\u63A5\u8F93\u5165 \xB7 Tab / \u2191 / \u2193 \u7531\u5F53\u524D CLI \u5904\u7406 \xB7 <code>/exit</code> \u7ED3\u675F</span>
      <button class="btn sm" onclick="focusTaskTerminal()">\u805A\u7126\u8F93\u5165</button>
    </div>` : "";
    main.innerHTML = `
    <section class="task-hero">
      <div class="task-kicker"><span>${mergeTask ? `\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1 \xB7 \u6765\u6E90 #${t.merge_of}` : `\u5B9E\u73B0\u4EFB\u52A1 #${t.id}`}</span><span>\u521B\u5EFA\u4E8E ${esc(createdAt)}</span></div>
      <h2>${esc(t.title)}</h2>
      <div class="task-meta">
        <span class="task-meta-item"><span class="avatar sm${agentCli ? ` av-${esc(agentCli)}` : ""}">${esc(agentName.slice(0, 1))}</span>${esc(agentName)}</span>
        ${t.project_name ? `<span class="task-meta-item">${esc(t.project_name)}</span>` : ""}
        <span class="task-meta-item">${runMode}</span>
        ${mergeTask ? "" : dependencyChip(t)}
        ${!mergeTask && dependencyStateChip(t)}
        ${mergeTask ? `<span class="task-meta-item task-meta-accent">${mergeSource2 ? `\u6E90\u4EFB\u52A1\uFF1A#${mergeSource2.id}` : `\u6E90\u4EFB\u52A1\uFF1A#${t.merge_of}`}</span>` : sourceMergeChip(t)}
        ${t.resume_of ? `<span class="task-meta-item task-meta-accent">\u7EED\u8DD1\u81EA #${t.resume_of}</span>` : ""}
      </div>
    </section>
    ${t.body ? `<details class="task-section task-prompt"${bodyLength <= 160 ? " open" : ""}>
      <summary><span>\u4EFB\u52A1\u8BF4\u660E</span><span class="section-meta">${bodyLength} \u5B57</span></summary>
      <div class="task-prompt-body">${esc(t.body)}</div>
    </details>` : ""}
    ${dependencyAlert}
    ${t.error ? `<div class="task-alert"><span class="task-alert-title">${mergeTask ? "\u4EE3\u7801\u5408\u5E76\u5931\u8D25" : "\u4EFB\u52A1\u5931\u8D25"}</span><span>${esc(t.error)}</span></div>` : ""}
    <div id="childrenBox"></div>
    ${t.status === "awaiting_review" ? `<details class="task-section task-diff" open>
      <summary><span>\u4EE3\u7801\u6539\u52A8</span><span class="section-meta">\u7B49\u5F85\u5BA1\u6279</span></summary>
      <div id="diffBox"><div class="empty">\u52A0\u8F7D\u6539\u52A8\u4E2D...</div></div>
    </details>` : ""}
    <details class="task-section task-log-section${interactive ? " interactive-task-log" : ""}"${isLive ? " open" : ""}>
      <summary><span>${interactive ? "\u4EA4\u4E92\u7EC8\u7AEF" : "\u6267\u884C\u8BB0\u5F55"}</span><span class="section-meta" id="logMeta">${logMeta}${logErrors && !interactive ? ` \xB7 ${logErrors} \u4E2A\u9519\u8BEF` : ""}</span></summary>
      <div class="section-head">
        <div class="section-sub">${esc(agentName)} \xB7 ${runMode}</div>
        <div class="section-tools">
          <button class="btn ghost xs" onclick="copyLogs()">${icon("copy")}${interactive ? "\u590D\u5236\u753B\u9762" : "\u590D\u5236"}</button>
          <button class="btn ghost xs" onclick="openTerminal(${t.id})">${icon("expand")}\u5168\u5C4F</button>
        </div>
      </div>
      <div class="term">
      <div class="term-head">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="t-title" title="${esc(t.project_dir || "")}">${esc(agentName)} \xB7 ${runMode}</span>
      </div>
      ${interactive ? `<div class="term-body interactive-term-body" id="logBox" role="region" aria-label="${esc(agentName)} \u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u753B\u9762"><div class="interactive-term-canvas" id="taskTermX"></div></div>` : `<div class="term-body" id="logBox">${logsHTML()}</div>`}
      ${input}
      </div>
    </details>
    <details class="task-section task-workspace">
      <summary><span>\u5DE5\u4F5C\u7A7A\u95F4</span><span class="section-meta">Git / worktree \u4FE1\u606F</span></summary>
      <div id="wsBox"><div class="empty">\u52A0\u8F7D\u4E2D...</div></div>
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
  async function loadWorkspace(id) {
    const box = document.getElementById("wsBox");
    if (!box) return;
    try {
      const w = await api(`/api/workspace/${id}`);
      const t = state.tasks.find((x) => x.id === id) || {};
      const done = ["succeeded", "failed", "cancelled"].includes(t.status);
      const mergeTask = isMergeTask(t);
      const sourceMerge = mergeTaskFor(t);
      const sourceAwaitingMerge = !mergeTask && t.status === "succeeded";
      if (!w.is_git) {
        box.innerHTML = `<div class="ws-row"><span class="ws-label">\u9694\u79BB</span><span class="ws-val">\u9879\u76EE\u975E git \u4ED3\u5E93\uFF0C\u4EFB\u52A1\u76F4\u63A5\u5728\u9879\u76EE\u76EE\u5F55\u6267\u884C</span><button class="btn xs" onclick="gitInitProject('${esc(w.path)}', ${id})">git init</button></div>`;
        return;
      }
      if (!w.is_worktree) {
        box.innerHTML = `<div class="ws-row"><span class="ws-label">\u9694\u79BB</span><span class="ws-val">${esc(w.note || "\u65E0\u72EC\u7ACB\u5DE5\u4F5C\u7A7A\u95F4")}</span></div>`;
        return;
      }
      box.innerHTML = `
      <div class="ws-row"><span class="ws-label">\u5206\u652F</span><span class="ws-val mono">${esc(w.branch)}</span></div>
      <div class="ws-row"><span class="ws-label">HEAD</span><span class="ws-val mono">${esc(w.head || "-")}` + (w.dirty ? ` <span class="ws-tag dirty">dirty</span>` : "") + (w.ahead > 0 ? ` <span class="ws-tag ahead">+${w.ahead}</span>` : "") + `</span></div>
      <div class="ws-row"><span class="ws-label">\u8DEF\u5F84</span><span class="ws-val mono" title="${esc(w.path)}">${esc(w.path)}</span></div>` + (done ? workspaceActionsHTML(t, sourceMerge, sourceAwaitingMerge, id) : "");
    } catch (_) {
      box.innerHTML = `<div class="empty">\u5DE5\u4F5C\u7A7A\u95F4\u4FE1\u606F\u4E0D\u53EF\u7528</div>`;
    }
  }
  function workspaceActionsHTML(t, sourceMerge, sourceAwaitingMerge, id) {
    if (isMergeTask(t)) {
      if (t.status === "succeeded") {
        return `<div class="ws-actions"><span class="ws-val">\u4EE3\u7801\u5DF2\u7531\u672C\u5408\u5E76\u4EFB\u52A1\u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F</span><button class="btn sm danger" onclick="wsDiscard(${id})">\u6E05\u7406\u5DE5\u4F5C\u7A7A\u95F4</button></div>`;
      }
      const action = t.status === "failed" || t.status === "cancelled" ? "\u8BF7\u4F7F\u7528\u201C\u91CD\u8BD5\u5408\u5E76\u201D\u7EE7\u7EED\u5904\u7406\u3002" : "\u4EE3\u7801\u5C06\u7531\u672C\u5408\u5E76\u4EFB\u52A1\u6210\u529F\u7ED3\u7B97\u65F6\u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F\u3002";
      return `<div class="ws-actions"><span class="ws-val">${action}</span></div>`;
    }
    if (sourceAwaitingMerge) {
      if (sourceMerge) {
        return `<div class="ws-actions"><span class="ws-val">\u4EE3\u7801\u7531\u5408\u5E76\u4EFB\u52A1 #${sourceMerge.id}\uFF08${STATUS_LABEL[sourceMerge.status] || sourceMerge.status}\uFF09\u5904\u7406</span></div>`;
      }
      return `<div class="ws-actions"><span class="ws-val">\u4EE3\u7801\u5DF2\u5B8C\u6210\uFF0C\u7CFB\u7EDF\u6B63\u5728\u8865\u5EFA\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1</span></div>`;
    }
    return `<div class="ws-actions"><button class="btn sm danger" onclick="wsDiscard(${id})">\u4E22\u5F03</button></div>`;
  }
  async function wsDiscard(id) {
    if (!confirm(`\u4E22\u5F03\u4EFB\u52A1 #${id} \u7684\u5DE5\u4F5C\u7A7A\u95F4\uFF1F\u5206\u652F\u4E0E worktree \u5C06\u5220\u9664\uFF0C\u6539\u52A8\u4E0D\u53EF\u6062\u590D\u3002`)) return;
    try {
      await api(`/api/workspace/${id}/discard`, { method: "POST" });
      toast("\u5DF2\u4E22\u5F03");
      loadWorkspace(id);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function gitInitProject(path, id) {
    if (!confirm(`\u5728 ${path} \u521D\u59CB\u5316 git \u4ED3\u5E93\uFF1F\u4E4B\u540E\u7684\u4EFB\u52A1\u5C06\u83B7\u5F97\u72EC\u7ACB worktree\u3002`)) return;
    try {
      await api("/api/workspace/git-init", { method: "POST", body: JSON.stringify({ path }) });
      toast("\u5DF2\u521D\u59CB\u5316");
      loadWorkspace(id);
    } catch (e) {
      toast(e.message, true);
    }
  }
  function renderSide(t) {
    const side = document.getElementById("dSide");
    if (!side) return;
    const mergeTask = isMergeTask(t);
    const dependency = dependencyInfo(t);
    const mergeBlocked = mergeBlockReason(t);
    const statusOpts = Object.keys(STATUS_LABEL).map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
    const agentOpts = `<option value="">\u4E0D\u6307\u6D3E</option>` + state.agents.filter((a) => a.enabled || a.id === t.agent_id).map((a) => `<option value="${a.id}" ${a.id === t.agent_id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    const pOpts = `<option value="">\u65E0\u9879\u76EE</option>` + state.projects.map((p) => `<option value="${p.id}" ${t.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    const canMoveProject = t.dependency_mode === "none" && !t.depends_on;
    let primaryActions = "";
    let secondaryActions = "";
    if (["queued", "claimed", "running"].includes(t.status)) {
      primaryActions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}\u53D6\u6D88\u4EFB\u52A1</button>`;
    }
    if (t.run_mode === "interactive" && t.status === "running") {
      primaryActions += `<button class="btn sm" onclick="endInteractiveTask(${t.id})">${icon("terminal")}\u7ED3\u675F\u4F1A\u8BDD</button>`;
    }
    if (t.status === "awaiting_review") {
      primaryActions += `<button class="btn sm brand" onclick="setTaskStatus(${t.id},'succeeded')">${icon("check")}\u901A\u8FC7\u5E76\u6D3E\u53D1\u5408\u5E76</button>`;
      primaryActions += `<button class="btn sm" onclick="rejectTask(${t.id})">${icon("retry")}\u9A73\u56DE\u91CD\u505A</button>`;
      primaryActions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}\u53D6\u6D88</button>`;
    }
    if (canRetryTask(t)) {
      primaryActions += `<button class="btn sm" onclick="setTaskStatus(${t.id},'queued')">${icon("retry")}${retryTaskLabel(t)}</button>`;
      if (!mergeTask) secondaryActions += `<button class="btn sm" onclick="resumeTask(${t.id})">${icon("terminal")}\u7EE7\u7EED\u5BF9\u8BDD</button>`;
    }
    if (mergeTask) {
      if (mergeBlocked) primaryActions += `<span class="side-muted">${mergeBlocked}\uFF1B\u542F\u7528\u539F\u89D2\u8272\u540E\u5C06\u81EA\u52A8\u6267\u884C\u3002</span>`;
      secondaryActions += `<button class="btn sm" onclick="openTask(${t.merge_of})">${icon("back")}\u6253\u5F00\u6E90\u4EFB\u52A1 #${t.merge_of}</button>`;
    } else {
      secondaryActions += `<button class="btn sm" onclick="openSubTask(${t.id})">${icon("plus")}\u62C6\u5206\u5B50\u4EFB\u52A1</button>`;
      if (t.body) secondaryActions += `<button class="btn sm" onclick="saveAsTemplate(${t.id})">${icon("bookmark")}\u4FDD\u5B58\u4E3A\u6A21\u677F</button>`;
      secondaryActions += `<button class="btn sm danger" onclick="deleteTask(${t.id})">${icon("trash")}\u5220\u9664\u4EFB\u52A1</button>`;
    }
    const runInfo = `
    <div class="prop-row"><span class="k">\u6267\u884C\u5668</span><span class="v">tmux \xB7 ${["claimed", "running"].includes(t.status) ? `paihuo:task-${t.id}` : "\u65E5\u5FD7\u5DF2\u5F52\u6863"}</span></div>
    <div class="prop-row"><span class="k">\u76EE\u5F55</span><span class="v prop-mono" title="${esc(t.project_dir || "")}">${esc(t.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">\u5BA1\u6279\u8F6E\u6B21</span><span class="v">${t.review_rounds || "-"}</span></div>
    <div class="prop-row"><span class="k">\u5F00\u59CB</span><span class="v">${esc((t.started_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="prop-row"><span class="k">\u7ED3\u675F</span><span class="v">${esc((t.finished_at || "-").slice(0, 16).replace("T", " "))}</span></div>`;
    const properties = mergeTask ? `
    <details class="side-collapse side-properties" open>
      <summary><span>\u5408\u5E76\u4EFB\u52A1\u5C5E\u6027</span><span class="section-meta">\u7CFB\u7EDF\u7BA1\u7406</span></summary>
      <div class="side-collapse-body">
        <div class="prop-row"><span class="k">\u6765\u6E90</span><span class="v"><button class="btn xs" onclick="openTask(${t.merge_of})">\u4EFB\u52A1 #${t.merge_of}</button></span></div>
        <div class="prop-row"><span class="k">\u72B6\u6001</span><span class="v">${STATUS_LABEL[t.status] || t.status}</span></div>
        <div class="prop-row"><span class="k">\u89D2\u8272</span><span class="v">${esc(t.agent_name || "\u672A\u6307\u6D3E")}${mergeBlocked ? ` \xB7 ${mergeBlocked}` : ""}</span></div>
        <div class="prop-row"><span class="k">\u7B56\u7565</span><span class="v">\u72EC\u7ACB worktree \xB7 \u4E32\u884C \xB7 \u81EA\u52A8\u5199\u5165\u4E3B\u5206\u652F${mergeSource?.block_on_failure ? " \xB7 \u5931\u8D25\u963B\u585E\u540E\u7EED\u81EA\u52A8\u4EFB\u52A1" : " \xB7 \u5931\u8D25\u53EF\u8DF3\u8FC7"}</span></div>
      </div>
    </details>` : `
    <details class="side-collapse side-properties">
      <summary><span>\u4EFB\u52A1\u5C5E\u6027</span><span class="section-meta">\u53EF\u7F16\u8F91</span></summary>
      <div class="side-collapse-body">
        <div class="prop-row"><span class="k">\u72B6\u6001</span>
          <span class="v"><select onchange="patchTask(${t.id},{status:this.value})">${statusOpts}</select></span></div>
        <div class="prop-row"><span class="k">\u9879\u76EE</span>
          <span class="v"><select ${canMoveProject ? "" : 'disabled title="\u6709\u524D\u7F6E\u4F9D\u8D56\u7684\u4EFB\u52A1\u4E0D\u80FD\u6539\u9879\u76EE"'} onchange="patchTask(${t.id},{project_id:this.value||null})">${pOpts}</select></span></div>
        <div class="prop-row"><span class="k">\u89D2\u8272</span>
          <span class="v"><select aria-label="\u4EFB\u52A1\u89D2\u8272" onchange="patchTask(${t.id},{agent_id:Number(this.value)||null})">${agentOpts}</select></span></div>
        <div class="prop-row"><span class="k">\u6743\u9650</span><span class="v">${t.perm === "full" ? "\u81EA\u52A8\u5408\u5E76" : "\u5BA1\u6279\u540E\u5408\u5E76"}</span></div>
        <div class="prop-row"><span class="k">\u65B9\u5F0F</span><span class="v">${t.run_mode === "interactive" ? "\u4EA4\u4E92\u5F0F" : "\u6279\u5904\u7406"}</span></div>
        <div class="prop-row"><span class="k">\u524D\u7F6E\u4EA4\u4ED8</span><span class="v">${dependencyChip(t)}${dependency.state !== "ready" ? ` <span title="${esc(dependency.reason || "")}">${esc(dependency.stateLabel || dependency.reason || "\u7B49\u5F85")}</span>` : ""}</span></div>
        <div class="prop-row"><span class="k">\u5931\u8D25\u540E</span>
          <span class="v"><select onchange="patchTask(${t.id},{block_on_failure:this.value==='1'})">
            <option value="0" ${t.block_on_failure ? "" : "selected"}>\u540E\u7EED\u5F31\u4F9D\u8D56\u53EF\u8DF3\u8FC7</option>
            <option value="1" ${t.block_on_failure ? "selected" : ""}>\u963B\u585E\u540E\u7EED\u5F31\u4F9D\u8D56</option>
          </select></span></div>
        <div class="prop-row"><span class="k">\u5E76\u53D1</span>
          <span class="v"><select onchange="patchTask(${t.id},{concurrent:this.value==='1'})">
            <option value="0" ${t.concurrent ? "" : "selected"}>\u4E0D\u91CD\u53E0\u6267\u884C\uFF08\u9ED8\u8BA4\uFF09</option>
            <option value="1" ${t.concurrent ? "selected" : ""}>\u5141\u8BB8\u8D44\u6E90\u5E76\u53D1</option>
          </select></span></div>
      </div>
    </details>`;
    side.innerHTML = `
    ${properties}
    <details class="side-collapse">
      <summary><span>\u8FD0\u884C\u4FE1\u606F</span><span class="section-meta">\u6280\u672F\u7EC6\u8282</span></summary>
      <div class="side-collapse-body">${runInfo}</div>
    </details>
    <section class="side-actions">
      <div class="side-heading">\u4E0B\u4E00\u6B65</div>
      <div class="detail-actions">${primaryActions || `<span class="side-muted">\u6682\u65E0\u9700\u8981\u5904\u7406\u7684\u64CD\u4F5C</span>`}</div>
      ${secondaryActions ? `<details class="side-more-actions">
        <summary>\u66F4\u591A\u64CD\u4F5C</summary>
        <div class="detail-actions">${secondaryActions}</div>
      </details>` : ""}
    </section>`;
  }
  async function patchTask(id, set) {
    try {
      const task = await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(set) });
      const i = state.tasks.findIndex((t) => t.id === task.id);
      if (i >= 0) state.tasks[i] = task;
      else state.tasks.unshift(task);
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
      toast("\u5DF2\u66F4\u65B0");
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function setTaskStatus(id, status) {
    try {
      await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      if (status === "succeeded") toast("\u5DF2\u5BA1\u6279\uFF0C\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u5DF2\u6D3E\u53D1");
      if (status === "queued" && location.pathname === "/history") {
        location.href = "/";
        return;
      }
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
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function endInteractiveTask(id) {
    if (!confirm("\u7ED3\u675F\u4EA4\u4E92\u4F1A\u8BDD\uFF1F\u5C06\u5411\u7EC8\u7AEF\u53D1\u9001\u8BE5 CLI \u7684\u9000\u51FA\u547D\u4EE4\uFF08pi \u4E3A /quit\uFF09\uFF0Cagent \u6536\u5C3E\u540E\u4EFB\u52A1\u6309\u6B63\u5E38\u9000\u51FA\u7ED3\u679C\u7ED3\u7B97\u3002")) return;
    try {
      const res = await api(`/api/tasks/${id}/end-session`, { method: "POST" });
      toast(`\u5DF2\u53D1\u9001 ${res.sent}\uFF0C\u7B49\u5F85 agent \u9000\u51FA`);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function rejectTask(id) {
    const note = prompt("\u9A73\u56DE\u539F\u56E0 / \u4FEE\u6539\u610F\u89C1\uFF08\u5C06\u8FFD\u52A0\u5230\u4EFB\u52A1\u63D0\u793A\u8BCD\uFF0C\u91CD\u65B0\u6267\u884C\uFF09");
    if (note === null) return;
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "queued", review_note: note })
      });
      toast("\u5DF2\u9A73\u56DE\uFF0C\u4EFB\u52A1\u91CD\u65B0\u6267\u884C");
      await loadAll();
      showDetail(id);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function deleteTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (isMergeTask(task)) return toast("\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u4E0D\u80FD\u5355\u72EC\u5220\u9664\uFF1B\u8BF7\u91CD\u8BD5\u5B83\uFF0C\u6216\u5220\u9664\u6E90\u4EFB\u52A1\u4EE5\u653E\u5F03\u6574\u7EC4\u4EE3\u7801", true);
    if (!confirm(`\u5220\u9664\u4EFB\u52A1 #${id}\uFF1F\u6267\u884C\u65E5\u5FD7\u3001worktree\u3001\u4EFB\u52A1\u5206\u652F\u53CA\u5176\u5408\u5E76\u5B50\u4EFB\u52A1\u5C06\u4E00\u5E76\u5220\u9664\u3002`)) return;
    try {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      await loadAll();
      const p = location.pathname;
      if (state.selected === id) closeDetail();
      if (p === "/history") loadHistory();
      if (p === "/projects" && state.projectView) refreshProjectDetail();
      if (p === "/") loadDashboard();
      if (p === "/board") {
        renderBoard();
        renderList();
      }
    } catch (e) {
      toast(e.message, true);
    }
  }
  function canRetryTask(t) {
    if (!["succeeded", "failed", "cancelled"].includes(t.status)) return false;
    if (isMergeTask(t)) return ["failed", "cancelled"].includes(t.status);
    return !(t.status === "succeeded" && (t.worktree_branch || mergeTaskFor(t)));
  }
  function retryTaskLabel(t) {
    return isMergeTask(t) ? "\u91CD\u8BD5\u5408\u5E76" : "\u91CD\u8BD5";
  }
  function canDeleteTask(t) {
    return !isMergeTask(t);
  }
  async function loadChildren(id) {
    try {
      const kids = await api(`/api/tasks/${id}/children`);
      const box = document.getElementById("childrenBox");
      if (!box || !kids.length) return;
      const sourceKids = kids.filter((k) => !isMergeTask(k));
      const mergeKids = kids.filter(isMergeTask);
      const section = (title, items, open, merge) => {
        if (!items.length) return "";
        const done = items.filter((k) => ["succeeded", "failed", "cancelled"].includes(k.status)).length;
        return `<details class="task-section task-subtasks ${merge ? "task-merge-children" : ""}"${open ? " open" : ""}>
        <summary><span>${title}</span><span class="section-meta">${done}/${items.length} \u5DF2\u7ED3\u675F</span></summary>
        <div class="task-subtask-list">` + items.map((k) => `<div class="task-subtask" onclick="openTask(${k.id})">
          <a class="c-title card-primary-action" href="#/issue/${k.id}" onclick="event.stopPropagation();openTask(${k.id});return false">#${k.id} ${esc(k.title)}</a>
          <div class="c-meta">${isMergeTask(k) ? `<span class="chip merge">\u4EE3\u7801\u5408\u5E76</span>` : ""}<span class="badge ${k.status}" style="--st-color:${ST_COLOR[k.status]}"><span class="st-dot"></span>${STATUS_LABEL[k.status]}</span>
          <span style="font-size:11px;color:var(--fg-faint)">${esc(k.agent_name || "")}</span></div>
        </div>`).join("") + `</div></details>`;
      };
      const sourceActive = sourceKids.some((k) => ["queued", "claimed", "running", "awaiting_review"].includes(k.status));
      const mergeActive = mergeKids.some((k) => ["queued", "claimed", "running", "awaiting_review"].includes(k.status));
      box.innerHTML = section("\u5B50\u4EFB\u52A1", sourceKids, sourceActive, false) + section("\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1", mergeKids, mergeActive, true);
    } catch (_) {
    }
  }
  function openSubTask(parentId) {
    fillSelects();
    const t = state.tasks.find((x) => x.id === parentId);
    document.getElementById("tTitle").value = "";
    document.getElementById("tBody").value = "";
    document.getElementById("tPerm").value = t ? t.perm : "full";
    document.getElementById("tRunMode").value = "batch";
    document.getElementById("tConcurrent").checked = false;
    document.getElementById("tProject").value = t && t.project_id ? t.project_id : "";
    document.getElementById("tDependencyMode").value = t && t.project_id ? "weak" : "none";
    document.getElementById("tBlockOnFailure").checked = false;
    document.getElementById("tParentId").value = parentId;
    document.getElementById("taskModalTitle").textContent = "\u62C6\u5206\u5B50\u4EFB\u52A1";
    syncTaskRunMode();
    syncTaskDependency();
    openModal("taskModal");
  }
  async function resumeTask(id) {
    if (!confirm(`\u7EE7\u7EED\u4EFB\u52A1 #${id}\uFF1F\u5C06\u4FDD\u7559\u4EFB\u52A1\u7F16\u53F7\u3001\u4EFB\u52A1\u4F1A\u8BDD\u76EE\u5F55\u3001\u5DE5\u4F5C\u7A7A\u95F4\u548C\u5386\u53F2\u8BB0\u5F55\uFF0C\u91CD\u65B0\u6392\u961F\u6267\u884C\u3002`)) return;
    try {
      const t = await api(`/api/tasks/${id}/resume`, { method: "POST" });
      toast(`\u4EFB\u52A1 #${t.id} \u5DF2\u5728\u539F\u4EFB\u52A1\u4E2D\u91CD\u65B0\u6392\u961F`);
      await loadAll();
      openTask(t.id);
      if (state.selected === t.id) showDetail(t.id);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function loadDiff(id) {
    try {
      const d = await api(`/api/tasks/${id}/diff`);
      const box = document.getElementById("diffBox");
      if (!box) return;
      const stat = d.stat.trim();
      const diff = d.diff.trim();
      if (!stat && !diff) {
        box.innerHTML = `<div class="detail-desc">\u65E0\u6587\u4EF6\u6539\u52A8\u6216\u975E git \u4ED3\u5E93${d.note ? "\uFF08" + esc(d.note) + "\uFF09" : ""}</div>`;
        return;
      }
      box.innerHTML = `<div class="detail-desc" style="color:var(--success)">\u6587\u4EF6\u6539\u52A8\uFF08git diff\uFF09${d.branch ? ` \xB7 \u5206\u652F <code class="mono">${esc(d.branch)}</code>` : ""}\uFF1A</div>
      <div class="term"><div class="term-body" style="max-height:180px">${esc(stat)}</div></div>
      ${diff ? `<div class="term"><div class="term-body" style="max-height:300px">${esc(diff).split("\n").map((l) => `<div class="line"><span class="c ${l.startsWith("+") && !l.startsWith("+++") ? "out" : l.startsWith("-") && !l.startsWith("---") ? "err" : "sys"}">${esc(l)}</span></div>`).join("")}</div></div>` : ""}`;
    } catch (_) {
    }
  }
  function tsOf(l) {
    const m = /T(\d{2}:\d{2}:\d{2})/.exec(l.created_at || "");
    return m ? m[1] : "";
  }
  var ANSI_OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
  var ANSI_CSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
  var ANSI_CHAR_RE = /\u001b[()][0-2A-Z]/g;
  var ANSI_RE = /\u001b[@-_]/g;
  function cleanLogContent(content) {
    let text = String(content ?? "").replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(ANSI_CHAR_RE, "").replace(ANSI_RE, "").replace(/\u0000/g, "");
    text = text.split("\n").map((line) => {
      const parts = line.split("\r");
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i] !== "") return parts[i];
      }
      return "";
    }).join("\n");
    return text;
  }
  function logStats() {
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
    const task = state.tasks.find((t) => t.id === state.selected);
    if (task?.run_mode === "interactive") {
      const live = ["claimed", "running"].includes(task.status);
      meta.textContent = `${live ? "\u5B9E\u65F6\u753B\u9762" : "\u5DF2\u5F52\u6863\u753B\u9762"} \xB7 ${INTERACTIVE_TERM_COLS} \xD7 ${INTERACTIVE_TERM_ROWS}`;
      return;
    }
    const { visible, errors } = logStats();
    const count = state.logsHasMore ? `\u5DF2\u52A0\u8F7D ${visible}/${state.logsTotal} \u6761` : `${visible} \u6761`;
    meta.textContent = count + (errors ? ` \xB7 ${errors} \u4E2A\u9519\u8BEF` : "");
  }
  async function loadOlderLogs(box, id) {
    if (state.selected !== id || state.logsTask !== id || !state.logsHasMore || state.logsLoading) return;
    const before = state.logsOldestSeq;
    if (!before) return;
    state.logsLoading = true;
    try {
      const page = await fetchTaskLogs(id, { before, limit: 200 });
      if (state.selected !== id || !box.isConnected) return;
      const existing = new Set(state.logs.map((l) => l.id));
      const older = page.logs.filter((l) => !existing.has(l.id));
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
      requestAnimationFrame(() => {
        box.scrollTop = top + box.scrollHeight - height;
      });
      updateLogMeta();
    } catch (_) {
    } finally {
      state.logsLoading = false;
    }
  }
  function logLineHTML(l) {
    const content = cleanLogContent(l.content);
    if (!content.trim() && l.stream !== "sys") return "";
    return `<div class="line"><span class="ts">${tsOf(l)}</span><span class="c ${l.stream}">${esc(content)}</span></div>`;
  }
  function logsHTML() {
    return state.logs.map(logLineHTML).filter(Boolean).join("");
  }
  function appendLog(l) {
    if (state.selected === l.task_id) {
      if (state.logs.some((existing) => existing.id === l.id)) return;
      state.logs.push(l);
      state.logsTotal = Math.max(state.logsTotal + 1, state.logs.length);
      const box = document.getElementById("logBox");
      if (box) {
        const task = state.tasks.find((t) => t.id === l.task_id);
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
  async function copyLogs() {
    try {
      if (!state.selected) return;
      const task = state.tasks.find((t) => t.id === state.selected);
      const terminalView = task?.run_mode === "interactive" ? taskTerminalText() : "";
      if (terminalView.trim()) {
        await navigator.clipboard.writeText(terminalView);
        toast("\u5DF2\u590D\u5236\u5F53\u524D\u7EC8\u7AEF\u753B\u9762");
        return;
      }
      const page = await fetchTaskLogs(state.selected, { all: true });
      await navigator.clipboard.writeText(page.logs.map((l) => cleanLogContent(l.content)).filter(Boolean).join("\n"));
      toast("\u5DF2\u590D\u5236\u5BF9\u8BDD\u5185\u5BB9");
    } catch (_) {
      toast("\u590D\u5236\u5931\u8D25", true);
    }
  }
  function openNewTask() {
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
    document.getElementById("taskModalTitle").textContent = "\u65B0\u5EFA\u4EFB\u52A1";
    syncTaskRunMode();
    syncTaskDependency();
    openModal("taskModal");
  }
  function openProjectTask(projectId) {
    const p = state.projects.find((x) => x.id === projectId);
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
    document.getElementById("taskModalTitle").textContent = p ? `\u65B0\u5EFA\u4EFB\u52A1 \xB7 ${esc(p.name)}` : "\u65B0\u5EFA\u4EFB\u52A1";
    syncTaskRunMode();
    syncTaskDependency();
    openModal("taskModal");
  }
  function syncTaskRunMode() {
    const agentID = Number(document.getElementById("tAgent")?.value) || 0;
    const agent = state.agents.find((a) => a.id === agentID);
    const select = document.getElementById("tRunMode");
    const help = document.getElementById("tRunModeHelp");
    if (!select) return;
    const interactive = select.querySelector('option[value="interactive"]');
    if (interactive) interactive.disabled = !agent;
    if (!agent && select.value === "interactive") select.value = "batch";
    if (help) {
      help.textContent = agent ? `\u6279\u5904\u7406\u4F1A\u81EA\u52A8\u7ED3\u7B97\uFF1B\u4EA4\u4E92\u5F0F\u4F1A\u4FDD\u7559 ${agent.name} \u7684\u539F\u751F\u7EC8\u7AEF\uFF0C\u76F4\u5230\u4F60\u53D1\u9001 /exit\u3002` : "\u6279\u5904\u7406\u4F1A\u81EA\u52A8\u7ED3\u7B97\uFF1B\u9009\u62E9\u89D2\u8272\u540E\u53EF\u542F\u7528\u5176\u4EA4\u4E92\u5F0F\u7EC8\u7AEF\u3002";
    }
  }
  function syncTaskDependency() {
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
    const candidates = projectID ? state.tasks.filter((t) => t.project_id === projectID && !isMergeTask(t)).sort((a, b) => b.id - a.id) : [];
    dependsEl.innerHTML = `<option value="">\u9009\u62E9\u524D\u7F6E\u5B9E\u73B0\u4EFB\u52A1</option>` + candidates.map((t) => `<option value="${t.id}">#${t.id} \xB7 ${esc(t.title)}</option>`).join("");
    if (selected && candidates.some((t) => t.id === selected)) dependsEl.value = selected;
    const strong = projectID && mode === "strong";
    row.classList.toggle("hidden", !strong);
    dependsEl.disabled = !strong;
    if (help) {
      if (!projectID) {
        help.textContent = "\u65E0\u9879\u76EE\u4EFB\u52A1\u9ED8\u8BA4\u72EC\u7ACB\u6267\u884C\uFF1B\u5982\u9700\u6309\u4EE3\u7801\u57FA\u7EBF\u987A\u5E8F\uFF0C\u8BF7\u5148\u9009\u62E9\u9879\u76EE\u3002";
      } else if (mode === "strong") {
        help.textContent = "\u660E\u786E\u524D\u7F6E\u662F\u5F3A\u4F9D\u8D56\uFF1A\u65E0\u8BBA\u524D\u7F6E\u662F\u5426\u8BBE\u7F6E\u5931\u8D25\u53EF\u8DF3\u8FC7\uFF0C\u672C\u4EFB\u52A1\u90FD\u5FC5\u987B\u7B49\u5B83\u548C\u5176\u5408\u5E76\u4EFB\u52A1\u6210\u529F\u3002";
      } else if (mode === "none") {
        help.textContent = "\u72EC\u7ACB\u4EFB\u52A1\u4E0D\u7B49\u5F85\u6B64\u524D\u4EA4\u4ED8\uFF1B\u540E\u7EED\u9ED8\u8BA4\u4EFB\u52A1\u4ECD\u4F1A\u6309\u9879\u76EE\u6267\u884C\u987A\u5E8F\u4EE5\u672C\u4EFB\u52A1\u4E3A\u524D\u5E8F\u3002";
      } else {
        help.textContent = "\u81EA\u52A8\u5F31\u4F9D\u8D56\uFF1A\u7B49\u5F85\u5F53\u524D\u9879\u76EE\u6B64\u524D\u987A\u5E8F\u4E2D\u7684\u4EA4\u4ED8\uFF1B\u82E5\u524D\u5E8F\u5931\u8D25\u4E14\u672A\u8BBE\u7F6E\u963B\u585E\uFF0C\u4F1A\u8DF3\u8FC7\u5B83\u7EE7\u7EED\u6267\u884C\u3002";
      }
    }
  }
  function syncTaskConcurrency() {
    const concurrent = document.getElementById("tConcurrent")?.checked;
    const modeEl = document.getElementById("tDependencyMode");
    if (concurrent && modeEl?.value === "weak") modeEl.value = "none";
    syncTaskDependency();
  }
  async function submitTask() {
    const title = document.getElementById("tTitle").value.trim();
    if (!title) return toast("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A", true);
    const parentId = Number(document.getElementById("tParentId").value) || null;
    const projectId = Number(document.getElementById("tProject").value) || null;
    let dependencyMode = document.getElementById("tDependencyMode").value || "none";
    if (!projectId) dependencyMode = "none";
    const dependsOn = dependencyMode === "strong" ? Number(document.getElementById("tDependsOn").value) || null : null;
    if (dependencyMode === "strong" && !dependsOn) return toast("\u8BF7\u9009\u62E9\u660E\u786E\u524D\u7F6E\u4EFB\u52A1", true);
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
          parent_id: parentId
        })
      });
      closeModal("taskModal");
      toast("\u4EFB\u52A1\u5DF2\u521B\u5EFA");
      await loadAll();
      renderBoard();
      renderList();
      refreshOverview();
      if (location.pathname === "/projects" && state.projectView) refreshProjectDetail();
    } catch (e) {
      toast(e.message, true);
    }
  }
  function applyTemplate() {
    const t = state.templates.find((x) => x.id === Number(document.getElementById("tTemplate").value));
    if (!t) return;
    document.getElementById("tBody").value = t.body || "";
    if (t.agent_id) document.getElementById("tAgent").value = t.agent_id;
    syncTaskRunMode();
  }
  async function saveAsTemplate(taskId) {
    let t;
    try {
      t = await api(`/api/tasks/${taskId}`);
    } catch (_) {
      return;
    }
    const name = prompt("\u6A21\u677F\u540D\u79F0\uFF08\u7528\u4E8E\u590D\u7528\u8BE5\u4EFB\u52A1\u7684\u63D0\u793A\u8BCD\uFF09", t.title);
    if (!name) return;
    try {
      await api("/api/templates", { method: "POST", body: JSON.stringify({ name, body: t.body, agent_id: t.agent_id }) });
      toast("\u5DF2\u4FDD\u5B58\u4E3A\u6A21\u677F");
      loadTemplates();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // internal/web/static/src/projects.js
  function renderProjectList() {
    const grid = document.getElementById("projectGrid");
    if (!grid) return;
    const q = (document.getElementById("pSearch")?.value || "").trim().toLowerCase();
    const list = state.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    grid.innerHTML = list.map((p) => {
      const ts = state.tasks.filter((t) => t.project_id === p.id);
      const sourceTasks = ts.filter((t) => !isMergeTask(t));
      const mergeTasks = ts.filter(isMergeTask);
      const done = sourceTasks.filter((t) => t.status === "succeeded").length;
      const pct = sourceTasks.length ? done / sourceTasks.length * 100 : 0;
      const agents = new Set(ts.map((t) => t.agent_name).filter(Boolean));
      return `<a class="project-card" href="/projects#/project/${p.id}">
      <div class="pc-top">
        <b>${esc(p.name)}</b>
        ${p.is_git ? `<span class="chip git-chip" title="git \u4ED3\u5E93\uFF0C\u4EFB\u52A1\u5C06\u83B7\u5F97\u72EC\u7ACB worktree">git</span>` : `<span class="chip" title="\u975E git \u4ED3\u5E93\uFF0C\u4EFB\u52A1\u76F4\u63A5\u5728\u9879\u76EE\u76EE\u5F55\u6267\u884C">\u975E git</span>`}
        <span class="badge ${p.status === "active" ? "running" : "cancelled"}">${p.status === "active" ? "\u8FDB\u884C\u4E2D" : "\u5DF2\u5F52\u6863"}</span>
      </div>
      ${p.description ? `<div class="pc-desc">${esc(p.description)}</div>` : ""}
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${fmtPct(pct)}</span></div>
      <div class="pc-meta">
        ${p.project_dir ? `<span class="pc-dir" title="${esc(p.project_dir)}">${esc(p.project_dir)}</span>` : ""}
        <span>${sourceTasks.length} \u4EFB\u52A1</span>
        ${mergeTasks.length ? `<span>${mergeTasks.length} \u5408\u5E76</span>` : ""}
        <span>${done} \u5B9E\u73B0\u5B8C\u6210</span>
        <span>${agents.size} \u89D2\u8272</span>
        <span class="spacer"></span>
        <span class="pc-date">${(p.updated_at || p.created_at || "").slice(5, 16).replace("T", " ")}</span>
      </div>
    </a>`;
    }).join("");
    const empty = document.getElementById("projectEmpty");
    if (empty) empty.classList.toggle("hidden", list.length > 0);
    const cnt = document.getElementById("projectCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u9879\u76EE`;
  }
  function openProject(id) {
    location.hash = "#/project/" + id;
  }
  function closeProjectDetail() {
    location.hash = "#/";
  }
  function showProjectDetail(id) {
    state.projectView = id;
    document.getElementById("projectListShell").classList.add("hidden");
    document.getElementById("projectDetailShell").classList.remove("hidden");
    refreshProjectDetail();
  }
  function hideProjectDetail() {
    document.getElementById("projectDetailShell").classList.add("hidden");
    document.getElementById("projectListShell").classList.remove("hidden");
    state.projectView = null;
  }
  async function refreshProjectDetail() {
    if (!state.projectView) return;
    const id = state.projectView;
    const p = state.projects.find((x) => x.id === id);
    if (!p) return;
    document.getElementById("pdCrumb").innerHTML = `\u9879\u76EE / <b>${esc(p.name)}</b>`;
    document.getElementById("pdBadge").innerHTML = `<span class="badge ${p.status === "active" ? "running" : "cancelled"}">${p.status === "active" ? "\u8FDB\u884C\u4E2D" : "\u5DF2\u5F52\u6863"}</span>`;
    try {
      const [stats, tasks] = await Promise.all([
        api(`/api/stats/project/${id}`),
        api(`/api/tasks?project_id=${id}`)
      ]);
      state.projectStats[id] = stats;
      renderProjectDetail(p, stats, tasks);
    } catch (_) {
    }
  }
  function projectTaskOrder(a, b) {
    const ao = Number(a.sort_order) || 0;
    const bo = Number(b.sort_order) || 0;
    if (ao !== bo) return ao - bo;
    const ac = a.created_at || "";
    const bc = b.created_at || "";
    return ac === bc ? a.id - b.id : ac.localeCompare(bc);
  }
  function queuedProjectTaskIDs(tasks) {
    return tasks.filter((t) => !isMergeTask(t) && t.status === "queued").sort(projectTaskOrder).map((t) => t.id);
  }
  async function persistProjectTaskOrder(projectID, taskIDs) {
    if (state.projectReorderBusy) return;
    state.projectReorderBusy = true;
    try {
      await api(`/api/projects/${projectID}/tasks/order`, {
        method: "PUT",
        body: JSON.stringify({ task_ids: taskIDs })
      });
      await loadAll();
      await refreshProjectDetail();
      toast("\u4EFB\u52A1\u987A\u5E8F\u5DF2\u66F4\u65B0");
    } catch (e) {
      toast(e.message, true);
      await refreshProjectDetail();
    } finally {
      state.projectReorderBusy = false;
    }
  }
  async function moveProjectTask(projectID, taskID, direction) {
    if (state.projectReorderBusy) return;
    try {
      const tasks = await api(`/api/tasks?project_id=${projectID}`);
      const ids = queuedProjectTaskIDs(tasks);
      const index = ids.indexOf(taskID);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await persistProjectTaskOrder(projectID, ids);
    } catch (e) {
      toast(e.message, true);
    }
  }
  function startProjectTaskDrag(event, projectID, taskID) {
    if (state.projectReorderBusy) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${projectID}:${taskID}`);
    event.currentTarget.classList.add("dragging");
  }
  function allowProjectTaskDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    if (state.projectReorderBusy || event.currentTarget.dataset.reorderable !== "true") return;
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drag-over");
  }
  async function dropProjectTask(event, projectID, targetID) {
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll(".p-task-row.drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (state.projectReorderBusy) return;
    const raw = event.dataTransfer.getData("text/plain") || "";
    const [sourceProject, sourceID] = raw.split(":").map(Number);
    if (sourceProject !== projectID || !sourceID || sourceID === targetID) return;
    const rows = [...document.querySelectorAll("#pdMain .p-task-row[data-reorderable='true']")];
    const ids = rows.map((row) => Number(row.dataset.taskId)).filter(Boolean);
    const from = ids.indexOf(sourceID);
    const target = ids.indexOf(targetID);
    if (from < 0 || target < 0) return;
    ids.splice(from, 1);
    const targetAfterMove = ids.indexOf(targetID);
    const rect = event.currentTarget.getBoundingClientRect();
    const insertAt = event.clientY < rect.top + rect.height / 2 ? targetAfterMove : targetAfterMove + 1;
    ids.splice(insertAt, 0, sourceID);
    await persistProjectTaskOrder(projectID, ids);
  }
  function endProjectTaskDrag(event) {
    event.currentTarget.classList.remove("dragging");
    document.querySelectorAll(".p-task-row.drag-over").forEach((el) => el.classList.remove("drag-over"));
  }
  function renderProjectDetail(p, s, tasks) {
    const main = document.getElementById("pdMain");
    const side = document.getElementById("pdSide");
    if (!main || !side) return;
    const counts = s.status_counts || [];
    const review = counts.find((c) => c.status === "awaiting_review");
    const sourceTasks = tasks.filter((t) => !isMergeTask(t)).sort(projectTaskOrder);
    const mergeTasks = tasks.filter(isMergeTask);
    const rowHTML = (items, merge) => {
      const pendingItems = merge ? [] : items.filter((t) => t.status === "queued");
      const pendingIndex = new Map(pendingItems.map((t, i) => [t.id, i]));
      return items.map((t) => {
        const reorderable = !merge && t.status === "queued";
        const index = pendingIndex.get(t.id);
        const orderActions = reorderable && pendingItems.length > 1 ? `
        <span class="task-order-actions" aria-label="\u8C03\u6574\u6267\u884C\u987A\u5E8F">
          <button type="button" class="icon-btn" title="\u4E0A\u79FB" aria-label="\u4E0A\u79FB\u4EFB\u52A1" ${index === 0 ? "disabled" : ""} onclick="event.stopPropagation();moveProjectTask(${p.id},${t.id},-1)">${icon("arrowUp")}</button>
          <button type="button" class="icon-btn" title="\u4E0B\u79FB" aria-label="\u4E0B\u79FB\u4EFB\u52A1" ${index === pendingItems.length - 1 ? "disabled" : ""} onclick="event.stopPropagation();moveProjectTask(${p.id},${t.id},1)">${icon("arrowDown")}</button>
        </span>` : "";
        return `
    <div class="p-task-row ${merge ? "merge-task-row" : ""} ${reorderable ? "sortable-task-row" : ""}"
      ${reorderable ? `data-task-id="${t.id}" data-reorderable="true" draggable="true" ondragstart="startProjectTaskDrag(event,${p.id},${t.id})" ondragover="allowProjectTaskDrop(event)" ondrop="dropProjectTask(event,${p.id},${t.id})" ondragend="endProjectTaskDrag(event)"` : ""}
      onclick="openTask(${t.id})">
      ${reorderable ? `<span class="task-drag-handle" title="\u62D6\u52A8\u8C03\u6574\u6267\u884C\u987A\u5E8F" aria-label="\u62D6\u52A8\u8C03\u6574\u6267\u884C\u987A\u5E8F">${icon("grip")}</span>` : ""}
      <span class="num">#${t.id}</span>
      <a class="t card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
      ${merge ? `<span class="chip merge">\u5408\u5E76 #${t.merge_of}</span>` : ""}
      ${merge ? "" : dependencyChip(t)}
      ${!merge && t.status === "queued" && dependencyInfo(t).state === "blocked" ? `<span class="chip dependency blocked" title="${esc(dependencyInfo(t).reason)}">${esc(dependencyInfo(t).stateLabel || "\u7B49\u5F85\u524D\u5E8F")}</span>` : ""}
      <span class="a">${t.agent_name ? `<span class="avatar sm">${esc(t.agent_name.slice(0, 1))}</span>${esc(t.agent_name)}` : "-"}</span>
      <span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>
      ${orderActions}
      <span class="ops">
          ${canRetryTask(t) ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}${retryTaskLabel(t)}</button>` : ""}
        ${canDeleteTask(t) ? `<button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}\u5220\u9664</button>` : ""}
      </span>
    </div>`;
      }).join("");
    };
    const agentsHTML = (s.agents || []).map((a) => `
    <tr>
      <td class="t-title"><span class="avatar sm">${esc((a.agent_name || "?").slice(0, 1))}</span>
        <a class="t-link" href="/roles#/agent/${a.agent_id}">${esc(a.agent_name || "\u672A\u6307\u6D3E")}</a></td>
      <td class="num">${a.total}</td>
      <td class="num" style="color:var(--success)">${a.succeeded}</td>
      <td class="num" style="color:var(--danger)">${a.failed}</td>
      <td class="num">${a.reviews || 0}</td>
      <td class="num">${fmtPct(a.success_rate)}</td>
      <td class="num">${fmtDur(a.avg_duration)}</td>
    </tr>`).join("");
    main.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="detail-id">\u521B\u5EFA\u4E8E ${esc((p.created_at || "").slice(0, 16).replace("T", " "))}</div>
    ${p.description ? `<div class="detail-desc">${esc(p.description)}</div>` : ""}

    <div class="pd-stats">
      <div class="pd-ring">${ringHTML(s.progress || 0, "\u5B8C\u6210\u5EA6")}</div>
      <div class="pd-chips">
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-running)"></span><b>${s.in_flight || 0}</b><span>\u8FDB\u884C\u4E2D</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-review)"></span><b>${review ? review.count : 0}</b><span>\u5F85\u5BA1\u6279</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${s.succeeded}</b><span>\u5B8C\u6210</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--st-failed)"></span><b>${s.failed}</b><span>\u5931\u8D25</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${sourceTasks.length}</b><span>\u5B9E\u73B0\u4EFB\u52A1</span></div>
        <div class="stat-chip"><span class="sc-dot" style="background:var(--merge-accent)"></span><b>${mergeTasks.length}</b><span>\u5408\u5E76\u4EFB\u52A1</span></div>
      </div>
    </div>

    <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
    ${dailyChartHTML(s.daily, 14)}

    <div class="sec-title task-section-title">
      <span>\u4EFB\u52A1 ${sourceTasks.length}</span>
      <span class="section-note">\u5F85\u6267\u884C\u4EFB\u52A1\u53EF\u62D6\u52A8\u6216\u7528\u7BAD\u5934\u8C03\u6574\u987A\u5E8F\uFF0C\u9ED8\u8BA4\u6309\u521B\u5EFA\u65F6\u95F4</span>
      <button class="btn sm brand" onclick="openProjectTask(${p.id})">${icon("plus")}\u65B0\u5EFA\u4EFB\u52A1</button>
    </div>
    <div class="p-task-list">
      ${rowHTML(sourceTasks, false) || `<div class="empty">\u8FD8\u6CA1\u6709\u4EFB\u52A1
        <button class="btn xs brand" style="margin-left:8px" onclick="openProjectTask(${p.id})">${icon("plus")}\u6D3E\u6D3B</button></div>`}
    </div>

    <div class="sec-title task-section-title"><span>\u4EE3\u7801\u5408\u5E76 ${mergeTasks.length}</span><span class="section-note">\u7531\u5DF2\u5B8C\u6210\u4EFB\u52A1\u81EA\u52A8\u521B\u5EFA</span></div>
    <div class="p-task-list merge-task-list">
      ${rowHTML(mergeTasks, true) || `<div class="empty">\u4EE3\u7801\u5408\u5E76\u4EFB\u52A1\u4F1A\u5728\u5B9E\u73B0\u4EFB\u52A1\u5B8C\u6210\u6216\u5BA1\u6279\u901A\u8FC7\u540E\u81EA\u52A8\u521B\u5EFA\u3002</div>`}
    </div>

    <div class="sec-title">\u6210\u5458\u7EDF\u8BA1\uFF08\u5728\u672C\u9879\u76EE\u4E0A\u5DE5\u4F5C\u7684 agent\uFF09</div>
    <div class="list-wrap" style="max-height:340px">
      <table class="list-grid">
        <thead><tr><th>\u89D2\u8272</th><th>\u4EFB\u52A1</th><th>\u5B8C\u6210</th><th>\u5931\u8D25</th><th>\u5BA1\u6279\u8F6E\u6B21</th><th>\u6210\u529F\u7387</th><th>\u5E73\u5747\u8017\u65F6</th></tr></thead>
        <tbody>${agentsHTML || `<tr><td colspan="7"><div class="empty">\u5C1A\u65E0\u4EA7\u51FA\u7EDF\u8BA1</div></td></tr>`}</tbody>
      </table>
    </div>`;
    side.innerHTML = `
    <div class="sec-title">\u5C5E\u6027</div>
    <div class="prop-row"><span class="k">\u72B6\u6001</span>
      <span class="v"><select onchange="patchProject(${p.id},{status:this.value})">
        <option value="active" ${p.status === "active" ? "selected" : ""}>\u8FDB\u884C\u4E2D</option>
        <option value="archived" ${p.status === "archived" ? "selected" : ""}>\u5DF2\u5F52\u6863</option>
      </select></span></div>
    <div class="prop-row"><span class="k">\u5DE5\u4F5C\u76EE\u5F55</span><span class="v" style="font-size:12px;word-break:break-all">${esc(p.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">\u63CF\u8FF0</span><span class="v" style="font-size:12px;white-space:pre-wrap">${esc(p.description || "-")}</span></div>
    <div class="prop-row"><span class="k">\u521B\u5EFA</span><span class="v">${esc((p.created_at || "").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">\u64CD\u4F5C</div>
    <div class="detail-actions">
      <button class="btn sm brand" onclick="openProjectTask(${p.id})">${icon("plus")}\u65B0\u5EFA\u4EFB\u52A1</button>
      <button class="btn sm" onclick="openProjectModal(${p.id})">\u7F16\u8F91</button>
      <button class="btn sm danger" onclick="deleteProject(${p.id})">\u5220\u9664</button>
    </div>`;
  }
  function openProjectModal(id) {
    const p = id ? state.projects.find((x) => x.id === id) : null;
    document.getElementById("projectModalTitle").textContent = p ? "\u7F16\u8F91\u9879\u76EE" : "\u65B0\u5EFA\u9879\u76EE";
    document.getElementById("pId").value = p ? p.id : "";
    document.getElementById("pName").value = p ? p.name : "";
    document.getElementById("pDesc").value = p ? p.description || "" : "";
    document.getElementById("pProjectDir").value = p ? p.project_dir || "" : "";
    document.getElementById("pStatus").value = p ? p.status || "active" : "active";
    loadProjDatalist();
    openModal("projectModal");
  }
  async function submitProject() {
    const id = document.getElementById("pId").value;
    const body = {
      name: document.getElementById("pName").value.trim(),
      description: document.getElementById("pDesc").value.trim(),
      project_dir: document.getElementById("pProjectDir").value.trim(),
      status: document.getElementById("pStatus").value
    };
    if (!body.name) return toast("\u9879\u76EE\u540D\u4E0D\u80FD\u4E3A\u7A7A", true);
    try {
      if (id) await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
      closeModal("projectModal");
      await loadAll();
      renderProjectList();
      if (state.projectView) refreshProjectDetail();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function patchProject(id, set) {
    try {
      await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(set) });
      await loadAll();
      if (state.projectView === id) refreshProjectDetail();
      renderProjectList();
      toast("\u5DF2\u66F4\u65B0");
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function deleteProject(id) {
    if (!id) id = state.projectView;
    if (!id) return;
    if (!confirm("\u5220\u9664\u8BE5\u9879\u76EE\uFF1F\u9879\u76EE\u4E0B\u7684\u4EFB\u52A1\u5C06\u4FDD\u7559\uFF08\u8F6C\u4E3A\u65E0\u9879\u76EE\uFF09\uFF0C\u9879\u76EE\u7EDF\u8BA1\u968F\u4E4B\u6D88\u5931\u3002")) return;
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      await loadAll();
      if (state.projectView === id) {
        closeProjectDetail();
      }
      renderProjectList();
    } catch (e) {
      toast(e.message, true);
    }
  }
  function dailyChartHTML(daily, days) {
    days = days || 14;
    const map = {};
    (daily || []).forEach((d) => map[d.date] = d.count);
    const vals = Object.values(map);
    const max = Math.max(1, ...vals);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      const key = d.toISOString().slice(0, 10);
      const c = map[key] || 0;
      const today = i === 0;
      out.push(`<div class="bc-col ${today ? "today" : ""}" title="${key}: ${c} \u4E2A\u5B8C\u6210">
      <div class="bc-bar" style="height:${Math.round(c / max * 100)}%;${c === 0 ? "opacity:.22" : ""}"></div>
      <div class="bc-day">${i % 2 === 0 ? key.slice(5) : ""}</div>
    </div>`);
    }
    return `<div class="bar-chart">${out.join("")}</div>`;
  }
  function ringHTML(pct, label) {
    const deg = Math.round(Math.min(100, pct) * 3.6);
    return `<div class="ring" style="background:conic-gradient(var(--brand) ${deg}deg, rgba(255,255,255,.09) 0)">
    <div class="ring-inner"><b>${fmtPct(pct)}</b><span>${label}</span></div>
  </div>`;
  }
  function statusBarHTML(counts) {
    const order = ["queued", "claimed", "running", "awaiting_review", "succeeded", "failed", "cancelled"];
    const total = (counts || []).reduce((a, c) => a + c.count, 0);
    if (!total) return `<div class="status-bar"><div class="sb-empty"></div></div>`;
    const segs = [...counts || []].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).filter((c) => c.count > 0).map((c) => `<div class="sb-seg" title="${STATUS_LABEL[c.status]}: ${c.count}" style="width:${c.count / total * 100}%;background:${ST_COLOR[c.status]}"></div>`).join("");
    return `<div class="status-bar">${segs}</div>`;
  }
  var dirState = { inputId: null, path: "" };
  async function dirLoad(path) {
    try {
      const d = await api(`/api/fs/dirs?path=${encodeURIComponent(path || "")}`);
      dirState.path = d.path;
      const el = document.getElementById("dirCrumb");
      const segs = d.path.split("/").filter(Boolean);
      let html = `<button type="button" class="crumb-seg" data-p="/" aria-label="\u8FD4\u56DE\u6839\u76EE\u5F55">/</button>`;
      let cur = "";
      segs.forEach((s, i) => {
        cur += "/" + s;
        const last = i === segs.length - 1;
        html += `<span class="crumb-sep">/</span>` + (last ? `<span class="crumb-seg cur" aria-current="location">${esc(s)}</span>` : `<button type="button" class="crumb-seg" data-p="${esc(cur)}">${esc(s)}</button>`);
      });
      el.innerHTML = html;
      const list = document.getElementById("dirList");
      list.innerHTML = "";
      if (d.parent !== d.path) {
        const up = document.createElement("button");
        up.type = "button";
        up.className = "dir-row up";
        up.dataset.path = d.parent;
        up.innerHTML = icon("back") + `<span>\u4E0A\u4E00\u7EA7</span>`;
        list.appendChild(up);
      }
      d.dirs.forEach((n) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "dir-row";
        row.dataset.path = d.path.replace(/\/+$/, "") + "/" + n;
        row.innerHTML = icon("folder") + `<span class="dr-name">${esc(n)}</span>`;
        list.appendChild(row);
      });
      if (!d.dirs.length) list.innerHTML = `<div class="empty">\u7A7A\u76EE\u5F55</div>`;
    } catch (e) {
      toast(e.message, true);
    }
  }
  function openDirPicker(inputId) {
    dirState.inputId = inputId;
    const cur = (document.getElementById(inputId).value || "").trim();
    document.getElementById("dirNewName").value = "";
    dirLoad(cur || "");
    openModal("dirModal");
  }
  function pickDir() {
    const input = document.getElementById(dirState.inputId);
    if (input) input.value = dirState.path;
    closeModal("dirModal");
    toast("\u5DF2\u9009\u62E9\u76EE\u5F55");
  }
  async function mkdirCurrent() {
    const name = document.getElementById("dirNewName").value.trim();
    if (!name) return toast("\u5148\u8F93\u5165\u76EE\u5F55\u540D", true);
    const p = dirState.path.replace(/\/+$/, "") + "/" + name;
    try {
      await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ path: p }) });
      document.getElementById("dirNewName").value = "";
      toast("\u5DF2\u521B\u5EFA");
      dirLoad(dirState.path);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function loadProjDatalist() {
    for (const id of ["dlistProj", "dlistSkill"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    }
    try {
      const d = await api("/api/fs/dirs");
      const opts = d.dirs.map((n) => `<option value="${esc(d.path.replace(/\/+$/, "") + "/" + n)}">`).join("");
      for (const id of ["dlistProj", "dlistSkill"]) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
      }
    } catch (_) {
    }
  }

  // internal/web/static/src/agents.js
  var dlSeq = 0;
  var AGENT_SORT_OPTIONS = [
    ["name-asc", "\u540D\u79F0 A-Z"],
    ["name-desc", "\u540D\u79F0 Z-A"],
    ["created-desc", "\u6700\u8FD1\u521B\u5EFA"],
    ["created-asc", "\u6700\u65E9\u521B\u5EFA"],
    ["cli-asc", "CLI A-Z"],
    ["model-asc", "\u6A21\u578B A-Z"],
    ["concurrency-desc", "\u6700\u5927\u5E76\u53D1\uFF1A\u9AD8\u5230\u4F4E"],
    ["concurrency-asc", "\u6700\u5927\u5E76\u53D1\uFF1A\u4F4E\u5230\u9AD8"],
    ["tasks-desc", "\u4EFB\u52A1\u6570\uFF1A\u591A\u5230\u5C11"],
    ["tasks-asc", "\u4EFB\u52A1\u6570\uFF1A\u5C11\u5230\u591A"],
    ["status-enabled", "\u542F\u7528\u72B6\u6001\u4F18\u5148"]
  ];
  function normalizeAgentSort(sort) {
    return AGENT_SORT_OPTIONS.some(([value]) => value === sort) ? sort : "name-asc";
  }
  function compareText(a, b) {
    return String(a || "").localeCompare(String(b || ""), "zh-CN", {
      numeric: true,
      sensitivity: "base"
    });
  }
  function compareAgentValues(a, b, sort, stats) {
    switch (sort) {
      case "name-asc":
        return compareText(a.name, b.name);
      case "name-desc":
        return compareText(b.name, a.name);
      case "created-desc":
        return compareText(b.created_at, a.created_at);
      case "created-asc":
        return compareText(a.created_at, b.created_at);
      case "cli-asc":
        return compareText(a.cli, b.cli);
      case "model-asc":
        return compareText(a.role_config?.model, b.role_config?.model);
      case "concurrency-desc":
        return (b.max_concurrency || 1) - (a.max_concurrency || 1);
      case "concurrency-asc":
        return (a.max_concurrency || 1) - (b.max_concurrency || 1);
      case "tasks-desc":
        return stats(b).total - stats(a).total;
      case "tasks-asc":
        return stats(a).total - stats(b).total;
      case "status-enabled":
        return Number(b.enabled) - Number(a.enabled);
      default:
        return 0;
    }
  }
  function sortAgents(list, sort = state.agentSort) {
    const normalized = normalizeAgentSort(sort);
    const stats = /* @__PURE__ */ new Map();
    const getStats = (a) => {
      if (!stats.has(a.id)) stats.set(a.id, agentTaskStats(a));
      return stats.get(a.id);
    };
    return [...list].sort((a, b) => compareAgentValues(a, b, normalized, getStats) || compareText(a.name, b.name) || Number(a.id || 0) - Number(b.id || 0));
  }
  function setAgentSort(sort) {
    state.agentSort = normalizeAgentSort(sort);
    const select = document.getElementById("agentSort");
    if (select && select.value !== state.agentSort) select.value = state.agentSort;
    try {
      localStorage.setItem("paihuo.agentSort", state.agentSort);
    } catch (_) {
    }
    renderAgentList();
  }
  function setAgentView(v) {
    state.agentView = v;
    const g = document.getElementById("segGrid"), t = document.getElementById("segTable");
    if (g) g.classList.toggle("active", v === "grid");
    if (t) t.classList.toggle("active", v === "table");
    const grid = document.getElementById("agentGrid");
    const wrap = document.getElementById("agentTableWrap");
    if (grid) grid.classList.toggle("hidden", v !== "grid");
    if (wrap) wrap.classList.toggle("hidden", v !== "table");
    try {
      localStorage.setItem("paihuo.agentView", v);
    } catch (_) {
    }
    renderAgentList();
  }
  function agentTaskStats(a) {
    const ts = state.tasks.filter((t) => t.agent_id === a.id);
    return {
      total: ts.length,
      inFlight: ts.filter((t) => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length,
      review: ts.filter((t) => t.status === "awaiting_review").length
    };
  }
  function filteredAgents() {
    const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
    const list = state.agents.filter((a) => {
      if (!q) return true;
      const rc = a.role_config || {};
      return [a.name, a.description, a.cli, rc.model].some((value) => String(value || "").toLowerCase().includes(q));
    });
    return { list: sortAgents(list), query: q };
  }
  function renderAgentEmpty(list, query) {
    const empty = document.getElementById("agentEmpty");
    if (!empty) return;
    if (!list.length) {
      empty.innerHTML = query ? `<b class="empty-title">\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u89D2\u8272</b>
        <span class="empty-copy">\u5C1D\u8BD5\u6E05\u9664\u641C\u7D22\u8BCD\uFF0C\u67E5\u770B\u5168\u90E8\u4EFB\u52A1\u89D2\u8272\u3002</span>
        <button type="button" class="btn sm" onclick="document.getElementById('aSearch').value='';renderAgentList()">\u6E05\u9664\u641C\u7D22</button>` : `<b class="empty-title">\u521B\u5EFA\u7B2C\u4E00\u4E2A\u4EFB\u52A1\u89D2\u8272</b>
        <span class="empty-copy">\u89D2\u8272\u628A\u4E00\u4E2A\u672C\u673A CLI\u3001\u6A21\u578B\u3001\u6280\u80FD\u4E0E\u5E76\u53D1\u7B56\u7565\u7EC4\u5408\u4E3A\u53EF\u590D\u7528\u7684\u6267\u884C\u914D\u7F6E\u3002</span>
        <button type="button" class="btn brand sm" onclick="openRoleStudio()">\u521B\u5EFA\u89D2\u8272</button>`;
    }
    empty.classList.toggle("hidden", list.length > 0);
  }
  function agentActionsHTML(a) {
    return `
    <button class="btn xs" title="\u6253\u5F00\u552F\u4E00\u89D2\u8272\u7F16\u8F91\u5668\uFF0C\u7F16\u8F91\u914D\u7F6E\u5E76\u6D4B\u8BD5\u89D2\u8272" onclick="event.stopPropagation();openRoleStudio(${a.id})">\u7F16\u8F91</button>
    <button class="btn xs" title="\u590D\u5236\u6B64\u89D2\u8272\u7684\u914D\u7F6E\uFF0C\u521B\u5EFA\u4E00\u4E2A\u65B0\u89D2\u8272" aria-label="\u590D\u5236\u89D2\u8272 ${esc(a.name)}" onclick="event.stopPropagation();copyRole(${a.id})">${icon("copy")}\u590D\u5236</button>
    <button class="btn xs" title="${a.enabled ? "\u505C\u7528" : "\u542F\u7528"}\u89D2\u8272" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "\u505C\u7528" : "\u542F\u7528"}</button>
    <button class="btn xs danger" title="\u5220\u9664\u89D2\u8272" aria-label="\u5220\u9664\u89D2\u8272 ${esc(a.name)}" onclick="event.stopPropagation();deleteAgent(${a.id})">${icon("trash")}</button>`;
  }
  function renderAgentGrid() {
    const grid = document.getElementById("agentGrid");
    if (!grid) return;
    const { list, query } = filteredAgents();
    grid.innerHTML = list.map((a) => {
      const rc = a.role_config || {};
      const st = agentTaskStats(a);
      return `<article class="agent-card" data-agent-id="${a.id}" tabindex="0" onclick="openAgentDetail(${a.id})" onkeydown="if(event.target.closest('a,button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openAgentDetail(${a.id})}">
      <div class="ac-top">
        <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <a class="ac-name card-primary-action" href="#/agent/${a.id}" onclick="event.stopPropagation()">${esc(a.name)}</a>
          <div class="ac-sub">${esc(a.description || "\u672A\u8BBE\u7F6E\u63CF\u8FF0")}</div>
        </div>
        <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span>
      </div>
      <div class="ac-meta">
        <span class="chip">${esc(a.cli)}</span>
        <span class="chip" title="${esc(rc.model || "\u9ED8\u8BA4\u6A21\u578B")}">${esc(rc.model || "\u9ED8\u8BA4\u6A21\u578B")}</span>
        <span class="chip" title="\u540C\u4E00\u89D2\u8272\u6700\u591A\u540C\u65F6\u8FD0\u884C\u7684\u4EFB\u52A1\u6570">\u5E76\u53D1 ${esc(String(a.max_concurrency || 1))}</span>
      </div>
      <div class="ac-stats">
        <span><b>${st.total}</b> \u4EFB\u52A1</span>
        <span><b style="color:var(--st-running)">${st.inFlight}</b> \u8FDB\u884C\u4E2D</span>
        <span><b style="color:var(--st-review)">${st.review}</b> \u5F85\u5BA1\u6279</span>
      </div>
      <div class="ac-ops">${agentActionsHTML(a)}</div>
    </article>`;
    }).join("");
    renderAgentEmpty(list, query);
    const cnt = document.getElementById("agentCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u89D2\u8272`;
  }
  function renderAgentTable() {
    const body = document.getElementById("agentList");
    if (!body) return;
    const { list, query } = filteredAgents();
    body.innerHTML = list.map((a) => {
      const rc = a.role_config || {};
      return `<tr class="agent-list-row" tabindex="0" onclick="openAgentDetail(${a.id})" onkeydown="if(event.target.closest('a,button'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openAgentDetail(${a.id})}">
      <td class="agent-list-identity">
        <span class="agent-list-main">
          <span class="avatar av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
          <span class="agent-list-copy">
            <a class="table-primary-action" href="#/agent/${a.id}" onclick="event.stopPropagation()">${esc(a.name)}</a>
            <span class="agent-list-description">${esc(a.description || "\u672A\u8BBE\u7F6E\u63CF\u8FF0")}</span>
          </span>
        </span>
      </td>
      <td class="agent-list-cli" data-label="CLI"><span class="badge">${esc(a.cli)}</span></td>
      <td class="agent-list-model" data-label="\u6A21\u578B">${esc(rc.model || "\u9ED8\u8BA4")}</td>
      <td class="agent-list-concurrency num" data-label="\u6700\u5927\u5E76\u53D1">${esc(String(a.max_concurrency || 1))}</td>
      <td class="agent-list-status" data-label="\u72B6\u6001"><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span></td>
      <td class="agent-list-actions" data-label="\u64CD\u4F5C">
        <span class="ops">${agentActionsHTML(a)}</span>
      </td>
    </tr>`;
    }).join("");
    renderAgentEmpty(list, query);
    const cnt = document.getElementById("agentCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u89D2\u8272`;
  }
  function renderAgentList() {
    state.agentView === "grid" ? renderAgentGrid() : renderAgentTable();
  }
  async function refreshAgentCatalog() {
    const btn = document.getElementById("refreshAgentCatalog");
    const original = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "\u68C0\u6D4B\u4E2D\u2026";
    }
    try {
      await loadSchema(true);
      toast("\u5DF2\u4ECE Linux \u4E3B\u673A\u5237\u65B0\u6A21\u578B\u4E0E\u80FD\u529B\u76EE\u5F55");
    } catch (e) {
      toast("\u5237\u65B0\u4E3B\u673A\u80FD\u529B\u5931\u8D25\uFF1A" + e.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    }
  }
  async function toggleAgent(id) {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return;
    try {
      await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
      await loadAll();
      renderAgentList();
    } catch (e) {
      toast(e.message, true);
    }
  }
  function openAgentDetail(id) {
    location.hash = "#/agent/" + id;
  }
  function closeAgentDetail() {
    location.hash = "#/";
  }
  function showAgentDetail(id) {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return;
    state.agentEditing = a;
    document.getElementById("agentListShell").classList.add("hidden");
    document.getElementById("agentDetailShell").classList.remove("hidden");
    document.getElementById("adCrumb").innerHTML = `\u89D2\u8272 / <b>${esc(a.name)}</b>`;
    const docs = state.schema[a.cli]?.docs;
    document.getElementById("adCliDocs").innerHTML = `<span class="badge">${esc(a.cli)}</span> ${docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(docs)}">\u5B98\u65B9\u6587\u6863 \u2197</a>` : ""}`;
    agentTab("overview");
  }
  function hideAgentDetail() {
    document.getElementById("agentDetailShell").classList.add("hidden");
    document.getElementById("agentListShell").classList.remove("hidden");
    state.agentEditing = null;
  }
  function agentTab(name) {
    if (name !== "overview" && name !== "stats") name = "overview";
    state.agentTab = name;
    document.querySelectorAll("#agentTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    const a = state.agentEditing;
    if (!a) return;
    const form = document.getElementById("agentForm");
    if (name === "overview") renderAgentOverview(a);
    else if (name === "stats") renderAgentStats(a);
  }
  async function loadAgentStats(a) {
    if (!state.agentStats[a.id]) {
      try {
        state.agentStats[a.id] = await api(`/api/stats/agent/${a.id}`);
      } catch (_) {
      }
    }
    return state.agentStats[a.id];
  }
  async function renderAgentOverview(a) {
    const form = document.getElementById("agentForm");
    if (!form) return;
    const st = await loadAgentStats(a);
    if (state.agentTab !== "overview") return;
    form.innerHTML = `
    <div class="agent-hero">
      <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
      <div>
        <div class="ah-name">${esc(a.name)} <span class="badge">${esc(a.cli)}</span>
          <span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span></div>
        ${a.description ? `<div class="ah-desc">${esc(a.description)}</div>` : ""}
        <div class="ah-sub">\u6267\u884C\u6C60\uFF1A
          <input id="aMaxConc" class="conc-input" type="number" min="1" step="1" inputmode="numeric"
            value="${esc(String(a.max_concurrency || 1))}" aria-label="\u6700\u5927\u5E76\u53D1"
            onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();saveAgentConcurrency()}">
          \u4E2A\u4EFB\u52A1
          <button class="btn xs primary" onclick="saveAgentConcurrency()">\u66F4\u65B0\u5E76\u53D1</button>
          <span class="count-info">\u540C\u65F6\u6700\u591A\u8FD0\u884C\u7684\u4EFB\u52A1\u6570\uFF0C\u6BCF\u4E2A\u4EFB\u52A1\u72EC\u5360 tmux/\u4F1A\u8BDD/Git worktree</span>
        </div>
      </div>
    </div>
    ${st ? `
      <div class="pd-stats">
        <div class="pd-chips">
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-running)"></span><b>${st.in_flight}</b><span>\u8FDB\u884C\u4E2D</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${st.succeeded}</b><span>\u5B8C\u6210</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-failed)"></span><b>${st.failed}</b><span>\u5931\u8D25</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-cancel)"></span><b>${st.cancelled}</b><span>\u53D6\u6D88</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--st-done)"></span><b>${fmtPct(st.success_rate)}</b><span>\u6210\u529F\u7387</span></div>
          <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${fmtDur(st.avg_duration)}</b><span>\u5E73\u5747\u8017\u65F6</span></div>
        </div>
      </div>
      <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
      ${dailyChartHTML(st.daily, 14)}
      ${st.projects && st.projects.length ? `
        <div class="sec-title">\u5206\u9879\u76EE\u4EA7\u51FA</div>
        <div class="list-wrap" style="max-height:260px">
          <table class="list-grid">
            <thead><tr><th>\u9879\u76EE</th><th>\u4EFB\u52A1</th><th>\u5B8C\u6210</th><th>\u5931\u8D25</th><th>\u5BA1\u6279\u8F6E\u6B21</th><th>\u6210\u529F\u7387</th><th>\u5E73\u5747\u8017\u65F6</th></tr></thead>
            <tbody>${st.projects.map((ps) => `
              <tr ${ps.project_id > 0 ? `onclick="openProject(${ps.project_id})"` : ""}>
                <td><a class="t-link" href="/projects#/project/${ps.project_id}">${esc(ps.project_name || "\u672A\u547D\u540D")}</a></td>
                <td class="num">${ps.total}</td>
                <td class="num" style="color:var(--success)">${ps.succeeded}</td>
                <td class="num" style="color:var(--danger)">${ps.failed}</td>
                <td class="num">${ps.reviews || 0}</td>
                <td class="num">${fmtPct(ps.success_rate)}</td>
                <td class="num">${fmtDur(ps.avg_duration)}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>` : ""}
    ` : `<div class="empty">\u6682\u65E0\u7EDF\u8BA1</div>`}
    <div class="sec-title">\u6700\u8FD1\u4EFB\u52A1</div>
    <div id="agentRecent"></div>`;
    try {
      const recent = await api(`/api/tasks?agent_id=${a.id}&limit=8`);
      const box = document.getElementById("agentRecent");
      if (box) {
        box.innerHTML = recent.map((t) => `
        <div class="p-task-row" onclick="openTask(${t.id})">
          <span class="num">#${t.id}</span>
          <a class="t card-primary-action" href="#/issue/${t.id}" onclick="event.stopPropagation();openTask(${t.id});return false">${esc(t.title)}</a>
          <span class="a">${esc(t.project_name || "-")}</span>
          <span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>
        </div>`).join("") || `<div class="empty">\u8FD8\u6CA1\u6709\u4EFB\u52A1</div>`;
      }
    } catch (_) {
    }
  }
  async function renderAgentStats(a) {
    const form = document.getElementById("agentForm");
    if (!form) return;
    form.innerHTML = `<div class="empty">\u52A0\u8F7D\u7EDF\u8BA1\u4E2D...</div>`;
    const st = await loadAgentStats(a);
    if (state.agentTab !== "stats") return;
    if (!st) {
      form.innerHTML = `<div class="empty">\u7EDF\u8BA1\u4E0D\u53EF\u7528</div>`;
      return;
    }
    form.innerHTML = `
    <div class="sec-title">\u72B6\u6001\u5206\u5E03\uFF08${st.total} \u4E2A\u4EFB\u52A1\uFF09</div>
    <div class="sb-wrap">${statusBarHTML(st.status_counts)}
      <div class="sb-legend">
        ${(st.status_counts || []).map((c) => `<span class="sb-item"><i style="background:${ST_COLOR[c.status]}"></i>${STATUS_LABEL[c.status]} ${c.count}</span>`).join("")}
      </div></div>
    <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
    ${dailyChartHTML(st.daily, 14)}
    <div class="sec-title">\u5206\u9879\u76EE\u4EA7\u51FA\uFF08\u7EF4\u5EA6\u4E8C\uFF1Aagent \u7EDF\u8BA1\uFF09</div>
    <div class="list-wrap">
      <table class="list-grid">
        <thead><tr><th>\u9879\u76EE</th><th>\u4EFB\u52A1</th><th>\u5B8C\u6210</th><th>\u5931\u8D25</th><th>\u5BA1\u6279\u8F6E\u6B21</th><th>\u6210\u529F\u7387</th><th>\u5E73\u5747\u8017\u65F6</th></tr></thead>
        <tbody>${(st.projects || []).map((ps) => `
          <tr>
            <td><a class="t-link" href="/projects#/project/${ps.project_id}">${esc(ps.project_name || "\u672A\u547D\u540D")}</a></td>
            <td class="num">${ps.total}</td>
            <td class="num" style="color:var(--success)">${ps.succeeded}</td>
            <td class="num" style="color:var(--danger)">${ps.failed}</td>
            <td class="num">${ps.reviews || 0}</td>
            <td class="num">${fmtPct(ps.success_rate)}</td>
            <td class="num">${fmtDur(ps.avg_duration)}</td>
          </tr>`).join("") || `<tr><td colspan="7"><div class="empty">\u6682\u65E0\u4EA7\u51FA</div></td></tr>`}</tbody>
      </table>
    </div>`;
  }
  function fieldValue(f, rc) {
    if (f.builtin) {
      const v = rc[f.key];
      if (f.type === "list") return Array.isArray(v) ? (v || []).join(",") : v ?? "";
      if (f.type === "env") return Object.entries(v || {}).map(([k, val]) => `${k}=${val}`).join("\n");
      if (Array.isArray(v)) return (v || []).join(" ");
      return v ?? f.default ?? "";
    }
    return rc.custom && rc.custom[f.key] != null ? rc.custom[f.key] : f.default ?? "";
  }
  function chipHTML(key, p) {
    return `<span class="chip-item" data-v="${esc(p)}"><span class="ci-text">${esc(p)}</span><button type="button" class="chip-x" onclick="removeChip('${key}', this)" aria-label="\u79FB\u9664">\xD7</button></span>`;
  }
  function chipEditorValue(el) {
    const box = el.closest(".chip-editor");
    return { box, hidden: box.querySelector('input[type="hidden"]') };
  }
  function syncChips(box, key) {
    const h = box.querySelector('input[type="hidden"]');
    const items = h.value ? h.value.split(",") : [];
    const row = box.querySelector(".chips");
    if (row) row.innerHTML = items.map((p) => chipHTML(key, p)).join("");
    if (box.querySelector(".skill-opts")) {
      box.querySelectorAll(".skill-opts input[type=checkbox]").forEach((cb) => cb.checked = items.includes(cb.dataset.v));
    }
  }
  function addChip(key, input) {
    const v = (input.value || "").trim();
    if (!v) return;
    const { box, hidden } = chipEditorValue(input);
    const items = hidden.value ? hidden.value.split(",") : [];
    if (!items.includes(v)) {
      items.push(v);
      hidden.value = items.join(",");
    }
    syncChips(box, key);
    input.value = "";
    input.focus();
  }
  function removeChip(key, btn) {
    const chip = btn.closest(".chip-item");
    if (!chip) return;
    const { box, hidden } = chipEditorValue(btn);
    const items = hidden.value ? hidden.value.split(",") : [];
    const i = items.indexOf(chip.dataset.v);
    if (i >= 0) items.splice(i, 1);
    hidden.value = items.join(",");
    syncChips(box, key);
  }
  function toggleSkill(key, cb) {
    const { box, hidden } = chipEditorValue(cb);
    const items = hidden.value ? hidden.value.split(",") : [];
    const v = cb.dataset.v;
    if (cb.checked) {
      if (!items.includes(v)) items.push(v);
    } else {
      const i = items.indexOf(v);
      if (i >= 0) items.splice(i, 1);
    }
    hidden.value = items.join(",");
    syncChips(box, key);
  }
  function filterSkillOptions(control) {
    const box = control?.closest?.(".chip-editor");
    if (!box) return;
    const tag = box.querySelector("[data-skill-tag-filter]")?.value || "";
    const query = (box.querySelector("[data-skill-search]")?.value || "").trim().toLocaleLowerCase();
    box.querySelectorAll(".skill-opt").forEach((option) => {
      const tags = (option.dataset.tags || "").split("|").filter(Boolean);
      const text = option.dataset.search || "";
      const matchesTag = !tag || (tag === "__untagged__" ? tags.length === 0 : tags.includes(tag.toLocaleLowerCase()));
      option.hidden = !matchesTag || !!query && !text.includes(query);
    });
  }
  function skillsControlHTML(f, val) {
    const items = val ? String(val).split(",").map((s) => s.trim()).filter(Boolean) : [];
    const lib = state.skillLib || [];
    const tagMap = /* @__PURE__ */ new Map();
    lib.forEach((s) => (Array.isArray(s.tags) ? s.tags : []).forEach((tag) => {
      const key = String(tag).trim().toLocaleLowerCase();
      if (key && !tagMap.has(key)) tagMap.set(key, String(tag).trim());
    }));
    const tagOptions = [...tagMap.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join("");
    const hasUntagged = lib.some((s) => !(Array.isArray(s.tags) && s.tags.length));
    const opts = lib.map((s) => {
      const on = items.includes(s.dir);
      const rawTags = (Array.isArray(s.tags) ? s.tags : []).map(String).map((tag) => tag.trim()).filter(Boolean);
      const tags = rawTags.map((tag) => tag.toLocaleLowerCase());
      const search = [s.name, s.description, ...rawTags].join(" ").toLocaleLowerCase();
      return `<label class="skill-opt" data-tags="${esc(tags.join("|"))}" data-search="${esc(search)}"><input type="checkbox" data-v="${esc(s.dir)}" ${on ? "checked" : ""} onchange="toggleSkill('${f.key}', this)"><span class="skill-opt-copy" title="${esc(s.description || s.dir)}"><span class="skill-opt-name">${esc(s.name)}</span>${rawTags.length ? `<small>${rawTags.map((tag) => esc(tag)).join(" \xB7 ")}</small>` : `<small>\u672A\u5206\u7C7B</small>`}</span></label>`;
    }).join("");
    return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map((p) => chipHTML(f.key, p)).join("")}</div>
    <div class="skill-filter-row">
      <label>\u6309\u6807\u7B7E
        <select data-skill-tag-filter onchange="filterSkillOptions(this)">
          <option value="">\u5168\u90E8\u6807\u7B7E</option>${tagOptions}${hasUntagged ? `<option value="__untagged__">\u672A\u5206\u7C7B</option>` : ""}
        </select>
      </label>
      <input data-skill-search placeholder="\u641C\u7D22\u6280\u80FD\u540D\u79F0\u6216\u8BF4\u660E" oninput="filterSkillOptions(this)">
    </div>
    <div class="skill-opts">${opts || `<div class="empty">\u6280\u80FD\u5E93\u4E3A\u7A7A\uFF1A\u5230 Skills \u9875\u6DFB\u52A0\u6280\u80FD\uFF08\u542B SKILL.md \u7684\u76EE\u5F55\uFF09</div>`}</div>
    <div class="chip-add">
      <input placeholder="\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84\uFF0C\u56DE\u8F66\u6DFB\u52A0" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f.key}', this.previousElementSibling)">\u6DFB\u52A0</button>
    </div>
  </div>`;
  }
  function chipsControlHTML(f, val) {
    const items = val ? String(val).split(",").map((s) => s.trim()).filter(Boolean) : [];
    return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map((p) => chipHTML(f.key, p)).join("")}</div>
    <div class="chip-add">
      <input placeholder="${esc(f.placeholder || "\u56DE\u8F66\u6DFB\u52A0")}" onkeydown="if(event.key==='Enter'){event.preventDefault();addChip('${f.key}', this)}">
      <button type="button" class="btn xs" onclick="addChip('${f.key}', this.previousElementSibling)">\u6DFB\u52A0</button>
    </div>
  </div>`;
  }
  function selectOptionsHTML(options, val) {
    const current = String(val ?? "");
    const values = Array.isArray(options) ? options.map(String) : [];
    const legacy = current !== "" && !values.includes(current);
    if (legacy) values.push(current);
    return values.map((o) => {
      const label = o === "" ? "\u9ED8\u8BA4" : legacy && o === current ? `${o}\uFF08\u5F53\u524D\u4FDD\u5B58\u503C\uFF09` : o;
      return `<option value="${esc(o)}" ${current === o ? "selected" : ""}>${esc(label)}</option>`;
    }).join("");
  }
  function syncModelThinking(input) {
    const scope = input.closest("#rsSchema");
    const select = scope && scope.querySelector('select[data-key="thinking"][data-thinking-options]');
    if (!select) return;
    let byModel = {}, fallback = [];
    try {
      byModel = JSON.parse(select.dataset.thinkingOptions || "{}");
    } catch (_) {
    }
    try {
      fallback = JSON.parse(select.dataset.fallbackOptions || "[]");
    } catch (_) {
    }
    const model = String(input.value || "").trim();
    const hasModel = Object.prototype.hasOwnProperty.call(byModel, model);
    let options = hasModel && Array.isArray(byModel[model]) ? byModel[model] : fallback;
    if (hasModel && Array.isArray(fallback) && fallback.includes("") && !options.includes("")) options = ["", ...options];
    const current = select.value;
    const next = Array.isArray(options) && options.map(String).includes(current) ? current : "";
    select.innerHTML = selectOptionsHTML(options, next);
  }
  function fieldControlHTML(f, rc, selectedModel = "") {
    const val = fieldValue(f, rc);
    let attrs = `data-key="${f.key}" data-type="${f.type}"`;
    const hasModelThinking = f.key === "thinking" && f.thinking_options_by_model;
    if (hasModelThinking) {
      attrs += ` data-thinking-options="${esc(JSON.stringify(f.thinking_options_by_model))}"`;
      let fallbackOptions = f.options || [];
      if (Array.isArray(f.thinking_options_by_model[""])) {
        fallbackOptions = f.thinking_options_by_model[""];
        if (Array.isArray(f.options) && f.options.includes("") && !fallbackOptions.includes("")) {
          fallbackOptions = ["", ...fallbackOptions];
        }
      }
      attrs += ` data-fallback-options="${esc(JSON.stringify(fallbackOptions))}"`;
    }
    let ctl = "";
    if (f.type === "select") {
      let options = f.options || [];
      if (hasModelThinking && Array.isArray(f.thinking_options_by_model[selectedModel])) {
        options = f.thinking_options_by_model[selectedModel];
        if ((f.options || []).includes("") && !options.includes("")) options = ["", ...options];
      }
      ctl = `<select ${attrs}>${selectOptionsHTML(options, val)}</select>`;
    } else if (f.type === "textarea") {
      ctl = `<textarea ${attrs} rows="5" placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`;
    } else if (f.type === "env") {
      ctl = `<textarea ${attrs} rows="6" placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`;
    } else if (f.type === "list" && f.source === "skills") {
      ctl = skillsControlHTML(f, val);
    } else if (f.type === "list") {
      ctl = chipsControlHTML(f, val);
    } else if (f.suggestions && f.suggestions.length) {
      const dl = "dl_" + ++dlSeq;
      const sync = f.key === "model" ? ` oninput="syncModelThinking(this)" onchange="syncModelThinking(this)"` : "";
      ctl = `<input ${attrs} list="${dl}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}"${sync}><datalist id="${dl}">${f.suggestions.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>`;
    } else {
      const sync = f.key === "model" ? ` oninput="syncModelThinking(this)" onchange="syncModelThinking(this)"` : "";
      ctl = `<input ${attrs} value="${esc(val)}" placeholder="${esc(f.placeholder || "")}"${sync}>`;
    }
    return `<div class="schema-field">
    <label class="field">${esc(f.label)}${ctl}</label>
    ${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ""}
  </div>`;
  }
  function schemaFormHTML(schema, rc) {
    const groups = {};
    const fields = schema.fields || [];
    const model = fields.find((f) => f.key === "model");
    const selectedModel = model ? String(fieldValue(model, rc) || "") : "";
    fields.forEach((f) => {
      (groups[f.group] = groups[f.group] || []).push(f);
    });
    return Object.entries(groups).map(([g, fs]) => `
    <div class="schema-group">
      <div class="schema-group-title">${esc(g)}</div>
      <div class="schema-group-body">${fs.map((f) => fieldControlHTML(f, rc, selectedModel)).join("")}</div>
    </div>`).join("");
  }
  function readConfigFrom(schema, container) {
    const cfg = { custom: {} };
    (schema.fields || []).forEach((f) => {
      const el = container.querySelector(`[data-key="${f.key}"]`);
      if (!el) return;
      const val = el.value;
      if (f.type === "env") {
        if (f.builtin) cfg.env = parseEnv(val);
        else cfg.custom[f.key] = val;
        return;
      }
      if (f.type === "list") {
        const arr = val.split(",").map((s) => s.trim()).filter(Boolean);
        if (f.builtin) cfg[f.key] = arr;
        else cfg.custom[f.key] = arr.join(",");
        return;
      }
      if (f.builtin && f.key === "extra_args") {
        cfg.extra_args = val.split(/\s+/).filter(Boolean);
        return;
      }
      if (f.builtin) cfg[f.key] = val;
      else cfg.custom[f.key] = val;
    });
    return cfg;
  }
  async function saveAgentConcurrency() {
    const a = state.agentEditing;
    if (!a) return;
    const n = Number(document.getElementById("aMaxConc")?.value);
    if (!Number.isInteger(n) || n < 1) return toast("\u6700\u5927\u5E76\u53D1\u5FC5\u987B\u662F\u81F3\u5C11\u4E3A 1 \u7684\u6574\u6570", true);
    if (n === (a.max_concurrency || 1)) return;
    try {
      await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ max_concurrency: n }) });
      toast(`\u5E76\u53D1\u5DF2\u66F4\u65B0\u4E3A ${n}`);
      await loadAll();
      showAgentDetail(a.id);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function deleteAgent(id) {
    if (!id) id = state.agentEditing?.id;
    if (!id) return;
    if (!confirm("\u5220\u9664\u8BE5\u89D2\u8272\uFF1F\u672A\u5B8C\u6210\u4EFB\u52A1\u5C06\u5931\u53BB\u6307\u6D3E\uFF0C\u5386\u53F2\u4EFB\u52A1\u4FDD\u7559\u3002")) return;
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      await loadAll();
      renderAgentList();
      if (state.agentEditing && state.agentEditing.id === id) closeAgentDetail();
      toast("\u5DF2\u5220\u9664");
    } catch (e) {
      toast(e.message, true);
    }
  }
  function parseEnv(text) {
    const env = {};
    text.split("\n").forEach((line) => {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return env;
  }

  // internal/web/static/src/provision.js
  var provState = { prov: [], instCli: null };
  async function loadProvision() {
    try {
      provState.prov = await api("/api/provision");
    } catch (_) {
      provState.prov = [];
    }
    renderProvGrid();
  }
  function renderProvGrid() {
    const grid = document.getElementById("provGrid");
    if (!grid) return;
    const empty = document.getElementById("provEmpty");
    if (empty) empty.classList.add("hidden");
    grid.innerHTML = provState.prov.map((p) => `
    <div class="prov-card ${p.installed ? "" : "not-installed"}">
      <div class="pc-top">
        <span class="avatar lg av-${esc(p.id)}">${esc((p.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(p.name)}</div>
          <div class="ac-sub">
            ${p.installed ? `<span class="badge succeeded">\u5DF2\u5B89\u88C5</span>` : `<span class="badge cancelled">\u672A\u5B89\u88C5</span>`}
            ${p.installed ? `<span class="badge ${p.login ? "succeeded" : "awaiting_review"}">${p.login ? "\u5DF2\u767B\u5F55" : "\u672A\u767B\u5F55"}</span>` : ""}
          </div>
        </div>
        ${p.installed ? `<span class="prov-ver">${esc(p.version)}</span>` : ""}
      </div>
      <div class="prov-body">
        ${!p.installed ? `<div class="prov-cmd" title="\u5B98\u65B9\u5B89\u88C5\u547D\u4EE4">$ ${esc(p.install_cmd || "\uFF08\u8BF7\u53C2\u8003\u5B98\u65B9\u6587\u6863\uFF09")}</div>` : p.login ? `<div class="prov-login-ok">\u5DF2\u68C0\u6D4B\u5230\u767B\u5F55\u51ED\u636E \u2713</div>` : `<div class="prov-login-hint">${esc(p.login_hint || "\u8BF7\u5728\u670D\u52A1\u5668\u7EC8\u7AEF\u5B8C\u6210\u767B\u5F55")}</div>`}
      </div>
      <div class="ac-stats prov-actions">
        ${!p.installed ? `<button class="btn sm brand" onclick="installProvision('${p.id}')">\u5B89\u88C5</button>` : `<button class="btn sm" onclick="installProvision('${p.id}')">\u91CD\u88C5/\u66F4\u65B0</button>`}
        <a class="btn sm ghost" href="${esc(p.docs)}" target="_blank" rel="noreferrer">\u5B98\u65B9\u6587\u6863 \u2197</a>
        ${p.installed ? `<button class="btn sm" onclick="copyText('${esc(p.login_hint || "")}')">\u590D\u5236\u767B\u5F55\u6307\u5F15</button>` : ""}
        ${p.installed ? `<button class="btn sm" onclick="createDefaultRole('${p.id}')">\u521B\u5EFA\u9ED8\u8BA4\u89D2\u8272</button>` : ""}
      </div>
    </div>`).join("");
    const cnt = document.getElementById("provCount");
    if (cnt) cnt.textContent = `\u5DF2\u5B89\u88C5 ${provState.prov.filter((p) => p.installed).length}/${provState.prov.length}`;
  }
  async function installProvision(cli) {
    provState.instCli = cli;
    const box = document.getElementById("instBox");
    const title = document.getElementById("instTitle");
    box.innerHTML = `<div class="empty">\u6B63\u5728\u542F\u52A8\u5B89\u88C5...</div>`;
    title.textContent = `\u5B89\u88C5 ${cli}`;
    openModal("instModal");
    try {
      const r = await api("/api/provision/install", { method: "POST", body: JSON.stringify({ cli }) });
      setTimeout(loadProvision, 3e3);
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      provState.instCli = null;
    }
  }
  function appendInstLine(line) {
    const box = document.getElementById("instBox");
    if (!box) return;
    const c = line.startsWith("$") ? "sys" : "out";
    box.insertAdjacentHTML("beforeend", `<div class="line"><span class="c ${c}">${esc(line)}</span></div>`);
    box.scrollTop = box.scrollHeight;
  }
  function closeInstTerminal() {
    provState.instCli = null;
    closeModal("instModal");
  }
  function refreshProvision() {
    loadProvision();
  }
  function copyText(t) {
    navigator.clipboard.writeText(t).then(() => toast("\u5DF2\u590D\u5236")).catch(() => toast("\u590D\u5236\u5931\u8D25", true));
  }
  async function createDefaultRole(cli) {
    const name = prompt(`\u521B\u5EFA\u57FA\u4E8E ${cli} \u7684\u9ED8\u8BA4\u89D2\u8272\u540D\u79F0`, cli);
    if (!name) return;
    try {
      await api("/api/agents", { method: "POST", body: JSON.stringify({ name, cli, enabled: true }) });
      toast("\u5DF2\u521B\u5EFA\u89D2\u8272\uFF0C\u53EF\u5728\u89D2\u8272\u9875\u7EE7\u7EED\u5B9A\u5236");
    } catch (e) {
      toast(e.message, true);
    }
  }

  // internal/web/static/src/role_studio.js
  function clone(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
  }
  function firstEnabledAgent(excludeID = 0) {
    return state.agents.find((a) => a.enabled && a.id !== excludeID) || state.agents.find((a) => a.enabled) || state.agents[0] || null;
  }
  function blankDraft() {
    const cli = Object.keys(state.schema || {})[0] || state.agents[0]?.cli || "";
    return { name: "", description: "", cli, max_concurrency: 1, role_config: {} };
  }
  function draftFromAgent(agent) {
    return {
      name: agent?.name || "",
      description: agent?.description || "",
      cli: agent?.cli || Object.keys(state.schema || {})[0] || "",
      max_concurrency: agent?.max_concurrency || 1,
      role_config: clone(agent?.role_config || {})
    };
  }
  function nextRoleCopyName(agent) {
    const source = String(agent?.name || "\u672A\u547D\u540D\u89D2\u8272").trim() || "\u672A\u547D\u540D\u89D2\u8272";
    const base = `${source}\uFF08\u526F\u672C\uFF09`;
    const names = new Set(state.agents.map((a) => String(a.name || "").trim()));
    if (!names.has(base)) return base;
    for (let n = 2; n < 1e4; n++) {
      const candidate = `${source}\uFF08\u526F\u672C ${n}\uFF09`;
      if (!names.has(candidate)) return candidate;
    }
    return `${source}\uFF08\u526F\u672C ${Date.now()}\uFF09`;
  }
  function createStudioState({ draft, agentID = 0, agentEnabled = true, excludeAgentID = 0, mode = "create", sourceAgentName = "" }) {
    const creator = firstEnabledAgent(excludeAgentID);
    return {
      agentID,
      agentEnabled,
      creatorAgentID: creator?.id || 0,
      draft,
      baseDraft: clone(draft),
      creatorMessages: [],
      testMessages: [],
      busy: false,
      testBusy: false,
      mode,
      sourceAgentName
    };
  }
  function studioState() {
    return state.roleStudio;
  }
  function currentDraftFromForm() {
    const s = studioState();
    if (!s) return null;
    const draft = clone(s.draft);
    draft.name = String(document.getElementById("rsName")?.value || "").trim();
    draft.description = String(document.getElementById("rsDescription")?.value || "").trim();
    draft.cli = String(document.getElementById("rsCli")?.value || draft.cli || "");
    draft.max_concurrency = Number(document.getElementById("rsMaxConcurrency")?.value || 1);
    const schema = state.schema[draft.cli];
    const form = document.getElementById("rsSchema");
    draft.role_config = schema && form ? readConfigFrom(schema, form) : clone(draft.role_config || {});
    if (!Number.isInteger(draft.max_concurrency) || draft.max_concurrency < 1) draft.max_concurrency = 1;
    return draft;
  }
  function roleStudioMessageHTML(message) {
    const role = message.role === "user" ? "user" : "assistant";
    return `<article class="rs-message ${role}">
    <div class="rs-message-label">${role === "user" ? "\u4F60" : "\u521B\u5EFA\u52A9\u624B"}</div>
    <div class="rs-message-body">${esc(message.content || "").replace(/\n/g, "<br>")}</div>
  </article>`;
  }
  function testMessageHTML(message) {
    const role = message.role === "user" ? "user" : "assistant";
    return `<article class="rs-message ${role}">
    <div class="rs-message-label">${role === "user" ? "\u6D4B\u8BD5\u8F93\u5165" : "\u88AB\u521B\u5EFA Agent"}</div>
    <div class="rs-message-body">${esc(message.content || "").replace(/\n/g, "<br>")}</div>
  </article>`;
  }
  function renderStudioMessages() {
    const s = studioState();
    if (!s) return;
    const creator = document.getElementById("rsCreatorChat");
    const test = document.getElementById("rsTestChat");
    if (creator) {
      creator.innerHTML = s.creatorMessages.length ? s.creatorMessages.map(roleStudioMessageHTML).join("") : `<div class="rs-chat-empty"><span class="rs-empty-mark">\u2726</span><b>\u63CF\u8FF0\u4F60\u60F3\u521B\u5EFA\u7684\u89D2\u8272</b><span>\u521B\u5EFA\u52A9\u624B\u4F1A\u5206\u6790\u76EE\u6807\u3001\u63A8\u8350 Skills\uFF0C\u5E76\u628A\u53EF\u6D4B\u8BD5\u7684\u914D\u7F6E\u653E\u5230\u4E2D\u95F4\u3002</span></div>`;
      creator.scrollTop = creator.scrollHeight;
    }
    if (test) {
      test.innerHTML = s.testMessages.length ? s.testMessages.map(testMessageHTML).join("") : `<div class="rs-chat-empty"><span class="rs-empty-mark">\u25CC</span><b>\u5148\u7ED9\u89D2\u8272\u4E00\u4E2A\u5C0F\u4EFB\u52A1</b><span>\u6D4B\u8BD5\u7ED3\u679C\u4F1A\u4FDD\u7559\u5728\u8FD9\u91CC\uFF0C\u521B\u5EFA\u52A9\u624B\u53EF\u4EE5\u8BFB\u53D6\u5E76\u7EE7\u7EED\u8C03\u6574\u8349\u7A3F\u3002</span></div>`;
      test.scrollTop = test.scrollHeight;
    }
  }
  function renderCreatorSelect() {
    const s = studioState();
    const select = document.getElementById("rsCreatorAgent");
    if (!s || !select) return;
    const candidates = state.agents.filter((a) => a.enabled || a.id === s.creatorAgentID);
    select.innerHTML = candidates.length ? candidates.map((a) => `<option value="${a.id}" ${a.id === s.creatorAgentID ? "selected" : ""}>${esc(a.name)} \xB7 ${esc(a.cli)}</option>`).join("") : `<option value="">\u6682\u65E0\u53EF\u7528\u89D2\u8272</option>`;
    select.disabled = !candidates.length;
    select.onchange = () => {
      s.creatorAgentID = Number(select.value) || 0;
    };
  }
  function renderStudioDiff() {
    const s = studioState();
    const box = document.getElementById("rsDiffBody");
    if (!s || !box) return;
    const now = JSON.stringify(s.draft);
    const base = JSON.stringify(s.baseDraft);
    if (now === base) {
      box.innerHTML = `<span class="rs-diff-empty">\u5C1A\u672A\u4FEE\u6539</span>`;
      return;
    }
    const rows = [];
    const fields = [
      ["name", "\u540D\u79F0"],
      ["description", "\u63CF\u8FF0"],
      ["cli", "CLI"],
      ["max_concurrency", "\u6700\u5927\u5E76\u53D1"]
    ];
    fields.forEach(([key, label]) => {
      const before = s.baseDraft?.[key] ?? "";
      const after = s.draft?.[key] ?? "";
      if (String(before) !== String(after)) rows.push(`<div><b>${label}</b><span class="old">${esc(String(before || "\u672A\u8BBE\u7F6E"))}</span><span class="arrow">\u2192</span><span class="new">${esc(String(after || "\u672A\u8BBE\u7F6E"))}</span></div>`);
    });
    const oldCfg = s.baseDraft?.role_config || {};
    const newCfg = s.draft?.role_config || {};
    ["model", "system_prompt", "instructions", "thinking", "skills"].forEach((key) => {
      if (JSON.stringify(oldCfg[key] ?? "") !== JSON.stringify(newCfg[key] ?? "")) {
        const oldValue = Array.isArray(oldCfg[key]) ? `${oldCfg[key].length} \u9879` : String(oldCfg[key] || "\u672A\u8BBE\u7F6E");
        const newValue = Array.isArray(newCfg[key]) ? `${newCfg[key].length} \u9879` : String(newCfg[key] || "\u672A\u8BBE\u7F6E");
        rows.push(`<div><b>${esc(key)}</b><span class="old">${esc(oldValue)}</span><span class="arrow">\u2192</span><span class="new">${esc(newValue)}</span></div>`);
      }
    });
    box.innerHTML = rows.length ? rows.join("") : `<span class="rs-diff-empty">\u914D\u7F6E\u6709\u53D8\u5316</span>`;
  }
  function renderStudioDraft() {
    const s = studioState();
    if (!s) return;
    const d = s.draft;
    const title = document.getElementById("roleStudioTitle");
    if (title) {
      title.textContent = s.mode === "copy" ? `\u590D\u5236\uFF1A${s.sourceAgentName || d.name}` : s.agentID ? `\u7F16\u8F91\uFF1A${d.name}` : "\u521B\u5EFA\u89D2\u8272";
    }
    const status = document.getElementById("roleStudioStatus");
    if (status) status.textContent = s.mode === "copy" ? "\u590D\u5236\u8349\u7A3F \xB7 \u672A\u4FDD\u5B58" : s.agentID ? "\u7F16\u8F91\u8349\u7A3F \xB7 \u672A\u53D1\u5E03" : "\u65B0\u89D2\u8272\u8349\u7A3F \xB7 \u672A\u4FDD\u5B58";
    const name = document.getElementById("rsName");
    const desc = document.getElementById("rsDescription");
    const conc = document.getElementById("rsMaxConcurrency");
    if (name) name.value = d.name || "";
    if (desc) desc.value = d.description || "";
    if (conc) conc.value = d.max_concurrency || 1;
    const cli = document.getElementById("rsCli");
    if (cli) {
      cli.innerHTML = Object.values(state.schema || {}).map((schema2) => `<option value="${esc(schema2.id)}">${esc(schema2.name)}</option>`).join("");
      cli.value = d.cli;
    }
    const schema = state.schema[d.cli];
    const schemaBox = document.getElementById("rsSchema");
    if (schemaBox) schemaBox.innerHTML = schema ? schemaFormHTML(schema, d.role_config || {}) : `<div class="empty">CLI schema \u672A\u52A0\u8F7D</div>`;
    const badge = document.getElementById("rsDraftBadge");
    if (badge) badge.textContent = JSON.stringify(s.baseDraft) === JSON.stringify(d) ? "\u672A\u4FEE\u6539" : "\u6709\u672A\u4FDD\u5B58\u4FEE\u6539";
    const skillCount = Array.isArray(d.role_config?.skills) ? d.role_config.skills.length : 0;
    const note = document.getElementById("rsSkillNote");
    if (note) note.textContent = skillCount ? `\u8FD0\u884C\u65F6\u4F1A\u542F\u7528 ${skillCount} \u4E2A\u89D2\u8272 Skills` : "\u5C1A\u672A\u9009\u62E9\u89D2\u8272 Skills";
    const meta = document.getElementById("rsTestMeta");
    if (meta) meta.innerHTML = `<span class="avatar sm av-${esc(d.cli)}">${esc((d.name || "?").slice(0, 1))}</span><span><b>${esc(d.name || "\u672A\u547D\u540D\u89D2\u8272")}</b><small>${esc(d.cli || "\u672A\u9009\u62E9 CLI")} \xB7 \u4F7F\u7528\u5F53\u524D\u8349\u7A3F\u6D4B\u8BD5</small></span>`;
    renderStudioDiff();
    renderStudioMessages();
  }
  async function openRoleStudio(id) {
    const agent = id ? state.agents.find((a) => a.id === id) : null;
    if (id && !agent) return toast("\u89D2\u8272\u4E0D\u5B58\u5728", true);
    await loadSchema();
    await loadSkillLib();
    const existing = state.roleStudio;
    if (!existing || existing.agentID !== (agent?.id || 0)) {
      const draft = agent ? draftFromAgent(agent) : blankDraft();
      state.roleStudio = createStudioState({
        draft,
        agentID: agent?.id || 0,
        agentEnabled: agent?.enabled ?? true,
        excludeAgentID: agent?.id || 0,
        mode: agent ? "edit" : "create"
      });
    }
    renderCreatorSelect();
    renderStudioDraft();
    openModal("roleStudioModal");
  }
  async function copyRole(id) {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return toast("\u89D2\u8272\u4E0D\u5B58\u5728", true);
    await loadSchema();
    await loadSkillLib();
    const draft = draftFromAgent(agent);
    draft.name = nextRoleCopyName(agent);
    state.roleStudio = createStudioState({
      draft,
      agentEnabled: true,
      excludeAgentID: agent.id,
      mode: "copy",
      sourceAgentName: agent.name
    });
    renderCreatorSelect();
    renderStudioDraft();
    openModal("roleStudioModal");
  }
  function openCurrentRoleEditor() {
    const id = state.agentEditing?.id;
    if (id) openRoleStudio(id);
  }
  function copyCurrentRole() {
    const id = state.agentEditing?.id;
    return id ? copyRole(id) : Promise.resolve();
  }
  function changeRoleStudioCli() {
    const s = studioState();
    if (!s) return;
    const current = currentDraftFromForm();
    const nextCLI = String(document.getElementById("rsCli")?.value || "");
    const oldCfg = current.role_config || {};
    current.cli = nextCLI;
    current.role_config = {
      model: oldCfg.model || "",
      system_prompt: oldCfg.system_prompt || "",
      instructions: oldCfg.instructions || "",
      skills: Array.isArray(oldCfg.skills) ? oldCfg.skills : [],
      thinking: oldCfg.thinking || "",
      plugins: Array.isArray(oldCfg.plugins) ? oldCfg.plugins : [],
      extra_args: Array.isArray(oldCfg.extra_args) ? oldCfg.extra_args : [],
      env: oldCfg.env || {},
      custom: {}
    };
    s.draft = current;
    renderStudioDraft();
  }
  function roleStudioQuickAsk(message) {
    const input = document.getElementById("rsCreatorInput");
    if (!input) return;
    input.value = message;
    sendRoleStudioChat();
  }
  async function sendRoleStudioChat(event) {
    event?.preventDefault?.();
    const s = studioState();
    const input = document.getElementById("rsCreatorInput");
    const message = String(input?.value || "").trim();
    if (!s || !message || s.busy) return;
    s.draft = currentDraftFromForm();
    const creator = state.agents.find((a) => a.id === s.creatorAgentID);
    if (!creator) return toast("\u8BF7\u5148\u521B\u5EFA\u5E76\u542F\u7528\u4E00\u4E2A\u89D2\u8272\u4F5C\u4E3A\u521B\u5EFA\u52A9\u624B", true);
    s.creatorMessages.push({ role: "user", content: message });
    if (input) input.value = "";
    s.busy = true;
    setStudioBusy("rsCreatorState", true, "\u5206\u6790\u4E2D\u2026");
    renderStudioMessages();
    try {
      const result = await api("/api/role-studio/chat", {
        method: "POST",
        body: JSON.stringify({
          creator_agent_id: s.creatorAgentID,
          draft: s.draft,
          message,
          creator_messages: s.creatorMessages.slice(0, -1),
          test_messages: s.testMessages
        })
      });
      if (result?.draft) {
        s.draft = result.draft;
        renderStudioDraft();
      }
      s.creatorMessages.push({ role: "assistant", content: result?.message || "\u521B\u5EFA\u52A9\u624B\u6CA1\u6709\u8FD4\u56DE\u8BF4\u660E\u3002" });
    } catch (e) {
      s.creatorMessages.push({ role: "assistant", content: `\u8C03\u7528\u521B\u5EFA\u52A9\u624B\u5931\u8D25\uFF1A${e.message}` });
    } finally {
      s.busy = false;
      setStudioBusy("rsCreatorState", false, "\u5F85\u547D");
      renderStudioMessages();
    }
  }
  async function sendRoleStudioTest(event) {
    event?.preventDefault?.();
    const s = studioState();
    const input = document.getElementById("rsTestInput");
    const message = String(input?.value || "").trim();
    if (!s || !message || s.testBusy) return;
    s.draft = currentDraftFromForm();
    if (!s.draft.cli) return toast("\u8BF7\u5148\u9009\u62E9\u88AB\u521B\u5EFA Agent \u7684 CLI", true);
    s.testMessages.push({ role: "user", content: message });
    if (input) input.value = "";
    s.testBusy = true;
    setStudioBusy("rsTestState", true, "\u6267\u884C\u4E2D\u2026");
    renderStudioDraft();
    try {
      const result = await api("/api/role-studio/test", {
        method: "POST",
        body: JSON.stringify({ draft: s.draft, message, test_messages: s.testMessages.slice(0, -1) })
      });
      s.testMessages.push({ role: "assistant", content: result?.output || "\u88AB\u521B\u5EFA Agent \u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9\u3002" });
    } catch (e) {
      s.testMessages.push({ role: "assistant", content: `\u6D4B\u8BD5\u6267\u884C\u5931\u8D25\uFF1A${e.message}` });
    } finally {
      s.testBusy = false;
      setStudioBusy("rsTestState", false, "\u6D4B\u8BD5\u6A21\u5F0F");
      renderStudioMessages();
    }
  }
  function setStudioBusy(id, busy, text) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      el.classList.toggle("running", busy);
    }
    ["rsCreatorInput", "rsTestInput"].forEach((inputID) => {
      const input = document.getElementById(inputID);
      if (input && (inputID === "rsCreatorInput" && id === "rsCreatorState" || inputID === "rsTestInput" && id === "rsTestState")) input.disabled = busy;
    });
  }
  async function saveRoleStudio() {
    const s = studioState();
    if (!s) return;
    const draft = currentDraftFromForm();
    if (!draft.name) return toast("\u89D2\u8272\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A", true);
    if (!draft.cli) return toast("\u8BF7\u9009\u62E9\u89D2\u8272 CLI", true);
    const body = {
      name: draft.name,
      description: draft.description,
      cli: draft.cli,
      max_concurrency: draft.max_concurrency,
      enabled: s.agentEnabled,
      role_config: draft.role_config
    };
    const save = document.querySelector("#roleStudioModal .role-studio-head-actions .primary");
    if (save) {
      save.disabled = true;
      save.textContent = "\u4FDD\u5B58\u4E2D\u2026";
    }
    try {
      const result = s.agentID ? await api(`/api/agents/${s.agentID}`, { method: "PATCH", body: JSON.stringify(body) }) : await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
      closeModal("roleStudioModal");
      state.roleStudio = null;
      await loadAll();
      const detailVisible = !document.getElementById("agentDetailShell")?.classList.contains("hidden");
      if (s.mode === "copy" && detailVisible && result?.id) {
        showAgentDetail(result.id);
        openAgentDetail(result.id);
      } else if (s.agentID && detailVisible) showAgentDetail(s.agentID);
      else {
        if (detailVisible) hideAgentDetail();
        renderAgentList();
      }
      toast(s.mode === "copy" ? `\u89D2\u8272\u526F\u672C\u5DF2\u521B\u5EFA\uFF1A${result?.name || draft.name}` : s.agentID ? "\u89D2\u8272\u8349\u7A3F\u5DF2\u4FDD\u5B58" : `\u89D2\u8272\u5DF2\u521B\u5EFA\uFF1A${result?.name || draft.name}`);
    } catch (e) {
      toast(`\u4FDD\u5B58\u89D2\u8272\u5931\u8D25\uFF1A${e.message}`, true);
    } finally {
      if (save) {
        save.disabled = false;
        save.textContent = "\u4FDD\u5B58\u89D2\u8272";
      }
    }
  }

  // internal/web/static/src/schedules.js
  function renderScheduleList() {
    const body = document.getElementById("scheduleList");
    if (!body) return;
    body.innerHTML = state.schedules.map((sc) => `
    <tr>
      <td class="t-name"><b>${esc(sc.name)}</b></td>
      <td><span class="cron-chip">${icon("clock")}${esc(scheduleLabel(sc.cron))}</span></td>
      <td>${esc(sc.agent_name || "-")}</td>
      <td>${sc.project_id ? `<span class="chip" title="\u9879\u76EE\u5B9A\u65F6\u4EFB\u52A1\uFF1A\u521B\u5EFA\u540E\u6309\u9879\u76EE\u987A\u5E8F\u6267\u884C">\u9879\u76EE \xB7 ${esc(sc.project_name || "#" + sc.project_id)}</span>${sc.block_on_failure ? `<span class="chip merge-blocked">\u5931\u8D25\u963B\u585E</span>` : ""}` : `<span class="chip">\u901A\u7528</span>`}</td>
      <td class="t-tpl">${esc(sc.title_template || "-")}</td>
      <td class="num">${esc((sc.last_run_at || "-").slice(0, 16).replace("T", " "))}</td>
      <td><label class="sw" title="${sc.enabled ? "\u505C\u7528" : "\u542F\u7528"}"><input type="checkbox" ${sc.enabled ? "checked" : ""} onchange="toggleSchedule(${sc.id})"><span class="sw-slider"></span></label></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="openScheduleModal(${sc.id})">\u7F16\u8F91</button>
          <button class="btn xs danger" onclick="deleteSchedule(${sc.id})">\u5220\u9664</button>
        </span>
      </td>
    </tr>`).join("");
    const empty = document.getElementById("scheduleEmpty");
    if (empty) empty.classList.toggle("hidden", state.schedules.length > 0);
  }
  var WEEKDAYS = ["", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D", "\u5468\u65E5"];
  var DEFAULT_TIME = "09:00";
  var scheduleOriginalCron = "";
  var scheduleUnsupported = false;
  var scheduleDirty = false;
  function parseScheduleCron(cron) {
    const raw = String(cron || "").trim().toLowerCase();
    if (raw === "@daily") return { frequency: "daily", time: "00:00" };
    if (raw === "@weekly") return { frequency: "weekly", weekday: "7", time: "00:00" };
    if (raw === "@monthly") return { frequency: "monthly", monthday: "1", time: "00:00" };
    const fields = raw.split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) return null;
    const [second, minute, hour, dom, month, dow] = fields.length === 6 ? fields : ["0", fields[0], fields[1], fields[2], fields[3], fields[4]];
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
    if (!parsed) return "\u81EA\u5B9A\u4E49\u5468\u671F";
    if (parsed.frequency === "daily") return `\u6BCF\u5929 ${parsed.time}`;
    if (parsed.frequency === "weekdays") return `\u5DE5\u4F5C\u65E5 ${parsed.time}`;
    if (parsed.frequency === "weekly") return `\u6BCF\u5468${WEEKDAYS[Number(parsed.weekday)] || ""} ${parsed.time}`;
    return `\u6BCF\u6708${parsed.monthday}\u65E5 ${parsed.time}`;
  }
  function fillScheduleDays() {
    const select = document.getElementById("sMonthday");
    if (!select || select.options.length) return;
    select.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1} \u65E5</option>`).join("");
  }
  function updateSchedulePreview() {
    const preview = document.getElementById("sSchedulePreview");
    if (!preview) return;
    if (scheduleUnsupported && !scheduleDirty) {
      preview.textContent = "\u5F53\u524D\u4EFB\u52A1\u4F7F\u7528\u4E86\u81EA\u5B9A\u4E49\u5468\u671F\uFF1B\u8C03\u6574\u4E0A\u9762\u7684\u9009\u9879\u540E\u4F1A\u8F6C\u6362\u4E3A\u5E38\u7528\u5468\u671F\u3002";
      preview.classList.add("warning");
      return;
    }
    preview.classList.remove("warning");
    preview.textContent = `\u5C06\u6309\u201C${scheduleLabel(scheduleCronFromFields())}\u201D\u6267\u884C`;
  }
  function syncScheduleFields(markDirty = true) {
    if (markDirty) scheduleDirty = true;
    const frequency = document.getElementById("sFrequency")?.value || "daily";
    document.getElementById("sWeekdayField")?.classList.toggle("hidden", frequency !== "weekly");
    document.getElementById("sMonthdayField")?.classList.toggle("hidden", frequency !== "monthly");
    updateSchedulePreview();
  }
  async function toggleSchedule(id) {
    const sc = state.schedules.find((x) => x.id === id);
    try {
      await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !sc.enabled }) });
      await loadAll();
      renderScheduleList();
    } catch (e) {
      toast(e.message, true);
    }
  }
  function openScheduleModal(id) {
    fillSelects();
    fillScheduleDays();
    const sc = id ? state.schedules.find((x) => x.id === id) : null;
    document.getElementById("scheduleModalTitle").textContent = sc ? "\u7F16\u8F91\u5B9A\u65F6\u4EFB\u52A1" : "\u65B0\u5EFA\u5B9A\u65F6\u4EFB\u52A1";
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
    document.getElementById("sPerm").value = sc ? sc.perm || "full" : "full";
    document.getElementById("sProject").value = sc && sc.project_id ? sc.project_id : "";
    document.getElementById("sBlockOnFailure").checked = !!sc?.block_on_failure;
    if (sc) document.getElementById("sAgent").value = sc.agent_id;
    openModal("scheduleModal");
  }
  async function submitSchedule() {
    const id = document.getElementById("sId").value;
    const cron = scheduleUnsupported && !scheduleDirty ? scheduleOriginalCron : scheduleCronFromFields();
    if (!cron) return toast("\u8BF7\u9009\u62E9\u6709\u6548\u7684\u6267\u884C\u65F6\u95F4", true);
    const body = {
      name: document.getElementById("sName").value.trim(),
      cron,
      title_template: document.getElementById("sTitle").value.trim(),
      body_template: document.getElementById("sBody").value,
      agent_id: Number(document.getElementById("sAgent").value),
      project_id: Number(document.getElementById("sProject").value) || null,
      perm: document.getElementById("sPerm").value,
      block_on_failure: document.getElementById("sBlockOnFailure").checked
    };
    try {
      if (id) await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/schedules", { method: "POST", body: JSON.stringify({ ...body, enabled: true }) });
      closeModal("scheduleModal");
      await loadAll();
      renderScheduleList();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function deleteSchedule(id) {
    if (!confirm("\u5220\u9664\u8BE5\u5B9A\u65F6\u4EFB\u52A1\uFF1F")) return;
    try {
      await api(`/api/schedules/${id}`, { method: "DELETE" });
      await loadAll();
      renderScheduleList();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // internal/web/static/src/settings.js
  async function loadSettings() {
    try {
      const s = await api("/api/settings");
      const el = document.getElementById("retentionDays");
      if (el) el.value = s.retention_days || "";
      const wt = document.getElementById("wtRetentionDays");
      if (wt) wt.value = s.worktree_retention_days || "";
    } catch (_) {
    }
  }
  async function saveWtRetention() {
    try {
      const days = document.getElementById("wtRetentionDays").value.trim();
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ worktree_retention_days: days }) });
      toast("\u5DF2\u4FDD\u5B58\uFF0C\u6BCF\u5C0F\u65F6\u81EA\u52A8\u6E05\u7406\u4E00\u6B21");
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function saveRetention() {
    try {
      const days = document.getElementById("retentionDays").value.trim();
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ retention_days: days }) });
      toast("\u5DF2\u4FDD\u5B58\uFF0C\u6BCF\u5C0F\u65F6\u6267\u884C\u4E00\u6B21\u81EA\u52A8\u6E05\u7406");
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function runCleanup() {
    const agentId = Number(document.getElementById("cleanupAgent").value) || null;
    const days = Number(document.getElementById("cleanupDays").value);
    const before = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : "";
    if (!confirm(`\u5220\u9664${agentId ? "\u8BE5\u89D2\u8272" : "\u5168\u90E8\u89D2\u8272"}${before ? "\u3001" + days + " \u5929\u524D" : ""}\u7684\u7EC8\u6001\u4EFB\u52A1\uFF1F\u4E0D\u53EF\u6062\u590D\uFF01`)) return;
    try {
      const r = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
      toast(`\u5DF2\u5220\u9664 ${r.deleted} \u6761\u5386\u53F2`);
      await loadAll();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // internal/web/static/src/main.js
  async function loadAll() {
    const [tasks, agents, schedules, projects] = await Promise.all([
      api("/api/tasks"),
      api("/api/agents"),
      api("/api/schedules"),
      api("/api/projects")
    ]);
    state.tasks = tasks;
    state.agents = agents;
    state.schedules = schedules;
    state.projects = projects;
    fillSelects();
  }
  async function loadSchema(forceRefresh = false) {
    try {
      const list = forceRefresh ? await api("/api/agents/schema/refresh", { method: "POST" }) : await api("/api/agents/schema");
      state.schema = {};
      list.forEach((s) => state.schema[s.id] = s);
      const sel = document.getElementById("aCli");
      const previous = sel ? sel.value : "";
      if (sel) {
        sel.innerHTML = list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
        sel.value = state.schema[previous] ? previous : list.length ? list[0].id : "";
      }
      return true;
    } catch (e) {
      if (forceRefresh) throw e;
      return false;
    }
  }
  function fillSelects() {
    const opts = (a) => a.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    const enOpts = state.agents.filter((a) => a.enabled);
    for (const id of ["tAgent", "sAgent"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = (id === "tAgent" ? `<option value="">\u4E0D\u6307\u6D3E</option>` : "") + opts(enOpts);
    }
    for (const id of ["fAgent", "hAgent", "cleanupAgent"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">\u5168\u90E8\u89D2\u8272</option>` + opts(state.agents);
    }
    const pOpts = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    for (const id of ["fProject", "tProject", "sProject"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      const empty = id === "fProject" ? "\u5168\u90E8\u9879\u76EE" : id === "sProject" ? "\u65E0\u9879\u76EE\uFF08\u901A\u7528\u5B9A\u65F6\u4EFB\u52A1\uFF09" : "\u65E0\u9879\u76EE";
      el.innerHTML = `<option value="">${empty}</option>` + pOpts;
    }
    const cnt = document.getElementById("sbBoardCount");
    if (cnt) cnt.textContent = state.tasks.filter((t) => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
    const pc = document.getElementById("sbProjectCount");
    if (pc) pc.textContent = state.projects.filter((p) => p.status === "active").length || "";
  }
  async function refreshOverview() {
    try {
      state.overview = await api("/api/stats/overview");
    } catch (_) {
      return;
    }
    renderStatsStrip();
  }
  function renderStatsStrip() {
    const el = document.getElementById("dashStats");
    if (!el) return;
    const o = state.overview;
    if (!o) {
      el.innerHTML = "";
      return;
    }
    const counts = o.status_counts || [];
    const review = counts.find((s) => s.status === "awaiting_review");
    const today = o.daily && o.daily.length ? o.daily[o.daily.length - 1] : null;
    const boardChips = [
      ["\u8FDB\u884C\u4E2D", o.in_flight || 0, "var(--st-running)"],
      ["\u5F85\u5BA1\u6279", review ? review.count : 0, "var(--st-review)"],
      ["\u4ECA\u65E5\u5B8C\u6210", today ? today.count : 0, "var(--st-done)"],
      ["\u5B8C\u6210\u7387", fmtPct(o.success_rate), "var(--st-done)"],
      ["\u5E73\u5747\u8017\u65F6", fmtDur(o.avg_duration), "var(--fg-muted)"],
      ["\u6D3B\u8DC3\u9879\u76EE", o.projects || 0, "var(--fg-muted)"]
    ];
    const chips = el.classList.contains("dashboard-stats") ? [boardChips[1], boardChips[0], boardChips[2], boardChips[3]] : boardChips;
    el.innerHTML = chips.map((c) => `<div class="stat-chip" style="--metric-color:${c[2]}" aria-label="${c[0]} ${c[1]}">
    <span class="sc-dot"></span>
    <b>${c[1]}</b>
    <span class="sc-label">${c[0]}</span>
  </div>`).join("");
  }
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
      const title = mobile ? "\u5173\u95ED\u5BFC\u822A" : sb.classList.contains("collapsed") ? "\u5C55\u5F00\u4FA7\u8FB9\u680F (Ctrl+B)" : "\u6536\u8D77\u4FA7\u8FB9\u680F (Ctrl+B)";
      btn.title = title;
      btn.setAttribute("aria-expanded", mobile ? String(open) : String(!sb.classList.contains("collapsed")));
      btn.setAttribute("aria-label", btn.title);
    }
    const mobileBtn = document.getElementById("mobileNavToggle");
    if (mobileBtn) {
      mobileBtn.setAttribute("aria-expanded", mobile ? String(open) : "false");
      mobileBtn.setAttribute("aria-label", mobile && open ? "\u5173\u95ED\u5BFC\u822A" : "\u6253\u5F00\u5BFC\u822A");
      mobileBtn.title = mobile && open ? "\u5173\u95ED\u5BFC\u822A" : "\u6253\u5F00\u5BFC\u822A";
    }
    const backdrop = document.getElementById("sidebarBackdrop");
    if (backdrop) backdrop.setAttribute("aria-hidden", mobile && open ? "false" : "true");
    document.body.classList.toggle("nav-open", mobile && open);
  }
  function toggleSidebar() {
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
    try {
      localStorage.setItem("paihuo.sb", collapsed ? "1" : "0");
    } catch (_) {
    }
  }
  function restoreSidebar() {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem("paihuo.sb") === "1";
    } catch (_) {
    }
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
          try {
            saved = localStorage.getItem("paihuo.sb") === "1";
          } catch (_) {
          }
          current.classList.toggle("collapsed", saved);
        }
        syncSidebarControls();
      });
    }
  }
  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      const inField = t && (t.matches("input, textarea, select") || t.isContentEditable);
      if (t?.closest?.(".xterm")) return;
      const modal = activeModal();
      if (e.key === "Tab" && modal) {
        const focusable = [...modal.querySelectorAll("button:not([disabled]), [href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((el) => !el.closest(".hidden") && el.getClientRects().length);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (!modal.contains(document.activeElement)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.key === "Escape") {
        const sb = document.getElementById("sidebar");
        if (isMobileNav() && sb?.classList.contains("mobile-open")) {
          sb.classList.remove("mobile-open");
          syncSidebarControls();
          return;
        }
        const modal2 = activeModal();
        if (modal2) closeModal(modal2.id);
        return;
      }
      if (inField) return;
      if (e.key === "n" || e.key === "N") {
        const taskModal = document.getElementById("taskModal");
        const inDetail = !document.getElementById("detailShell")?.classList.contains("hidden");
        if (!taskModal || inDetail) return;
        openNewTask();
      }
      if (e.key === "/") {
        const s = document.querySelector("#pSearch, #aSearch");
        if (s) {
          e.preventDefault();
          s.focus();
        }
      }
    });
    document.addEventListener("click", (e) => {
      if (e.target && e.target.classList && e.target.classList.contains("modal")) {
        closeModal(e.target.id);
      }
    });
    document.addEventListener("click", (e) => {
      const row = e.target.closest?.(".dir-row");
      if (row) {
        dirLoad(row.dataset.path);
        return;
      }
      const seg = e.target.closest?.(".crumb-seg");
      if (seg && !seg.classList.contains("cur")) dirLoad(seg.dataset.p);
    });
    document.querySelector(".sidebar-nav")?.addEventListener("click", (e) => {
      if (isMobileNav() && e.target.closest("a")) {
        const sb = document.getElementById("sidebar");
        if (sb) {
          sb.classList.remove("mobile-open");
          syncSidebarControls();
        }
      }
    });
    document.querySelectorAll(".modal").forEach((modal) => modal.setAttribute("aria-hidden", modal.classList.contains("hidden") ? "true" : "false"));
  }
  function route() {
    const h = location.hash;
    const path = location.pathname;
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
  var ovTimer = null;
  function refreshOverviewSoon() {
    clearTimeout(ovTimer);
    ovTimer = setTimeout(refreshOverview, 600);
  }
  function sse() {
    if (state.es) return;
    const es = new EventSource("/api/events");
    state.es = es;
    es.addEventListener("task", (ev) => {
      try {
        const t = JSON.parse(ev.data).payload;
        const i = state.tasks.findIndex((x) => x.id === t.id);
        if (i >= 0) state.tasks[i] = t;
        else state.tasks.unshift(t);
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
          renderAgentList();
          if (state.agentTab === "overview") renderAgentOverview(state.agentEditing);
        } else if (path === "/projects") {
          renderProjectList();
          if (state.projectView) refreshProjectDetail();
        }
        fillSelects();
        if (state.selected === t.id) refreshDetail();
      } catch (_) {
      }
    });
    es.addEventListener("log", (ev) => {
      try {
        appendLog(JSON.parse(ev.data).payload);
      } catch (_) {
      }
    });
    es.addEventListener("provision", (ev) => {
      try {
        const d = JSON.parse(ev.data).payload;
        if (provState.instCli && d.cli === provState.instCli) appendInstLine(d.line || "");
        if (d.line && d.line.includes("[install] \u5B8C\u6210")) {
          setTimeout(loadProvision, 1500);
        }
      } catch (_) {
      }
    });
    es.addEventListener("error", () => {
      if (!state.es) return;
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      return;
    }
    if (!state.es) {
      sse();
      loadAll().then(() => {
        const path = location.pathname;
        if (path === "/") loadDashboard();
        else if (path === "/board") {
          renderBoard();
          renderList();
          refreshOverview();
        } else if (path === "/history") loadHistory();
        else if (path === "/roles") renderAgentList();
        else if (path === "/agents") loadProvision();
        else if (path === "/projects") renderProjectList();
        else if (path === "/autopilots") renderScheduleList();
        else if (path === "/skills") loadSkillLib().then(() => {
          renderSkillLib();
          route();
        });
        else if (path === "/settings") loadSettings();
      }).catch(() => {
      });
    }
  });
  window.addEventListener("pagehide", () => {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
  });
  document.addEventListener("DOMContentLoaded", async () => {
    restoreSidebar();
    initShortcuts();
    const schemaP = loadSchema();
    try {
      await loadAll();
    } catch (e) {
      toast("\u52A0\u8F7D\u5931\u8D25: " + e.message, true);
    }
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
      try {
        av = localStorage.getItem("paihuo.agentView") || "grid";
      } catch (_) {
      }
      setAgentView(av === "table" ? "table" : "grid");
      let as = "name-asc";
      try {
        as = localStorage.getItem("paihuo.agentSort") || "name-asc";
      } catch (_) {
      }
      setAgentSort(as);
    } else if (path === "/agents") {
      loadProvision();
    } else if (path === "/projects") {
      renderProjectList();
    } else if (path === "/autopilots") {
      renderScheduleList();
    } else if (path === "/skills") {
      let sv = "grid";
      try {
        sv = localStorage.getItem("paihuo.skillView") || "grid";
      } catch (_) {
      }
      setSkillView(sv === "list" ? "list" : "grid");
      setSkillTab("skills");
      await loadSkillLib();
      renderSkillLib();
    } else if (path === "/settings") {
      loadSettings();
    }
    route();
    window.addEventListener("hashchange", route);
    sse();
    await schemaP;
  });
  window.addChip = addChip;
  window.agentTab = agentTab;
  window.allowProjectTaskDrop = allowProjectTaskDrop;
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
  window.copyCurrentRole = copyCurrentRole;
  window.copyLogs = copyLogs;
  window.copyRole = copyRole;
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
  window.dropProjectTask = dropProjectTask;
  window.endInteractiveTask = endInteractiveTask;
  window.endProjectTaskDrag = endProjectTaskDrag;
  window.filterSkillOptions = filterSkillOptions;
  window.focusFullscreenTerminal = focusFullscreenTerminal;
  window.focusTaskTerminal = focusTaskTerminal;
  window.gitInitProject = gitInitProject;
  window.installProvision = installProvision;
  window.loadHistory = loadHistory;
  window.logout = logout;
  window.mkdirCurrent = mkdirCurrent;
  window.moveProjectTask = moveProjectTask;
  window.openAgentDetail = openAgentDetail;
  window.openCurrentRoleEditor = openCurrentRoleEditor;
  window.openDirPicker = openDirPicker;
  window.openExtModal = openExtModal;
  window.openNewTask = openNewTask;
  window.openProject = openProject;
  window.openProjectModal = openProjectModal;
  window.openProjectTask = openProjectTask;
  window.openRoleStudio = openRoleStudio;
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
  window.renderProjectList = renderProjectList;
  window.renderSkillLib = renderSkillLib;
  window.resumeTask = resumeTask;
  window.roleStudioQuickAsk = roleStudioQuickAsk;
  window.runCleanup = runCleanup;
  window.saveAgentConcurrency = saveAgentConcurrency;
  window.saveAsTemplate = saveAsTemplate;
  window.saveRetention = saveRetention;
  window.saveRoleStudio = saveRoleStudio;
  window.saveSkillTags = saveSkillTags;
  window.saveSkillTagsInline = saveSkillTagsInline;
  window.saveWtRetention = saveWtRetention;
  window.scanSkills = scanSkills;
  window.selectAllNonMergeTasks = selectAllNonMergeTasks;
  window.sendRoleStudioChat = sendRoleStudioChat;
  window.sendRoleStudioTest = sendRoleStudioTest;
  window.setAgentSort = setAgentSort;
  window.setAgentView = setAgentView;
  window.setSkillTab = setSkillTab;
  window.setSkillView = setSkillView;
  window.setTaskStatus = setTaskStatus;
  window.setView = setView;
  window.startProjectTaskDrag = startProjectTaskDrag;
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
  window.toggleSkillTagsEditor = toggleSkillTagsEditor;
  window.wsDiscard = wsDiscard;
})();
