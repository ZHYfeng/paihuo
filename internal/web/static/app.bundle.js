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
    termTask: null,
    es: null,
    // SSE 连接（隐藏时断开、可见时重连）
    history: [],
    historySel: /* @__PURE__ */ new Set(),
    agentEditing: null,
    agentTab: "overview",
    agentModalRC: {},
    // 新建/编辑弹窗中的临时 role_config
    projectView: null,
    // 项目详情中的项目 id
    agentView: "grid",
    skillLib: []
    // 注册到 paihuo 工作目录的技能库 [{id,name,description,dir}]
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
    alert: "M12 3 2.5 20h19L12 3Zm0 7v5m0 3.5v.5"
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
  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }
  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
  }
  async function logout() {
    try {
      await fetch("/logout", { method: "POST" });
    } catch (_) {
    }
    location.href = "/login";
  }

  // internal/web/static/src/terminal.js
  var term = null;
  var termFit = null;
  function initTerm() {
    if (term) return;
    term = new Terminal({
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      lineHeight: 1.35,
      convertEol: true,
      scrollback: 1e4,
      cursorBlink: true,
      theme: {
        background: "#060a13",
        foreground: "#c9d4e5",
        cursor: "#38bdf8",
        selectionBackground: "rgba(56, 189, 248, .3)",
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
      }
    });
    termFit = new FitAddon.FitAddon();
    term.loadAddon(termFit);
    term.open(document.getElementById("termX"));
    termFit.fit();
    window.addEventListener("resize", () => {
      try {
        termFit.fit();
      } catch (_) {
      }
    });
  }
  function termWrite(content) {
    if (term) term.write(String(content ?? "") + "\r\n");
  }
  function openTerminal(id) {
    const t = state.tasks.find((x) => x.id === id) || {};
    document.getElementById("termTitle").textContent = `${t.agent_name || ""} \xB7 #${id} \u5BF9\u8BDD`;
    openModal("termModal");
    initTerm();
    setTimeout(() => {
      try {
        termFit.fit();
      } catch (_) {
      }
    }, 30);
    term.clear();
    term.write("\x1B[90m# loading logs...\x1B[0m\r\n");
    state.termTask = id;
    syncTerminalInput(t);
    api(`/api/tasks/${id}/logs`).then((logs) => {
      if (state.termTask !== id) return;
      term.clear();
      logs.forEach((l) => termWrite(l.content));
      if (!logs.length) term.write("\x1B[90m\uFF08\u6682\u65E0\u8F93\u51FA\uFF09\x1B[0m\r\n");
    }).catch(() => {
      term.write("\x1B[31m\u65E5\u5FD7\u52A0\u8F7D\u5931\u8D25\x1B[0m\r\n");
    });
  }
  function closeTerminal() {
    state.termTask = null;
    const bar = document.getElementById("termInputBar");
    if (bar) bar.classList.add("hidden");
    closeModal("termModal");
  }
  function syncTerminalInput(t) {
    const bar = document.getElementById("termInputBar");
    const input = document.getElementById("termInput");
    if (!bar || !input) return;
    const enabled = t?.run_mode === "interactive" && t?.status === "running";
    bar.classList.toggle("hidden", !enabled);
    input.disabled = !enabled;
    if (!enabled) input.value = "";
  }
  async function sendTaskInput(id, inputID, explicitMessage) {
    const input = inputID ? document.getElementById(inputID) : null;
    const message = explicitMessage ?? input?.value ?? "";
    if (!message.trim()) {
      toast("\u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A", true);
      return false;
    }
    try {
      await api(`/api/tasks/${id}/input`, { method: "POST", body: JSON.stringify({ message }) });
      if (input) {
        input.value = "";
        input.focus();
      }
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }
  function sendTerminalInput() {
    if (!state.termTask) return;
    sendTaskInput(state.termTask, "termInput");
  }

  // internal/web/static/src/dashboard.js
  function dashCardHTML(t, actions) {
    return `<div class="card dash-card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">\u5BA1\u6279</span>` : ""}
    </div>
    <div class="c-title">${esc(t.title)}</div>
    <div class="c-meta">
      ${t.project_name ? `<span class="chip">${esc(t.project_name)}</span>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm av-${esc(t.agent_name)}">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">\u672A\u6307\u6D3E</span>`}
      </span>
    </div>
    ${actions ? `<div class="dash-actions" onclick="event.stopPropagation()">${actions}</div>` : ""}
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
    const running = state.tasks.filter((t) => ["queued", "claimed", "running"].includes(t.status)).sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 12);
    const review = state.tasks.filter((t) => t.status === "awaiting_review").sort((a, b) => (a.created_at || "") < (b.created_at || "") ? 1 : -1).slice(0, 12);
    run.innerHTML = running.map((t) => dashCardHTML(t)).join("") || `<div class="empty">\u6682\u65E0\u8FDB\u884C\u4E2D\u4EFB\u52A1</div>`;
    rev.innerHTML = review.map((t) => dashCardHTML(
      t,
      `<button class="btn xs brand" onclick="setTaskStatus(${t.id},'succeeded')">\u901A\u8FC7\u5E76\u5408\u5E76</button><button class="btn xs" onclick="rejectTask(${t.id})">\u9A73\u56DE</button><button class="btn xs" onclick="openTerminal(${t.id})">\u770B\u5BF9\u8BDD</button>`
    )).join("") || `<div class="empty">\u65E0\u5F85\u5BA1\u6279\u4EFB\u52A1</div>`;
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
      <div class="ob-title">\u5FEB\u901F\u5F00\u59CB</div>
      <a class="ob-step" href="/agents">1. \u5B89\u88C5 Agent\uFF08CLI\uFF09</a>
      <a class="ob-step" href="/roles">2. \u521B\u5EFA Role\uFF08\u89D2\u8272\u914D\u7F6E\uFF09</a>
      <a class="ob-step" href="/projects">3. \u65B0\u5EFA Project\uFF08\u7ED1\u5B9A\u5DE5\u4F5C\u76EE\u5F55\uFF09</a>
      <a class="ob-step" href="/board">4. \u5728 Board \u6D3E\u53D1\u4EFB\u52A1</a>
    </div>`;
      return;
    }
    box.innerHTML = active.map((p) => {
      const ts = state.tasks.filter((t) => t.project_id === p.id);
      const done = ts.filter((t) => t.status === "succeeded").length;
      const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
      const inflight = ts.filter((t) => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
      return `<div class="dash-proj" onclick="location.href='/projects#/project/${p.id}'">
      <div class="dp-top"><b title="${esc(p.name)}">${esc(p.name)}</b>
        ${inflight ? `<span class="badge running">${inflight} \u6D3B\u8DC3</span>` : `<span class="badge">${ts.length} \u4EFB\u52A1</span>`}</div>
      <div class="pc-progress"><div class="pp-bar"><div style="width:${pct}%"></div></div>
        <span class="pc-pct">${pct}%</span></div>
    </div>`;
    }).join("") || `<div class="empty">\u6682\u65E0\u6D3B\u8DC3\u9879\u76EE</div>`;
  }
  async function loadDashAgents() {
    try {
      const prov = await api("/api/provision");
      const box = document.getElementById("dashAgents");
      if (!box) return;
      const installed = prov.filter((p) => p.installed);
      const agents = state.agents || [];
      const running = state.tasks.filter((t) => t.status === "running").length;
      const review = state.tasks.filter((t) => t.status === "awaiting_review").length;
      box.innerHTML = `
      <div class="dash-prov">
        ${prov.map((p) => `<span class="prov-chip ${p.installed ? "ok" : ""} ${p.login ? "login" : ""}" title="${esc(p.name)}${p.installed ? " " + esc(p.version) : " \u2014 \u672A\u5B89\u88C5"}${p.installed && !p.login ? "\uFF08\u672A\u767B\u5F55\uFF09" : ""}">${esc(p.name)}${p.installed ? p.login ? " \u2713" : " \u26A0" : " \u2717"}</span>`).join("")}
      </div>
      <div class="dash-prov-meta">
        <span><b>${installed.length}/${prov.length}</b> \u5DF2\u5B89\u88C5</span>
        <span><b>${agents.filter((a) => a.enabled).length}</b> \u89D2\u8272\u542F\u7528</span>
        <span><b style="color:var(--st-running)">${running}</b> \u8FD0\u884C\u4E2D</span>
        <span><b style="color:var(--st-review)">${review}</b> \u5F85\u5BA1\u6279</span>
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
          ${canRetryTask(t) ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}\u91CD\u8BD5</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}\u5220\u9664</button>
        </span>
      </td>
    </tr>`).join("");
    const empty = document.getElementById("historyEmpty");
    if (empty) empty.classList.toggle("hidden", state.history.length > 0);
    const cnt = document.getElementById("hSelCount");
    if (cnt) cnt.textContent = state.historySel.size;
  }
  function toggleRow(tr) {
    const id = Number(tr.dataset.id);
    if (state.historySel.has(id)) state.historySel.delete(id);
    else state.historySel.add(id);
    tr.classList.toggle("selected", state.historySel.has(id));
    const cb = tr.querySelector("input[type=checkbox]");
    if (cb) cb.checked = state.historySel.has(id);
    const cnt = document.getElementById("hSelCount");
    if (cnt) cnt.textContent = state.historySel.size;
  }
  function toggleAll() {
    const all = document.getElementById("hCheckAll").checked;
    state.historySel.clear();
    if (all) state.history.forEach((t) => state.historySel.add(t.id));
    renderHistory();
  }
  async function deleteSelected() {
    const ids = [...state.historySel];
    if (!ids.length) return toast("\u5148\u52FE\u9009\u8981\u5220\u9664\u7684\u4EFB\u52A1", true);
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
    document.getElementById("segSkillLib").classList.toggle("active", skills);
    document.getElementById("segExt").classList.toggle("active", !skills);
    document.getElementById("skillShell").classList.toggle("hidden", !skills);
    document.getElementById("extShell").classList.toggle("hidden", skills);
    document.getElementById("btnAddSkill").classList.toggle("hidden", !skills);
    document.getElementById("btnAddExt").classList.toggle("hidden", skills);
    if (!skills) loadExtensions();
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
    } catch (_) {
      state.skillLib = [];
    }
  }
  function renderSkillLib() {
    const grid = document.getElementById("skillGrid");
    if (!grid) return;
    const lib = state.skillLib;
    grid.innerHTML = lib.map((s) => `
    <div class="skill-card">
      <div class="sk-top">
        <span class="avatar">${esc((s.name || "?").slice(0, 1))}</span>
        <div class="sk-id">
          <div class="sk-name">${esc(s.name)}</div>
          <div class="sk-desc">${esc(s.description || "\u65E0\u63CF\u8FF0")}</div>
        </div>
      </div>
      <div class="sk-meta">
        <span class="chip" title="${esc(s.dir)}">${esc(s.dir)}</span>
      </div>
      <div class="sk-foot">
        <span class="count-info">\u6765\u6E90\uFF1A${esc(s.source_path || "-")} \xB7 ${(s.created_at || "").slice(0, 10)}</span>
        <span class="ac-ops">
          <button class="btn xs danger" onclick="deleteSkill(${s.id})">${icon("trash")}\u5220\u9664</button>
        </span>
      </div>
    </div>`).join("");
    const empty = document.getElementById("skillEmpty");
    if (empty) empty.classList.toggle("hidden", lib.length > 0);
    const cnt = document.getElementById("skillCount");
    if (cnt) cnt.textContent = `${lib.length} \u4E2A\u6280\u80FD`;
  }
  function openSkillModal() {
    document.getElementById("sSkillPath").value = "";
    loadProjDatalist();
    openModal("skillModal");
  }
  async function submitSkill() {
    const path = document.getElementById("sSkillPath").value.trim();
    if (!path) return toast("\u9700\u8981\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84", true);
    try {
      const sk = await api("/api/skills", { method: "POST", body: JSON.stringify({ source_path: path }) });
      closeModal("skillModal");
      toast(`\u5DF2\u5BFC\u5165 skill: ${sk.name}`);
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
      await loadSkillLib();
      renderSkillLib();
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

  // internal/web/static/src/task.js
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
  function renderBoard() {
    const el = document.getElementById("boardView");
    if (!el) return;
    const tasks = filteredTasks();
    el.innerHTML = BOARD_COLS.map(([key, label, statuses]) => {
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
    const c = document.getElementById("viewCount");
    if (c) c.textContent = `${tasks.length} \u4E2A\u4EFB\u52A1`;
  }
  function cardHTML(t) {
    return `<div class="card" onclick="openTask(${t.id})" style="--st-color:${ST_COLOR[t.status]}">
    <div class="c-top">
      <span class="st-dot"></span><span class="c-id">#${t.id}</span>
      <span class="c-time">${(t.created_at || "").slice(5, 16).replace("T", " ")}</span>
      ${t.perm === "review" ? `<span class="chip review">\u5BA1\u6279</span>` : ""}
      ${t.run_mode === "interactive" ? `<span class="chip">\u4EA4\u4E92</span>` : ""}
      ${t.concurrent ? `<span class="chip">\u5E76\u53D1</span>` : ""}
      ${t.review_rounds > 0 ? `<span class="chip">\u7B2C${t.review_rounds}\u8F6E</span>` : ""}
    </div>
    <div class="c-title">${esc(t.title)}</div>
    ${t.body ? `<div class="c-desc">${esc(t.body)}</div>` : ""}
    <div class="c-meta">
      ${t.project_id && t.project_name ? `<a class="chip chip-link" href="/projects#/project/${t.project_id}" title="\u6253\u5F00\u9879\u76EE\u9875" onclick="event.stopPropagation()">${esc(t.project_name)}</a>` : ""}
      <span class="c-foot">
        ${t.agent_name ? `<span class="c-agent"><span class="avatar sm">${esc((t.agent_name || "?").slice(0, 1))}</span>${esc(t.agent_name)}</span>` : `<span class="c-agent" style="color:var(--fg-faint)">\u672A\u6307\u6D3E</span>`}
        ${t.error ? `<span style="color:var(--danger)">\u2717</span>` : ""}
      </span>
    </div>
  </div>`;
  }
  function renderList() {
    const el = document.getElementById("listBody");
    if (!el) return;
    const tasks = filteredTasks();
    el.innerHTML = tasks.map((t) => `
    <tr onclick="openTask(${t.id})">
      <td class="num">#${t.id}</td>
      <td class="t-title">${esc(t.title)}</td>
      <td>${esc(t.agent_name || "-")}</td>
      <td>${t.project_id ? `<a class="t-link" href="/projects#/project/${t.project_id}" onclick="event.stopPropagation()">${esc(t.project_name || "-")}</a>` : esc(t.project_name || "-")}</td>
      <td><span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.review_rounds || ""}</td>
      <td class="num">${(t.created_at || "").slice(5, 16).replace("T", " ")}</td>
      <td class="num">${(t.finished_at || "").slice(5, 16).replace("T", " ")}</td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="event.stopPropagation();openTerminal(${t.id})">${icon("terminal")}\u5BF9\u8BDD</button>
          ${canRetryTask(t) ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}\u91CD\u8BD5</button>` : ""}
          <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}\u5220\u9664</button>
        </span>
      </td>
    </tr>`).join("");
    const empty = document.getElementById("listEmpty");
    if (empty) empty.classList.toggle("hidden", tasks.length > 0);
    const c = document.getElementById("viewCount");
    if (c) c.textContent = `${tasks.length} \u4E2A\u4EFB\u52A1`;
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
    location.hash = "#/issue/" + id;
  }
  function closeDetail() {
    state.selected = null;
    location.hash = "#/";
  }
  function showDetail(id) {
    state.selected = id;
    const shell = document.getElementById("boardShell") || document.getElementById("dashShell");
    if (shell) shell.classList.add("hidden");
    const main = document.querySelector(".main");
    main?.querySelector(".page-header")?.classList.add("hidden");
    main?.querySelector(".page-content")?.classList.add("hidden");
    document.getElementById("detailShell").classList.remove("hidden");
    const t = state.tasks.find((x) => x.id === id);
    if (t) {
      document.getElementById("dCrumb").innerHTML = `\u4EFB\u52A1 / <b>#${t.id}</b>`;
      document.getElementById("dBadge").innerHTML = `<span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>`;
    }
    refreshDetail();
  }
  function hideDetail() {
    document.getElementById("detailShell").classList.add("hidden");
    const shell = document.getElementById("boardShell") || document.getElementById("dashShell");
    if (shell) shell.classList.remove("hidden");
    const main = document.querySelector(".main");
    main?.querySelector(".page-header")?.classList.remove("hidden");
    main?.querySelector(".page-content")?.classList.remove("hidden");
    state.selected = null;
  }
  async function refreshDetail() {
    if (!state.selected) return;
    try {
      const [task, logs] = await Promise.all([
        api(`/api/tasks/${state.selected}`),
        api(`/api/tasks/${state.selected}/logs`)
      ]);
      const i = state.tasks.findIndex((x) => x.id === task.id);
      if (i >= 0) state.tasks[i] = task;
      else state.tasks.unshift(task);
      state.logs = logs;
      renderDetail(task);
    } catch (_) {
    }
  }
  function renderDetail(t) {
    const main = document.getElementById("dMain");
    if (!main) return;
    const isInteractive = t.run_mode === "interactive" && t.status === "running";
    const input = isInteractive ? `<div class="term-input detail-input">
      <input id="taskInput" autocomplete="off" aria-label="\u53D1\u9001\u7ED9 Pi \u7684\u6D88\u606F" placeholder="\u53D1\u9001\u6D88\u606F\u7ED9 Pi\uFF08Enter \u53D1\u9001\uFF09" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();sendTaskInput(${t.id},'taskInput')}">
      <button class="btn primary" onclick="sendTaskInput(${t.id},'taskInput')">\u53D1\u9001</button>
    </div>` : "";
    main.innerHTML = `
    <h2>${esc(t.title)}</h2>
    <div class="detail-id">#${t.id} \xB7 \u521B\u5EFA\u4E8E ${esc((t.created_at || "").slice(0, 16).replace("T", " "))}
      ${t.resume_of ? ` \xB7 <span style="color:var(--brand)">\u7EED\u8DD1\u81EA #${t.resume_of}</span>` : ""}</div>
    ${t.body ? `<div class="detail-desc">${esc(t.body)}</div>` : ""}
    ${t.error ? `<div class="detail-desc" style="border-color:rgba(255,99,105,.4);color:var(--danger)">\u9519\u8BEF\uFF1A${esc(t.error)}</div>` : ""}
    <div id="childrenBox"></div>
    ${t.status === "awaiting_review" ? `<div id="diffBox"><div class="empty">\u52A0\u8F7D\u6539\u52A8\u4E2D...</div></div>` : ""}
    <div class="sec-title">\u5DE5\u4F5C\u7A7A\u95F4</div>
    <div id="wsBox"><div class="empty">\u52A0\u8F7D\u4E2D...</div></div>
    <div class="term">
      <div class="term-head">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="t-title">${esc(t.agent_name || "\u672A\u6307\u6D3E")} \xB7 \u5BF9\u8BDD \xB7 ${esc(t.project_dir || "")}</span>
        <button class="btn ghost xs" onclick="copyLogs()">${icon("copy")}\u590D\u5236</button>
        <button class="btn ghost xs" onclick="openTerminal(${t.id})">${icon("expand")}\u5168\u5C4F</button>
      </div>
      <div class="term-body" id="logBox">${logsHTML()}</div>
      ${input}
    </div>`;
    const box = document.getElementById("logBox");
    if (box) box.scrollTop = box.scrollHeight;
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
      const isMergeTask = !!t.merge_of;
      const canManualMerge = isMergeTask && ["succeeded", "failed"].includes(t.status);
      const sourceAwaitingMerge = !isMergeTask && t.status === "succeeded";
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
      <div class="ws-row"><span class="ws-label">\u8DEF\u5F84</span><span class="ws-val mono" title="${esc(w.path)}">${esc(w.path)}</span></div>` + (done ? `<div class="ws-actions">` + (canManualMerge ? `<button class="btn sm brand" onclick="wsMerge(${id})">\u5408\u5E76\u56DE\u4E3B\u5206\u652F</button>` : `<span class="ws-val">\u4EE3\u7801\u7531\u7CFB\u7EDF\u521B\u5EFA\u7684\u5408\u5E76\u4EFB\u52A1\u5199\u5165\u4E3B\u5206\u652F</span>`) + (sourceAwaitingMerge ? "" : `<button class="btn sm danger" onclick="wsDiscard(${id})">\u4E22\u5F03</button>`) + `</div>` : "");
    } catch (_) {
      box.innerHTML = `<div class="empty">\u5DE5\u4F5C\u7A7A\u95F4\u4FE1\u606F\u4E0D\u53EF\u7528</div>`;
    }
  }
  async function wsMerge(id) {
    if (!confirm(`\u628A\u4EFB\u52A1 #${id} \u7684\u6539\u52A8 squash \u5408\u5E76\u56DE\u4E3B\u5206\u652F\uFF1F`)) return;
    try {
      const r = await api(`/api/workspace/${id}/merge`, { method: "POST" });
      toast(`\u5DF2\u5408\u5E76${r.commit ? " (" + r.commit + ")" : ""}`);
      loadWorkspace(id);
    } catch (e) {
      toast(e.message, true);
    }
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
    const statusOpts = Object.keys(STATUS_LABEL).map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
    const pOpts = `<option value="">\u65E0\u9879\u76EE</option>` + state.projects.map((p) => `<option value="${p.id}" ${t.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    let actions = "";
    if (["queued", "claimed", "running"].includes(t.status)) {
      actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}\u53D6\u6D88\u4EFB\u52A1</button>`;
    }
    if (t.run_mode === "interactive" && t.status === "running") {
      actions += `<button class="btn sm" onclick="endInteractiveTask(${t.id})">${icon("terminal")}\u7ED3\u675F\u4F1A\u8BDD</button>`;
    }
    if (t.status === "awaiting_review") {
      actions += `<button class="btn sm brand" onclick="setTaskStatus(${t.id},'succeeded')">${icon("check")}\u901A\u8FC7\u5E76\u6D3E\u53D1\u5408\u5E76</button>`;
      actions += `<button class="btn sm" onclick="rejectTask(${t.id})">${icon("retry")}\u9A73\u56DE\u91CD\u505A</button>`;
      actions += `<button class="btn sm danger" onclick="setTaskStatus(${t.id},'cancelled')">${icon("x")}\u53D6\u6D88</button>`;
    }
    if (canRetryTask(t)) {
      actions += `<button class="btn sm" onclick="setTaskStatus(${t.id},'queued')">${icon("retry")}\u91CD\u8BD5</button>`;
      actions += `<button class="btn sm" onclick="resumeTask(${t.id})">${icon("terminal")}\u7EE7\u7EED\u5BF9\u8BDD</button>`;
    }
    actions += `<button class="btn sm" onclick="openSubTask(${t.id})">${icon("plus")}\u62C6\u5206\u5B50\u4EFB\u52A1</button>`;
    if (t.body) actions += `<button class="btn sm" onclick="saveAsTemplate(${t.id})">${icon("bookmark")}\u4FDD\u5B58\u4E3A\u6A21\u677F</button>`;
    actions += `<button class="btn sm danger" onclick="deleteTask(${t.id})">${icon("trash")}\u5220\u9664\u4EFB\u52A1</button>`;
    side.innerHTML = `
    <div class="sec-title">\u5C5E\u6027</div>
    <div class="prop-row"><span class="k">\u72B6\u6001</span>
      <span class="v"><select onchange="patchTask(${t.id},{status:this.value})">${statusOpts}</select></span></div>
    <div class="prop-row"><span class="k">\u9879\u76EE</span>
      <span class="v"><select onchange="patchTask(${t.id},{project_id:this.value||null})">${pOpts}</select></span></div>
    <div class="prop-row"><span class="k">\u89D2\u8272</span><span class="v">${esc(t.agent_name || "\u672A\u6307\u6D3E")}</span></div>
    <div class="prop-row"><span class="k">\u6743\u9650</span><span class="v">${PERM_LABEL[t.perm] || t.perm}</span></div>
    <div class="prop-row"><span class="k">\u65B9\u5F0F</span><span class="v">${t.run_mode === "interactive" ? "\u4EA4\u4E92\u5F0F Pi" : "\u6279\u5904\u7406 \xB7 -p"}</span></div>
    <div class="prop-row"><span class="k">\u5E76\u53D1</span>
      <span class="v"><select onchange="patchTask(${t.id},{concurrent:this.value==='1'})">
        <option value="0" ${t.concurrent ? "" : "selected"}>\u4E32\u884C\uFF08\u9ED8\u8BA4\uFF09</option>
        <option value="1" ${t.concurrent ? "selected" : ""}>\u5E76\u53D1</option>
      </select></span></div>
    <div class="prop-row"><span class="k">\u6267\u884C\u5668</span><span class="v">tmux \xB7 ${["claimed", "running"].includes(t.status) ? `paihuo:task-${t.id}` : "\u65E5\u5FD7\u5DF2\u5F52\u6863"}</span></div>
    <div class="prop-row"><span class="k">\u76EE\u5F55</span><span class="v" style="font-size:12px;word-break:break-all">${esc(t.project_dir || "-")}</span></div>
    <div class="prop-row"><span class="k">\u8F6E\u6B21</span><span class="v">${t.review_rounds || "-"}</span></div>
    <div class="prop-row"><span class="k">\u5F00\u59CB</span><span class="v">${esc((t.started_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="prop-row"><span class="k">\u7ED3\u675F</span><span class="v">${esc((t.finished_at || "-").slice(0, 16).replace("T", " "))}</span></div>
    <div class="sec-title">\u64CD\u4F5C</div>
    <div class="detail-actions">${actions}</div>`;
  }
  async function patchTask(id, set) {
    try {
      await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(set) });
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
    if (!confirm("\u5411 Pi \u53D1\u9001 /exit \u5E76\u7ED3\u675F\u4EA4\u4E92\u4F1A\u8BDD\uFF1F\u4EFB\u52A1\u4F1A\u6309\u6B63\u5E38\u9000\u51FA\u7ED3\u679C\u7ED3\u7B97\u3002")) return;
    if (await sendTaskInput(id, "", "/exit")) {
      toast("\u5DF2\u53D1\u9001 /exit\uFF0C\u7B49\u5F85 Pi \u9000\u51FA");
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
    if (!confirm(`\u5220\u9664\u4EFB\u52A1 #${id}\uFF1F\u6267\u884C\u65E5\u5FD7\u3001worktree\u3001\u4EFB\u52A1\u5206\u652F\u53CA\u5176\u5408\u5E76\u5B50\u4EFB\u52A1\u5C06\u4E00\u5E76\u5220\u9664\u3002`)) return;
    try {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      await loadAll();
      const p = location.pathname;
      if (state.selected === id) {
        closeDetail();
        location.hash = "#/";
      }
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
    return !(t.status === "succeeded" && !t.merge_of && state.tasks.some((child) => child.merge_of === t.id));
  }
  async function loadChildren(id) {
    try {
      const kids = await api(`/api/tasks/${id}/children`);
      const box = document.getElementById("childrenBox");
      if (!box || !kids.length) return;
      const done = kids.filter((k) => ["succeeded", "failed", "cancelled"].includes(k.status)).length;
      box.innerHTML = `<div class="sec-title">\u5B50\u4EFB\u52A1 ${done}/${kids.length}</div>` + kids.map((k) => `<div class="card" style="padding:8px 10px;margin-bottom:6px" onclick="openTask(${k.id})">
        <div class="c-title">#${k.id} ${esc(k.title)}</div>
        <div class="c-meta"><span class="badge ${k.status}" style="--st-color:${ST_COLOR[k.status]}"><span class="st-dot"></span>${STATUS_LABEL[k.status]}</span>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(k.agent_name || "")}</span></div>
      </div>`).join("");
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
    document.getElementById("tParentId").value = parentId;
    document.getElementById("taskModalTitle").textContent = "\u62C6\u5206\u5B50\u4EFB\u52A1";
    syncTaskRunMode();
    openModal("taskModal");
  }
  async function resumeTask(id) {
    if (!confirm(`\u7EED\u8DD1\u4EFB\u52A1 #${id}\uFF1F\u5C06\u521B\u5EFA\u65B0\u4EFB\u52A1\u5E76\u590D\u7528\u539F\u4F1A\u8BDD\u7EE7\u7EED\u5BF9\u8BDD\uFF08pi/omp \u771F\u5B9E\u7EED\u5BF9\u8BDD\uFF0C\u5176\u4ED6 CLI \u4E3A\u5168\u65B0\u4F1A\u8BDD\uFF09\u3002`)) return;
    try {
      const t = await api(`/api/tasks/${id}/resume`, { method: "POST" });
      toast(`\u5DF2\u521B\u5EFA\u7EED\u8DD1\u4EFB\u52A1 #${t.id}`);
      await loadAll();
      location.hash = "#/issue/" + t.id;
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
  function logLineHTML(l) {
    return `<div class="line"><span class="ts">${tsOf(l)}</span><span class="c ${l.stream}">${esc(l.content)}</span></div>`;
  }
  function logsHTML() {
    return state.logs.map(logLineHTML).join("");
  }
  function appendLog(l) {
    if (state.selected === l.task_id) {
      state.logs.push(l);
      const box = document.getElementById("logBox");
      if (box) {
        box.insertAdjacentHTML("beforeend", logLineHTML(l));
        box.scrollTop = box.scrollHeight;
      }
    }
    if (state.termTask === l.task_id) {
      if (term) termWrite(l.content);
    }
  }
  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(state.logs.map((l) => l.content).join("\n"));
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
    document.getElementById("tParentId").value = "";
    document.getElementById("taskModalTitle").textContent = "\u65B0\u5EFA\u4EFB\u52A1";
    syncTaskRunMode();
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
    document.getElementById("tParentId").value = "";
    document.getElementById("taskModalTitle").textContent = p ? `\u65B0\u5EFA\u4EFB\u52A1 \xB7 ${esc(p.name)}` : "\u65B0\u5EFA\u4EFB\u52A1";
    syncTaskRunMode();
    openModal("taskModal");
  }
  function syncTaskRunMode() {
    const agentID = Number(document.getElementById("tAgent")?.value) || 0;
    const agent = state.agents.find((a) => a.id === agentID);
    const isPi = agent?.cli === "pi";
    const select = document.getElementById("tRunMode");
    const help = document.getElementById("tRunModeHelp");
    if (!select) return;
    const interactive = select.querySelector('option[value="interactive"]');
    if (interactive) interactive.disabled = !isPi;
    if (!isPi && select.value === "interactive") select.value = "batch";
    if (help) {
      help.textContent = isPi ? "\u6279\u5904\u7406\u4F1A\u81EA\u52A8\u7ED3\u7B97\uFF1B\u4EA4\u4E92\u5F0F\u4F1A\u4FDD\u7559 Pi \u7EC8\u7AEF\uFF0C\u76F4\u5230\u4F60\u53D1\u9001 /exit\u3002" : "\u6279\u5904\u7406\u4F1A\u81EA\u52A8\u7ED3\u7B97\uFF1B\u4EA4\u4E92\u5F0F\u76EE\u524D\u4EC5\u652F\u6301 Pi \u89D2\u8272\u3002";
    }
  }
  async function submitTask() {
    const title = document.getElementById("tTitle").value.trim();
    if (!title) return toast("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A", true);
    const parentId = Number(document.getElementById("tParentId").value) || null;
    const projectId = Number(document.getElementById("tProject").value) || null;
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
      const done = ts.filter((t) => t.status === "succeeded").length;
      const pct = ts.length ? done / ts.length * 100 : 0;
      const agents = new Set(ts.map((t) => t.agent_name).filter(Boolean));
      return `<div class="project-card" onclick="openProject(${p.id})">
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
        <span>${ts.length} \u4EFB\u52A1</span>
        <span>${done} \u5B8C\u6210</span>
        <span>${agents.size} \u89D2\u8272</span>
        <span class="spacer"></span>
        <span class="pc-date">${(p.updated_at || p.created_at || "").slice(5, 16).replace("T", " ")}</span>
      </div>
    </div>`;
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
  function renderProjectDetail(p, s, tasks) {
    const main = document.getElementById("pdMain");
    const side = document.getElementById("pdSide");
    if (!main || !side) return;
    const counts = s.status_counts || [];
    const review = counts.find((c) => c.status === "awaiting_review");
    const rowHTML = tasks.map((t) => `
    <div class="p-task-row" onclick="openTerminal(${t.id})">
      <span class="num">#${t.id}</span>
      <span class="t">${esc(t.title)}</span>
      <span class="a">${t.agent_name ? `<span class="avatar sm">${esc(t.agent_name.slice(0, 1))}</span>${esc(t.agent_name)}` : "-"}</span>
      <span class="badge ${t.status}" style="--st-color:${ST_COLOR[t.status]}"><span class="st-dot"></span>${STATUS_LABEL[t.status]}</span>
      <span class="ops">
          ${canRetryTask(t) ? `<button class="btn xs" onclick="event.stopPropagation();setTaskStatus(${t.id},'queued')">${icon("retry")}\u91CD\u8BD5</button>` : ""}
        <button class="btn xs danger" onclick="event.stopPropagation();deleteTask(${t.id})">${icon("trash")}\u5220\u9664</button>
      </span>
    </div>`).join("");
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
        <div class="stat-chip"><span class="sc-dot" style="background:var(--fg-muted)"></span><b>${s.total}</b><span>\u603B\u4EFB\u52A1</span></div>
      </div>
    </div>

    <div class="sec-title">\u8FD1 14 \u5929\u5B8C\u6210</div>
    ${dailyChartHTML(s.daily, 14)}

    <div class="sec-title" style="display:flex;align-items:center;justify-content:space-between">
      <span>\u4EFB\u52A1 ${tasks.length}</span>
      <button class="btn sm brand" onclick="openProjectTask(${p.id})">${icon("plus")}\u65B0\u5EFA\u4EFB\u52A1</button>
    </div>
    <div class="p-task-list">
      ${rowHTML || `<div class="empty">\u8FD8\u6CA1\u6709\u4EFB\u52A1
        <button class="btn xs brand" style="margin-left:8px" onclick="openProjectTask(${p.id})">${icon("plus")}\u6D3E\u6D3B</button></div>`}
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
      let html = `<span class="crumb-seg" data-p="/">/</span>`;
      let cur = "";
      segs.forEach((s, i) => {
        cur += "/" + s;
        const last = i === segs.length - 1;
        html += `<span class="crumb-sep">/</span><span class="crumb-seg${last ? " cur" : ""}" data-p="${esc(cur)}">${esc(s)}</span>`;
      });
      el.innerHTML = html;
      const list = document.getElementById("dirList");
      list.innerHTML = "";
      if (d.parent !== d.path) {
        const up = document.createElement("div");
        up.className = "dir-row up";
        up.dataset.path = d.parent;
        up.innerHTML = icon("back") + `<span>\u4E0A\u4E00\u7EA7</span>`;
        list.appendChild(up);
      }
      d.dirs.forEach((n) => {
        const row = document.createElement("div");
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
  function renderAgentGrid() {
    const grid = document.getElementById("agentGrid");
    if (!grid) return;
    const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
    const list = state.agents.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q));
    grid.innerHTML = list.map((a) => {
      const rc = a.role_config || {};
      const st = agentTaskStats(a);
      return `<div class="agent-card" onclick="openAgentDetail(${a.id})">
      <div class="ac-top">
        <span class="avatar lg av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(a.name)}</div>
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
        <span class="ac-ops">
          <button class="btn xs" title="\u6253\u5F00\u8BE6\u60C5\u5E76\u5207\u5230\u914D\u7F6E tab" onclick="event.stopPropagation();agentTabFromCard(${a.id})">\u914D\u7F6E</button>
          <button class="btn xs" onclick="event.stopPropagation();openAgentModal(${a.id})">\u7F16\u8F91</button>
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "\u505C\u7528" : "\u542F\u7528"}</button>
        </span>
      </div>
    </div>`;
    }).join("");
    const cnt = document.getElementById("agentCount");
    if (cnt) cnt.textContent = `${list.length} \u4E2A\u89D2\u8272`;
  }
  function renderAgentTable() {
    const body = document.getElementById("agentList");
    if (!body) return;
    const q = (document.getElementById("aSearch")?.value || "").trim().toLowerCase();
    const list = state.agents.filter((a) => !q || a.name.toLowerCase().includes(q));
    body.innerHTML = list.map((a) => {
      const rc = a.role_config || {};
      return `<tr onclick="openAgentDetail(${a.id})">
      <td><span style="display:flex;align-items:center;gap:8px">
        <span class="avatar av-${esc(a.cli)}">${esc((a.name || "?").slice(0, 1))}</span>
        <b>${esc(a.name)}</b>
        <span style="font-size:11px;color:var(--fg-faint)">${esc(a.description || "")}</span>
      </span></td>
      <td><span class="badge">${esc(a.cli)}</span></td>
      <td>${esc(rc.model || "\u9ED8\u8BA4")}</td>
      <td class="num">${esc(String(a.max_concurrency || 1))}</td>
      <td><span class="badge ${a.enabled ? "succeeded" : "cancelled"}">${a.enabled ? "\u542F\u7528" : "\u505C\u7528"}</span></td>
      <td>
        <span class="ops">
          <button class="btn xs" onclick="event.stopPropagation();toggleAgent(${a.id})">${a.enabled ? "\u505C\u7528" : "\u542F\u7528"}</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteAgent(${a.id})">${icon("trash")}\u5220\u9664</button>
        </span>
      </td>
    </tr>`;
    }).join("");
    const empty = document.getElementById("agentEmpty");
    if (empty) empty.classList.toggle("hidden", list.length > 0);
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
  var pendingAgentTab = null;
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
    const tab = pendingAgentTab || "overview";
    pendingAgentTab = null;
    agentTab(tab);
  }
  function hideAgentDetail() {
    document.getElementById("agentDetailShell").classList.add("hidden");
    document.getElementById("agentListShell").classList.remove("hidden");
    state.agentEditing = null;
  }
  function agentTab(name) {
    state.agentTab = name;
    document.querySelectorAll("#agentTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    const a = state.agentEditing;
    if (!a) return;
    const form = document.getElementById("agentForm");
    if (name === "overview") renderAgentOverview(a);
    else if (name === "config") renderAgentConfig(a);
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
              <tr ${ps.project_id > 0 ? `onclick="openProject(${ps.project_id})" style="cursor:pointer"` : ""}>
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
        <div class="p-task-row" onclick="openTerminal(${t.id})">
          <span class="num">#${t.id}</span>
          <span class="t">${esc(t.title)}</span>
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
  function skillsControlHTML(f, val) {
    const items = val ? String(val).split(",").map((s) => s.trim()).filter(Boolean) : [];
    const lib = state.skillLib || [];
    const opts = lib.map((s) => {
      const on = items.includes(s.dir);
      return `<label class="skill-opt"><input type="checkbox" data-v="${esc(s.dir)}" ${on ? "checked" : ""} onchange="toggleSkill('${f.key}', this)"><span title="${esc(s.description || s.dir)}">${esc(s.name)}</span></label>`;
    }).join("");
    return `<div class="chip-editor">
    <input type="hidden" data-key="${f.key}" data-type="list" value="${esc(items.join(","))}">
    <div class="chips">${items.map((p) => chipHTML(f.key, p)).join("")}</div>
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
    const scope = input.closest("#configForm, #agentModalSchema");
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
    const options = Array.isArray(byModel[model]) ? byModel[model] : fallback;
    const current = select.value;
    select.innerHTML = selectOptionsHTML(options, current);
  }
  function fieldControlHTML(f, rc, selectedModel = "") {
    const val = fieldValue(f, rc);
    let attrs = `data-key="${f.key}" data-type="${f.type}"`;
    const hasModelThinking = f.key === "thinking" && f.thinking_options_by_model;
    if (hasModelThinking) {
      attrs += ` data-thinking-options="${esc(JSON.stringify(f.thinking_options_by_model))}"`;
      attrs += ` data-fallback-options="${esc(JSON.stringify(f.options || []))}"`;
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
  async function renderAgentConfig(a) {
    const form = document.getElementById("agentForm");
    if (!form) return;
    if (!state.schema[a.cli]) await loadSchema();
    const schema = state.schema[a.cli];
    if (!schema) {
      form.innerHTML = `<div class="empty">CLI schema \u672A\u52A0\u8F7D</div>`;
      return;
    }
    await loadSkillLib();
    form.innerHTML = `
    <div class="schema-tip">\u8BE5\u89D2\u8272\u7684\u53EF\u914D\u7F6E\u53C2\u6570\u6765\u81EA ${esc(schema.name)} \u5B98\u65B9\u6587\u6863
      ${schema.docs ? `<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">\u67E5\u770B\u6587\u6863 \u2197</a>` : ""}\u3002
      \u6BCF\u4E2A CLI \u7684\u5B57\u6BB5\u4E0D\u540C\u2014\u2014\u8FD9\u662F\u6309\u89D2\u8272\u6DF1\u5EA6\u5B9A\u5236\uFF0C\u4E0D\u662F\u7EDF\u4E00\u5B9A\u5236\uFF1B\u73AF\u5883\u53D8\u91CF\u5728\u4E0B\u65B9\u300C\u6267\u884C\u300D\u5206\u7EC4\u91CC\u4E00\u5E76\u7F16\u8F91\u3002</div>
    <div id="configForm">${schemaFormHTML(schema, a.role_config || {})}</div>
    <div style="margin-top:16px"><button class="btn primary" onclick="saveAgentConfig()">\u4FDD\u5B58</button></div>`;
  }
  async function saveAgentConfig() {
    const a = state.agentEditing;
    if (!a) return;
    const schema = state.schema[a.cli];
    const cfg = readConfigFrom(schema, document.getElementById("configForm"));
    try {
      await api(`/api/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ role_config: cfg }) });
      toast("\u914D\u7F6E\u5DF2\u4FDD\u5B58");
      await loadAll();
      showAgentDetail(a.id);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function openAgentModal(id) {
    const a = id ? state.agents.find((x) => x.id === id) : null;
    document.getElementById("agentModalTitle").textContent = a ? "\u7F16\u8F91\u89D2\u8272" : "\u65B0\u5EFA\u89D2\u8272";
    document.getElementById("aId").value = a ? a.id : "";
    document.getElementById("aName").value = a ? a.name : "";
    document.getElementById("aDesc").value = a ? a.description || "" : "";
    document.getElementById("aMaxConcurrency").value = a ? a.max_concurrency || 1 : 1;
    state.agentModalRC = a ? JSON.parse(JSON.stringify(a.role_config || {})) : {};
    await loadSchema();
    await loadSkillLib();
    const sel = document.getElementById("aCli");
    if (a) sel.value = a.cli;
    else if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
    renderAgentModalSchema();
    openModal("agentModal");
  }
  function renderAgentModalSchema() {
    const schema = state.schema[document.getElementById("aCli").value];
    const box = document.getElementById("agentModalSchema");
    if (!box) return;
    const sub = document.getElementById("agentModalSub");
    if (sub && schema) {
      sub.innerHTML = `\u914D\u7F6E\u6309 ${esc(schema.name)} \u5B98\u65B9\u6587\u6863\u5B9A\u5236
      ${schema.docs ? `\uFF08<a class="t-link" target="_blank" rel="noreferrer" href="${esc(schema.docs)}">\u6587\u6863 \u2197</a>\uFF09` : ""}\uFF0C\u4E0D\u540C CLI \u5B57\u6BB5\u4E0D\u540C`;
    }
    box.innerHTML = schema ? schemaFormHTML(schema, state.agentModalRC) : "";
  }
  async function submitAgent() {
    const id = document.getElementById("aId").value;
    const cli = document.getElementById("aCli").value;
    const schema = state.schema[cli];
    const body = {
      name: document.getElementById("aName").value.trim(),
      description: document.getElementById("aDesc").value.trim(),
      cli,
      max_concurrency: Number(document.getElementById("aMaxConcurrency").value),
      enabled: true,
      role_config: schema ? readConfigFrom(schema, document.getElementById("agentModalSchema")) : {}
    };
    try {
      if (id) await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
      closeModal("agentModal");
      await loadAll();
      renderAgentList();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function deleteAgent(id) {
    if (!id) return;
    if (!confirm("\u5220\u9664\u8BE5\u89D2\u8272\uFF1F\u672A\u5B8C\u6210\u4EFB\u52A1\u5C06\u5931\u53BB\u6307\u6D3E\uFF0C\u5386\u53F2\u4EFB\u52A1\u4FDD\u7559\u3002")) return;
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      await loadAll();
      renderAgentList();
      if (state.agentEditing && state.agentEditing.id === id) hideAgentDetail();
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

  // internal/web/static/src/schedules.js
  function renderScheduleList() {
    const body = document.getElementById("scheduleList");
    if (!body) return;
    body.innerHTML = state.schedules.map((sc) => `
    <tr>
      <td class="t-name"><b>${esc(sc.name)}</b></td>
      <td><span class="cron-chip">${icon("clock")}${esc(sc.cron)}</span></td>
      <td>${esc(sc.agent_name || "-")}</td>
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
    const sc = id ? state.schedules.find((x) => x.id === id) : null;
    document.getElementById("scheduleModalTitle").textContent = sc ? "\u7F16\u8F91\u5B9A\u65F6\u4EFB\u52A1" : "\u65B0\u5EFA\u5B9A\u65F6\u4EFB\u52A1";
    document.getElementById("sId").value = sc ? sc.id : "";
    document.getElementById("sName").value = sc ? sc.name : "";
    document.getElementById("sCron").value = sc ? sc.cron : "0 9 * * *";
    document.getElementById("sTitle").value = sc ? sc.title_template : "";
    document.getElementById("sBody").value = sc ? sc.body_template : "";
    document.getElementById("sPerm").value = sc ? sc.perm || "full" : "full";
    document.getElementById("sEnabled").checked = sc ? sc.enabled : true;
    if (sc) document.getElementById("sAgent").value = sc.agent_id;
    openModal("scheduleModal");
  }
  async function submitSchedule() {
    const id = document.getElementById("sId").value;
    const body = {
      name: document.getElementById("sName").value.trim(),
      cron: document.getElementById("sCron").value.trim(),
      title_template: document.getElementById("sTitle").value.trim(),
      body_template: document.getElementById("sBody").value,
      agent_id: Number(document.getElementById("sAgent").value),
      perm: document.getElementById("sPerm").value,
      enabled: document.getElementById("sEnabled").checked
    };
    try {
      if (id) await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/schedules", { method: "POST", body: JSON.stringify(body) });
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
    for (const id of ["fProject", "tProject"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = (id === "tProject" ? `<option value="">\u65E0\u9879\u76EE</option>` : `<option value="">\u5168\u90E8\u9879\u76EE</option>`) + pOpts;
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
    const chips = [
      ["\u8FDB\u884C\u4E2D", o.in_flight || 0, "var(--st-running)"],
      ["\u5F85\u5BA1\u6279", review ? review.count : 0, "var(--st-review)"],
      ["\u4ECA\u65E5\u5B8C\u6210", today ? today.count : 0, "var(--st-done)"],
      ["\u5B8C\u6210\u7387", fmtPct(o.success_rate), "var(--st-done)"],
      ["\u5E73\u5747\u8017\u65F6", fmtDur(o.avg_duration), "var(--fg-muted)"],
      ["\u9879\u76EE", o.projects || 0, "var(--fg-muted)"]
    ];
    el.innerHTML = chips.map((c) => `<div class="stat-chip">
    <span class="sc-dot" style="background:${c[2]}"></span>
    <b>${c[1]}</b><span>${c[0]}</span></div>`).join("");
  }
  function toggleSidebar() {
    const sb = document.getElementById("sidebar");
    if (!sb) return;
    const collapsed = sb.classList.toggle("collapsed");
    const btn = document.getElementById("sbToggle");
    if (btn) {
      btn.title = collapsed ? "\u5C55\u5F00\u4FA7\u8FB9\u680F (Ctrl+B)" : "\u6536\u8D77\u4FA7\u8FB9\u680F (Ctrl+B)";
      btn.setAttribute("aria-label", btn.title);
    }
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
    if (sb && collapsed) sb.classList.add("collapsed");
    if (collapsed) {
      const btn = document.getElementById("sbToggle");
      if (btn) {
        btn.title = "\u5C55\u5F00\u4FA7\u8FB9\u680F (Ctrl+B)";
        btn.setAttribute("aria-label", btn.title);
      }
    }
  }
  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      const inField = t && (t.matches("input, textarea, select") || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.key === "Escape") {
        document.querySelectorAll(".modal:not(.hidden)").forEach((m) => closeModal(m.id));
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
  }
  function route() {
    const h = location.hash;
    const path = location.pathname;
    if (path === "/projects") {
      const m2 = /^#\/project\/(\d+)/.exec(h);
      if (m2) showProjectDetail(Number(m2[1]));
      else if (state.projectView !== null) hideProjectDetail();
      return;
    }
    if (path === "/roles") {
      const m2 = /^#\/agent\/(\d+)/.exec(h);
      if (m2) {
        const id = Number(m2[1]);
        if (state.agentEditing === null || state.agentEditing.id !== id) showAgentDetail(id);
      } else if (state.agentEditing !== null) {
        hideAgentDetail();
      }
      return;
    }
    const m = /^#\/issue\/(\d+)/.exec(h);
    if (m) showDetail(Number(m[1]));
    else if (state.selected !== null || !document.getElementById("detailShell").classList.contains("hidden")) {
      hideDetail();
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
          if (state.selected === t.id) refreshDetail();
          refreshOverviewSoon();
        } else if (path === "/") {
          loadDashboard();
          if (state.selected === t.id) refreshDetail();
        } else if (path === "/history") {
          loadHistory();
        } else if (path === "/roles") {
          if (state.agentTab === "overview") renderAgentOverview(state.agentEditing);
        } else if (path === "/projects") {
          renderProjectList();
          if (state.projectView) refreshProjectDetail();
        }
        fillSelects();
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
        else if (path === "/skills") loadSkillLib().then(renderSkillLib);
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
      route();
      window.addEventListener("hashchange", route);
    } else if (path === "/board") {
      renderBoard();
      loadTemplates();
      refreshOverview();
      route();
      window.addEventListener("hashchange", route);
    } else if (path === "/history") {
      loadHistory();
    } else if (path === "/roles") {
      let av = "grid";
      try {
        av = localStorage.getItem("paihuo.agentView") || "grid";
      } catch (_) {
      }
      setAgentView(av === "table" ? "table" : "grid");
      route();
      window.addEventListener("hashchange", route);
    } else if (path === "/agents") {
      loadProvision();
    } else if (path === "/projects") {
      renderProjectList();
      route();
      window.addEventListener("hashchange", route);
    } else if (path === "/autopilots") {
      renderScheduleList();
    } else if (path === "/skills") {
      loadSkillLib().then(renderSkillLib);
    } else if (path === "/settings") {
      loadSettings();
    }
    sse();
    await schemaP;
  });
  window.addChip = addChip;
  window.agentTab = agentTab;
  window.applyFilters = applyFilters;
  window.applyTemplate = applyTemplate;
  window.cleanupHistory = cleanupHistory;
  window.closeAgentDetail = closeAgentDetail;
  window.closeDetail = closeDetail;
  window.closeInstTerminal = closeInstTerminal;
  window.closeModal = closeModal;
  window.closeProjectDetail = closeProjectDetail;
  window.closeTerminal = closeTerminal;
  window.copyLogs = copyLogs;
  window.copyText = copyText;
  window.createDefaultRole = createDefaultRole;
  window.deleteAgent = deleteAgent;
  window.deleteProject = deleteProject;
  window.deleteSchedule = deleteSchedule;
  window.deleteSelected = deleteSelected;
  window.deleteSkill = deleteSkill;
  window.deleteTask = deleteTask;
  window.deleteTemplate = deleteTemplate;
  window.endInteractiveTask = endInteractiveTask;
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
  window.openScheduleModal = openScheduleModal;
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
  window.resumeTask = resumeTask;
  window.runCleanup = runCleanup;
  window.saveAgentConcurrency = saveAgentConcurrency;
  window.saveAgentConfig = saveAgentConfig;
  window.saveAsTemplate = saveAsTemplate;
  window.saveRetention = saveRetention;
  window.saveWtRetention = saveWtRetention;
  window.sendTaskInput = sendTaskInput;
  window.sendTerminalInput = sendTerminalInput;
  window.setAgentView = setAgentView;
  window.setSkillTab = setSkillTab;
  window.setTaskStatus = setTaskStatus;
  window.setView = setView;
  window.submitAgent = submitAgent;
  window.submitExt = submitExt;
  window.submitProject = submitProject;
  window.submitSchedule = submitSchedule;
  window.submitSkill = submitSkill;
  window.submitTask = submitTask;
  window.syncModelThinking = syncModelThinking;
  window.syncTaskRunMode = syncTaskRunMode;
  window.toggleAll = toggleAll;
  window.toggleRow = toggleRow;
  window.toggleSchedule = toggleSchedule;
  window.toggleSidebar = toggleSidebar;
  window.toggleSkill = toggleSkill;
  window.wsDiscard = wsDiscard;
  window.wsMerge = wsMerge;
})();
