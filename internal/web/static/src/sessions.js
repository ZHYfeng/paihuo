// 会话页面（S-2/S-3）：lit 组件实现，UI 高度参考 pi-web。
// 设计 token 与组件结构对齐 pi-web（GitHub 暗色风格）：
//   bg #0d1117 / surface #161b22 / border #30363d / accent #58a6ff
//   .msg 卡片（user 蓝底 / assistant surface）、.tool-card 状态边框、
//   footer 输入区（shell-mode 运行中态）、workspace-header 头部。
// 数据源：全量 = GET /api/sessions/{id}/transcript（pi 会话 JSONL 解析）；
// 增量 = SSE session.message 事件（RPC 事件流透传）。
import { LitElement, html, css, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { api } from "./core.js";

// ---------------------------------------------------------------- pi-web 设计 token
// （组件内使用；会话页自成一体，不依赖 paihuo 全局主题变量）
export const PW = css`
  :host {
  --pw-bg: #0d1117;
  --pw-surface: #161b22;
  --pw-surface-hover: #21262d;
  --pw-border: #30363d;
  --pw-border-muted: #21262d;
  --pw-text: #e6edf3;
  --pw-text-secondary: #c9d1d9;
  --pw-muted: #8b949e;
  --pw-dim: #6e7681;
  --pw-accent: #58a6ff;
  --pw-accent-border: #2f81f7;
  --pw-selection-bg: #0d2847;
  --pw-success: #3fb950;
  --pw-success-border: #238636;
  --pw-success-bg: #0f1b12;
  --pw-success-ring: #3fb95055;
  --pw-warning: #d29922;
  --pw-warning-border: #6e5200;
  --pw-warning-surface: #1f1a10;
  --pw-danger: #ff7b72;
  --pw-purple: #d2a8ff;
  --pw-purple-border: #a371f7;
  --pw-purple-surface: #21132f;
  --pw-terminal-bg: #05070a;
  --pw-overlay: #0008;
  --pw-shadow: #0008;
  --pw-shadow-soft: #0006;
  }
`;

const STATUS_DOT = { created: "○", active: "◉", suspended: "○", delivered: "✓", deleted: "✕" };
const STATUS_LABEL = {
  created: "未启动", active: "活跃", suspended: "已挂起",
  delivered: "已交付", deleted: "已删除",
};

// ---------------------------------------------------------------- markdown 轻量渲染
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function md(src) {
  if (!src) return "";
  src = String(src);
  const out = [];
  let rest = src;
  while (rest.length) {
    const m = /```([\w-]*)\n?([\s\S]*?)```/.exec(rest);
    if (!m) { out.push(inlineMd(rest)); break; }
    out.push(inlineMd(rest.slice(0, m.index)));
    const code = esc(m[2].replace(/\n$/, ""));
    const lang = esc(m[1]);
    out.push(`<pre class="ph-code"><code${lang ? ` data-lang="${lang}"` : ""}>${code}</code></pre>`);
    rest = rest.slice(m.index + m[0].length);
  }
  return out.join("");
}

function inlineMd(src) {
  let s = esc(src);
  s = s.replace(/^(#{1,4})\s+(.+)$/gm, (_, h, t) => `<h${h.length}>${t}</h${h.length}>`);
  s = s.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  s = s.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(esc(c)); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return s;
}

// ---------------------------------------------------------------- 工具卡片辅助
function toolArg(tool, args) {
  if (!args) return "";
  const key =
    tool === "read_file" || tool === "write_file" || tool === "edit" || tool === "edit_file" ? "path" :
    tool === "grep" || tool === "glob" ? "pattern" :
    tool === "bash" ? "command" : "";
  if (key && args[key] != null) return String(args[key]).slice(0, 80);
  return "";
}

function toolName(block) {
  return block.name || block.toolName || "tool";
}

// ---------------------------------------------------------------- 会话 store
export const sessionState = {
  list: [],
  selectedId: null,
  detail: null,
  entries: [],
  live: null,
  agentRunning: false,
  pending: null,
  loading: false,
  filter: "all",
  projectFilter: "",
  transcriptTotal: 0,
  transcriptLoaded: 0,
  _firstEntryId: "",
};

// ---------------------------------------------------------------- 组件：会话页面
export class PhSessionsPage extends LitElement {
  static styles = css`
    ${PW}
    :host {
      display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 0;
      height: calc(100vh - 150px); min-height: 480px;
      background: var(--pw-bg); color: var(--pw-text);
      font: 14px system-ui, sans-serif; border: 1px solid var(--pw-border);
      border-radius: 12px; overflow: hidden;
    }
    .col-list { border-right: 1px solid var(--pw-border); min-height: 0; background: var(--pw-bg); }
    .col-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--pw-bg); }
    @media (max-width: 860px) {
      :host { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: auto; }
      .col-list { border-right: 0; border-bottom: 1px solid var(--pw-border); max-height: 38vh; }
      .col-main { height: 70vh; }
    }
  `;

  static properties = {
    selectedId: { state: true },
  };

  constructor() {
    super();
    this.selectedId = null;
    this.showCreate = false;
    this.prefill = null;
    this._onMessage = (e) => this._handleLive(e.detail);
    this._onUpdated = (e) => {
      // session.updated 携带完整会话对象：就地刷新详情（头部状态/徽标实时变）
      const d = e.detail;
      if (d && d.id && sessionState.detail && d.id === sessionState.detail.id) {
        sessionState.detail = d;
        this.requestUpdate();
      }
      this.refreshList();
    };
    this._onDetailRefresh = (e) => { if (e.detail) this._loadDetail(e.detail); };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("ph-session-message", this._onMessage);
    window.addEventListener("ph-session-updated", this._onUpdated);
    window.addEventListener("ph-session-detail-refresh", this._onDetailRefresh);
    this.refreshList();
    const q = new URLSearchParams(location.search);
    if (q.has("agent") || q.has("project") || q.has("title")) {
      this.prefill = { agent: q.get("agent") || "", project: q.get("project") || "", title: q.get("title") || "" };
      this.showCreate = true;
      history.replaceState(null, "", "/sessions");
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("ph-session-message", this._onMessage);
    window.removeEventListener("ph-session-updated", this._onUpdated);
    window.removeEventListener("ph-session-detail-refresh", this._onDetailRefresh);
  }

  async refreshList() {
    try {
      const list = await api("/api/sessions");
      sessionState.list = Array.isArray(list) ? list : [];
      this.requestUpdate();
    } catch (_) {}
  }

  async select(id) {
    this.selectedId = id;
    sessionState.selectedId = id;
    sessionState.detail = null;
    sessionState.entries = [];
    sessionState.pending = null;
    sessionState.live = null;
    this.requestUpdate();
    await this._loadDetail(id);
  }

  async _loadDetail(id) {
    try {
      const ss = await api(`/api/sessions/${id}`);
      sessionState.detail = ss;
      const tr = await api(`/api/sessions/${id}/transcript?limit=100`);
      sessionState.entries = buildRenderItems(tr && tr.entries ? tr.entries : []);
      sessionState.transcriptTotal = tr ? tr.total : sessionState.entries.length;
      sessionState.transcriptLoaded = sessionState.entries.length;
      this.requestUpdate();
      if (ss.status === "active") this._loadState(id);
    } catch (e) {
      toastErr(`加载会话失败: ${e.message || e}`);
    }
  }

  // 分页：加载更早的消息（pi-web：Scroll up to load earlier messages）。
  async loadEarlier() {
    const id = sessionState.detail?.id;
    if (!id || !sessionState.entries.length) return;
    // 游标 = 当前最早条目的 entry id（pi 会话 entry 有唯一 id）
    const before = sessionState.entries[0]?._id || "";
    if (!before) return 0;
    try {
      const tr = await api(`/api/sessions/${id}/transcript?limit=100&before=${encodeURIComponent(before || "")}`);
      const older = buildRenderItems(tr && tr.entries ? tr.entries : []);
      const known = new Set(sessionState.entries.map(e => e._id));
      const merged = [...older.filter(e => !known.has(e._id)), ...sessionState.entries];
      sessionState.entries = merged;
      sessionState.transcriptTotal = tr ? tr.total : merged.length;
      this.requestUpdate();
      return merged.length - sessionState.entries.length; // 新增条数（滚动位置修正用）
    } catch (_) { return 0; }
  }

  async _loadState(id) {
    try {
      const r = await api(`/api/sessions/${id}/state`);
      if (sessionState.detail && sessionState.detail.id !== id) return; // 已切换会话
      sessionState.live = (r && r.data) || null;
      this.requestUpdate();
    } catch (_) {}
  }

  _handleLive(detail) {
    if (!sessionState.detail || sessionState.detail.id !== detail.session_id) return;
    const ev = detail.event || {};
    if (ev.type === "agent_start") this._loadState(detail.session_id); // 刷新模型/思考级别
    applyLiveEvent(ev);
    this.requestUpdate();
  }

  render() {
    return html`
      <div class="col-list">
        <ph-session-list .selectedId=${this.selectedId} @select=${(e) => this.select(e.detail)} @create=${() => { this.showCreate = true; this.prefill = null; this.requestUpdate(); }}></ph-session-list>
      </div>
      <div class="col-main">
        ${sessionState.detail
          ? html`<ph-session-view .sessionId=${this.selectedId} @close=${() => { this.selectedId = null; sessionState.detail = null; this.requestUpdate(); }}></ph-session-view>`
          : html`<div class="pw-empty">选择或新建一个会话开始协作</div>`}
      </div>
      ${this.showCreate ? html`<ph-session-create .prefill=${this.prefill} @close=${() => { this.showCreate = false; this.requestUpdate(); }} @created=${(e) => { this.showCreate = false; this.refreshList(); this.requestUpdate(); this.select(e.detail); }}></ph-session-create>` : ""}
    `;
  }
}
customElements.define("ph-sessions-page", PhSessionsPage);

// transcript entries → RenderItem
export function buildRenderItems(entries) {
  const items = [];
  const byToolId = new Map();
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const attach = it => { it._id = e.id || ""; return it; };
    switch (e.type) {
      case "message": {
        const msg = e.message || {};
        const role = msg.role;
        if (role === "toolResult") { byToolId.set(msg.toolCallId, msg); break; }
        if (role === "assistant") { items.push(attach({ kind: "assistant", msg, toolResults: byToolId })); continue; }
        if (role === "bashExecution") { items.push(attach({ kind: "bash", msg })); continue; }
        items.push(attach({ kind: role === "user" ? "user" : "custom", msg }));
        break;
      }
      case "model_change": items.push(attach({ kind: "ev-model", provider: e.provider, modelId: e.modelId })); break;
      case "thinking_level_change": items.push(attach({ kind: "ev-thinking", level: e.thinkingLevel })); break;
      case "compaction": items.push(attach({ kind: "ev-compaction", summary: e.summary, tokensBefore: e.tokensBefore })); break;
      case "branch_summary": items.push(attach({ kind: "ev-branch", summary: e.summary })); break;
      default: break;
    }
  }
  return items;
}

// RPC 事件 → 增量更新
// 注意（pi RPC 协议事实）：
//   - user 消息没有事件流（message_start/end 只针对 assistant）→ 发送成功后
//     前端用 user_echo 回显，否则自己的输入永远不显示。
//   - message_update 是增量事件（assistantMessageEvent），无完整 message 快照，
//     需要从 message_start 的初始内容按 contentIndex 累积。
//   - 工具结果只有 tool_execution_end（没有 toolResult 消息），按 toolCallId
//     挂到最近一条 assistant 消息上。
function applyLiveEvent(ev) {
  const st = sessionState;
  switch (ev.type) {
    case "agent_start": st.agentRunning = true; break;
    case "agent_settled": st.agentRunning = false; break;
    case "turn_start": st.agentRunning = true; break;
    case "message_start": {
      const msg = ev.message || {};
      if (msg.role === "assistant") {
        st.pending = { kind: "assistant", msg, toolResults: new Map(), streaming: true };
        st.entries.push(st.pending);
      }
      break;
    }
    case "message_update": {
      const pending = st.pending;
      if (!pending || !pending.msg) break;
      const d = ev.assistantMessageEvent || {};
      const msg = pending.msg;
      let content = Array.isArray(msg.content) ? msg.content : [];
      if (!content.length && typeof msg.content === "string") content = [{ type: "text", text: msg.content }];
      const idx = Number.isInteger(d.contentIndex) ? d.contentIndex : Math.max(content.length - 1, 0);
      const block = content[idx] || { type: "text", text: "" };
      if (d.type === "text_delta" && typeof d.delta === "string") block.text = (block.text || "") + d.delta;
      else if (d.type === "thinking_delta" && typeof d.delta === "string") {
        if (block.type !== "thinking") block.type = "thinking";
        block.thinking = (block.thinking || "") + d.delta;
      }
      content[idx] = block;
      msg.content = content;
      break;
    }
    case "message_end": {
      const msg = ev.message || {};
      if (msg.role === "assistant") {
        if (st.pending) { st.pending.msg = msg; st.pending.streaming = false; st.pending = null; }
        else if (st.entries.length) {
          const last = st.entries[st.entries.length - 1];
          if (last && last.kind === "assistant") { last.msg = msg; last.streaming = false; }
        }
      }
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update":
      if (st.pending) st.pending.toolLive = ev;
      break;
    case "tool_execution_end": {
      if (ev.result != null) {
        for (let i = st.entries.length - 1; i >= 0; i--) {
          const it = st.entries[i];
          if (it && it.kind === "assistant") {
            if (!it.toolResults) it.toolResults = new Map();
            it.toolResults.set(ev.toolCallId, ev.result);
            break;
          }
        }
      }
      break;
    }
    case "user_echo": {
      // 用户自己的消息：发送成功后前端回显（pi RPC 流不为 user 消息发事件）。
      st.entries.push({ kind: "user", msg: ev.message || {} });
      break;
    }
    default: break;
  }
}

function toastErr(msg) {
  import("./core.js").then(m => m.toast(msg, true)).catch(() => alert(msg));
}

// ---------------------------------------------------------------- 组件：会话列表（pi-web 侧栏风格）
export class PhSessionList extends LitElement {
  static styles = css`
    ${PW}
    :host { display: flex; flex-direction: column; height: 100%; background: var(--pw-bg); }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--pw-border); }
    .head h2 { margin: 0; font-size: 14px; font-weight: 700; color: var(--pw-text); }
    .head .count { color: var(--pw-dim); font-size: 12px; }
    .toolbar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--pw-border-muted); }
    select { border: 1px solid var(--pw-border); background: var(--pw-surface); color: var(--pw-text); border-radius: 7px; padding: 4px 8px; font-size: 12.5px; }
    .items { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .item { border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; cursor: pointer; background: transparent; color: var(--pw-text); }
    .item:hover { background: var(--pw-surface-hover); }
    .item.sel { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); }
    .t1 { display: flex; gap: 8px; align-items: center; }
    .dot { font-size: 11px; }
    .dot.st-running { color: var(--pw-success); }
    .dot.st-succeeded { color: var(--pw-accent); }
    .dot.st-cancelled { color: var(--pw-dim); }
    .dot.st-failed { color: var(--pw-danger); }
    .title { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .meta { color: var(--pw-muted); font-size: 11.5px; margin-top: 3px; display: flex; gap: 6px; align-items: center; }
    .cli { border: 1px solid var(--pw-border); border-radius: 4px; padding: 0 5px; font-size: 10px; font-weight: 700; color: var(--pw-text-secondary); }
    .meta a { color: var(--pw-accent); text-decoration: none; }
    .new { margin: 8px 10px; padding: 6px; border: 1px dashed var(--pw-border); border-radius: 8px; text-align: center; cursor: pointer; color: var(--pw-muted); font-size: 12.5px; background: transparent; }
    .new:hover { color: var(--pw-text); border-color: var(--pw-border); background: var(--pw-surface-hover); }
    .pw-empty-sm { color: var(--pw-dim); text-align: center; padding: 28px 0; font-size: 12.5px; }
  `;
  static properties = { list: { state: true }, selectedId: { attribute: false }, filter: { state: true } };
  constructor() {
    super();
    this.list = [];
    this.selectedId = null;
    this.filter = "all";
    this.loading = false;
  }
  connectedCallback() {
    super.connectedCallback();
    if (!this.list.length) this._load();
  }
  async _load() {
    try { this.list = await api("/api/sessions"); this.requestUpdate(); } catch (_) {}
  }
  _filtered() {
    let l = Array.isArray(this.list) ? this.list : [];
    if (this.filter !== "all") l = l.filter(x => x.status === this.filter);
    return l;
  }
  render() {
    const items = this._filtered();
    return html`
      <div class="head">
        <h2>会话</h2><span class="count">${items.length}</span>
      </div>
      <div class="toolbar">
        <select .value=${this.filter} @change=${(e) => { this.filter = e.target.value; }}>
          <option value="all">全部</option>
          <option value="active">活跃</option>
          <option value="suspended">已挂起</option>
          <option value="delivered">已交付</option>
        </select>
      </div>
      <div class="items">
        ${items.map(s => html`
          <div class="item ${s.id === this.selectedId ? "sel" : ""}" @click=${() => this._emit("select", s.id)}>
            <div class="t1">
              <span class="dot st-${s.status}">${STATUS_DOT[s.status] || "○"}</span>
              <span class="title" title=${s.title}>${s.title}</span>
            </div>
            <div class="meta">
              <span class="cli">${s.cli || "?"}</span>
              <span>${s.agent_name || ""}</span>
              ${s.project_name ? html`<span>·</span><span>${s.project_name}</span>` : ""}
              <span>·</span><span>${relTime(s.last_message_at || s.created_at)}</span>
              ${s.message_count ? html`<span>·</span><span>${s.message_count} 条消息</span>` : ""}
              ${s.task_id ? html`<span>·</span><a href="#/issue/${s.task_id}" @click=${(e) => e.stopPropagation()}>任务 #${s.task_id}</a>` : ""}
            </div>
          </div>`)}
        ${!items.length ? html`<div class="pw-empty-sm">暂无会话</div>` : ""}
      </div>
      <button class="new" @click=${() => this._emit("create")}>＋ 新建会话</button>
    `;
  }
  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}
customElements.define("ph-session-list", PhSessionList);

// ---------------------------------------------------------------- 组件：新建会话（pi-web 弹窗风格）
export class PhSessionCreate extends LitElement {
  static styles = css`
    ${PW}
    :host { position: fixed; inset: 0; background: var(--pw-overlay); display: flex; align-items: center; justify-content: center; z-index: 60; }
    .box { background: var(--pw-surface); border: 1px solid var(--pw-border); border-radius: 12px; padding: 20px; width: 440px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 48px var(--pw-shadow); color: var(--pw-text); font: 14px system-ui, sans-serif; }
    h3 { margin: 0; font-size: 15px; }
    label { font-size: 12.5px; color: var(--pw-muted); display: flex; flex-direction: column; gap: 5px; }
    input, select { border: 1px solid var(--pw-border); border-radius: 8px; padding: 8px 10px; font-size: 14px; background: var(--pw-bg); color: var(--pw-text); font-family: inherit; }
    input:focus, select:focus { outline: none; border-color: var(--pw-accent-border); }
    .hint { font-size: 12px; color: var(--pw-muted); }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    button { border-radius: 8px; padding: 7px 14px; border: 1px solid var(--pw-border); cursor: pointer; font-size: 13.5px; background: var(--pw-bg); color: var(--pw-text); }
    button:hover { background: var(--pw-surface-hover); }
    button.primary { background: var(--pw-accent); border-color: var(--pw-accent-border); color: #fff; font-weight: 600; }
    button.primary:hover { background: var(--pw-accent-border); }
  `;
  static properties = { agents: { state: true }, projects: { state: true }, prefill: { attribute: false } };
  constructor() {
    super();
    this.agents = [];
    this.projects = [];
    this.agentId = "";
    this.projectId = "";
    this.title = "";
    this.submitting = false;
  }
  connectedCallback() {
    super.connectedCallback();
    const pf = this.prefill || {};
    Promise.all([api("/api/agents"), api("/api/projects")]).then(([a, p]) => {
      this.agents = a.filter(x => x.enabled);
      this.projects = p;
      if (pf.agent && this.agents.some(x => String(x.id) === String(pf.agent))) this.agentId = String(pf.agent);
      else if (this.agents.length) this.agentId = String(this.agents[0].id);
      if (pf.project && this.projects.some(x => String(x.id) === String(pf.project))) this.projectId = String(pf.project);
      else if (this.projects.length) this.projectId = String(this.projects[0].id);
      this.title = pf.title || "";
      this.requestUpdate();
    }).catch(() => {});
  }
  async submit() {
    if (!this.agentId || !this.title.trim()) { toastErr("请填写角色与标题"); return; }
    this.submitting = true;
    try {
      const ss = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          agent_id: Number(this.agentId),
          project_id: this.projectId ? Number(this.projectId) : null,
          title: this.title.trim(),
        }),
      });
      this.dispatchEvent(new CustomEvent("created", { detail: ss.id, bubbles: true, composed: true }));
    } catch (e) { toastErr(`创建失败: ${e.message || e}`); }
    this.submitting = false;
  }
  render() {
    const proj = this.projects.find(p => String(p.id) === this.projectId);
    return html`
      <div class="box" @click=${(e) => e.stopPropagation()}>
        <h3>新建会话</h3>
        <label>标题 <input .value=${this.title} @input=${(e) => this.title = e.target.value} placeholder="例如：修复登录失败" @keydown=${(e) => e.key === "Enter" && !e.isComposing && this.submit()}></label>
        <label>角色
          <select .value=${this.agentId} @change=${(e) => this.agentId = e.target.value}>
            ${this.agents.map(a => html`<option value=${a.id}>${a.name}（${a.cli}）</option>`)}
          </select>
        </label>
        <label>项目
          <select .value=${this.projectId} @change=${(e) => this.projectId = e.target.value}>
            <option value="">（无项目）</option>
            ${this.projects.map(p => html`<option value=${p.id}>${p.name}</option>`)}
          </select>
        </label>
        ${proj && proj.is_git ? html`<div class="hint">git 项目：将创建独立 worktree（paihuo/session-N），与任务隔离互不冲突。</div>` : ""}
        <div class="row">
          <button @click=${() => this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }))}>取消</button>
          <button class="primary" @click=${this.submit}>${this.submitting ? "创建中…" : "创建会话"}</button>
        </div>
      </div>`;
  }
}
customElements.define("ph-session-create", PhSessionCreate);

// ---------------------------------------------------------------- 组件：会话视图
export class PhSessionView extends LitElement {
  static styles = css`
    ${PW}
    :host { display: flex; flex-direction: column; height: 100%; background: var(--pw-bg); color: var(--pw-text); }
    .pw-empty { margin: auto; color: var(--pw-muted); font-size: 14px; }
  `;
  static properties = { sessionId: { attribute: false } };
  constructor() {
    super();
    // SSE 事件 → 强制重渲染。entries 是全局 store 原地变更，属性引用不变，
    // 仅靠属性绑定不会触发子组件刷新（lit 默认 === 比较）。
    this._onLive = () => this.requestUpdate();
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("ph-session-message", this._onLive);
    window.addEventListener("ph-session-updated", this._onLive);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("ph-session-message", this._onLive);
    window.removeEventListener("ph-session-updated", this._onLive);
  }
  render() {
    const st = sessionState;
    const ss = st.detail;
    if (!ss) return html`<div class="pw-empty">加载中…</div>`;
    const isPi = (ss.cli || "") === "pi";
    return html`
      <ph-session-header .session=${ss} .live=${st.live} .running=${st.agentRunning}></ph-session-header>
      ${isPi
        ? html`<ph-message-stream .sessionId=${this.sessionId} .entries=${st.entries}></ph-message-stream>
             <ph-session-input .session=${ss} .running=${st.agentRunning} @refresh=${() => this.requestUpdate()}></ph-session-input>`
        : html`<ph-session-term .session=${ss}></ph-session-term>`}
    `;
  }
}
customElements.define("ph-session-view", PhSessionView);

// ---------------------------------------------------------------- 组件：会话头部（pi-web workspace-header）
export class PhSessionHeader extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 0 0 auto; border-bottom: 1px solid var(--pw-border); background: var(--pw-bg); }
    .strip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex-wrap: wrap; }
    .title { font-weight: 700; font-size: 14px; color: var(--pw-text); display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 11px; border-radius: 999px; padding: 2px 10px; font-weight: 600; border: 1px solid var(--pw-border); color: var(--pw-text-secondary); flex: 0 0 auto; }
    .badge.running { border-color: var(--pw-success-border); background: var(--pw-success-surface); color: var(--pw-success); }
    .badge.suspended { color: var(--pw-dim); }
    .badge.delivered { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); color: var(--pw-accent); }
    .badge.created { color: var(--pw-muted); }
    .meta { color: var(--pw-muted); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
    .meta .cli { border: 1px solid var(--pw-border); border-radius: 4px; padding: 0 5px; font-size: 10px; font-weight: 700; }
    .spacer { flex: 1; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pw-border); border-radius: 7px; background: var(--pw-surface); color: var(--pw-text); padding: 5px 10px; cursor: pointer; font-size: 12.5px; }
    button:hover { background: var(--pw-surface-hover); }
    button.primary { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); color: var(--pw-accent); }
    button.danger { color: var(--pw-danger); border-color: var(--pw-danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .link { color: var(--pw-accent); font-size: 12.5px; text-decoration: none; }
    .link:hover { text-decoration: underline; }
  `;
  static properties = { session: { attribute: false }, live: { attribute: false }, running: { attribute: false } };
  async act(action) {
    const id = this.session.id;
    try {
      if (action === "start") await api(`/api/sessions/${id}/start`, { method: "POST" });
      else if (action === "suspend") await api(`/api/sessions/${id}/suspend`, { method: "POST" });
      else if (action === "resume") await api(`/api/sessions/${id}/resume`, { method: "POST" });
      else if (action === "delete") {
        if (!confirm("丢弃该会话？（worktree 将被清理）")) return;
        await api(`/api/sessions/${id}`, { method: "DELETE" });
        this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
      } else if (action === "deliver") {
        const title = prompt("任务标题（默认使用会话标题）：", this.session.title);
        if (title === null) return;
        const perm = confirm("审批后合并？【确定=审批模式 / 取消=自动合并】") ? "review" : "full";
        const tk = await api(`/api/sessions/${id}/deliver`, { method: "POST", body: JSON.stringify({ task_title: title, perm }) });
        location.hash = `#/issue/${tk.id}`;
        location.reload();
        return;
      }
      window.dispatchEvent(new CustomEvent("ph-session-updated"));
      this.requestUpdate();
      window.dispatchEvent(new CustomEvent("ph-session-detail-refresh", { detail: id }));
      setTimeout(() => window.dispatchEvent(new CustomEvent("ph-session-updated")), 400);
    } catch (e) { toastErr(e.message || String(e)); }
  }
  render() {
    const s = this.session;
    const running = this.running;
    const statusCls = running && s.status === "active" ? "running" : s.status;
    const statusText = running && s.status === "active" ? "思考中" : STATUS_LABEL[s.status] || s.status;
    return html`
      <div class="strip">
        <div class="title">
          <span class="badge ${statusCls}">${statusText}</span>
          <span class="title-text">${s.title}</span>
        </div>
        <div class="meta">
          <span class="cli">${s.cli}</span>
          <span>${s.agent_name}</span>
          ${s.project_name ? html`<span>·</span><span>${s.project_name}</span>` : ""}
          ${this.live && this.live.model ? html`<span>·</span><span title="当前模型">${this.live.model.id || ""}</span>` : ""}
          ${this.live && this.live.thinkingLevel ? html`<span>·</span><span>思考:${this.live.thinkingLevel}</span>` : ""}
        </div>
        <span class="spacer"></span>
        ${s.status === "created" ? html`<button class="primary" @click=${() => this.act("start")}>启动</button><button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s.status === "active" ? html`
          ${running ? html`<button @click=${() => this.act("abort")}>中止</button>` : ""}
          <button @click=${() => this.act("suspend")}>挂起</button>
          <button class="primary" @click=${() => this.act("deliver")}>交付</button>` : ""}
        ${s.status === "suspended" ? html`
          <button class="primary" @click=${() => this.act("resume")}>恢复</button>
          <button @click=${() => this.act("deliver")}>交付</button>
          <button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s.status === "delivered" ? html`
          ${s.task_id ? html`<a class="link" href="#/issue/${s.task_id}">查看任务 #${s.task_id} →</a>` : ""}` : ""}
      </div>`;
  }
}
customElements.define("ph-session-header", PhSessionHeader);

// ---------------------------------------------------------------- 组件：消息流（pi-web chat）
export class PhMessageStream extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .chat { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; padding: 26px 16px 64px; box-sizing: border-box; }
    .pw-empty { margin: 60px auto; max-width: 420px; color: var(--pw-muted); text-align: center; font-size: 14px; line-height: 1.8; }
    .page-bar { flex: 0 0 auto; display: flex; justify-content: center; gap: 8px; align-items: center; padding: 6px; font-size: 11.5px; color: var(--pw-dim); border-top: 1px solid var(--pw-border-muted); }
    .page-bar button { border: 1px solid var(--pw-border); border-radius: 7px; background: var(--pw-surface); color: var(--pw-text-secondary); padding: 3px 10px; cursor: pointer; font-size: 11.5px; }
    .page-bar button:hover { background: var(--pw-surface-hover); }
  `;
  static properties = { entries: { attribute: false }, sessionId: { attribute: false } };
  constructor() {
    super();
    this.entries = [];
    this.sessionId = null;
    this._atBottom = true;
    this._loadingOlder = false;
    // SSE 事件 → 强制重渲染（entries 原地变更，属性引用不变）
    this._onLive = () => this.requestUpdate();
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("ph-session-message", this._onLive);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("ph-session-message", this._onLive);
  }
  willUpdate(ch) {
    if (ch.has("sessionId")) this._atBottom = true; // 切换会话后回到底部
  }
  updated() {
    if (this._atBottom) {
      // ph-msg-* 子组件的 shadow 内容在本组件 updated 之后才异步渲染完，
      // 此时 scrollHeight 还没长全；推迟到下一帧再滚，否则底部会被截断。
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = requestAnimationFrame(() => this.scrollToBottom());
    }
  }
  scrollToBottom() {
    // 滚动容器是 .chat，不是 host（host 无 overflow，设置 scrollTop 无效）
    const chat = this.renderRoot.querySelector(".chat");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }
  onScroll(e) {
    const chat = e.currentTarget;
    this._atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    // 滚到顶部加载更早（pi-web：Scroll up to load earlier messages）
    if (chat.scrollTop <= 40 && !this._loadingOlder && this._hasOlder()) {
      this._loadingOlder = true;
      const prevHeight = chat.scrollHeight;
      // 等待页面合并后修正滚动位置
      setTimeout(() => {
        const page = document.querySelector("ph-sessions-page");
        page.loadEarlier().then(() => {
          chat.scrollTop = chat.scrollHeight - prevHeight + 40;
          this._loadingOlder = false;
        });
      }, 50);
    }
  }
  _hasOlder() {
    const st = sessionState;
    return st.transcriptLoaded < st.transcriptTotal;
  }
  render() {
    if (!this.entries.length) {
      return html`<div class="chat"><div class="pw-empty">还没有消息。在下方输入第一条指令，开始与 agent 协作。<br>完成后可点「交付」转为任务，走审批 → 合并流程。</div></div>`;
    }
    const st = sessionState;
    const from = st.transcriptTotal - st.transcriptLoaded + 1;
    const bar = st.transcriptTotal > 100 ? html`<div class="page-bar">
      <span>Showing ${Math.max(from, 1)}–${st.transcriptTotal} of ${st.transcriptTotal}</span>
      ${this._hasOlder() ? html`<button @click=${() => this.scrollTop = 0}>↑ 加载更早</button>` : ""}
    </div>` : "";
    return html`
      <div class="chat" @scroll=${this.onScroll}>${this.entries.map((it, i) => renderItem(it, i))}</div>
      ${bar}`;
  }
}
customElements.define("ph-message-stream", PhMessageStream);

function renderItem(it, key) {
  switch (it.kind) {
    case "user": return html`<ph-msg-user .msg=${it.msg}></ph-msg-user>`;
    case "assistant": return html`<ph-msg-assistant .msg=${it.msg} .toolLive=${it.toolLive} .toolResults=${it.toolResults} .streaming=${it.streaming}></ph-msg-assistant>`;
    case "bash": return html`<ph-msg-bash .msg=${it.msg}></ph-msg-bash>`;
    case "custom": return html`<ph-msg-custom .msg=${it.msg}></ph-msg-custom>`;
    case "ev-model": return html`<div class="pw-event">🔄 模型切换 → ${it.provider}/${it.modelId}</div>`;
    case "ev-thinking": return html`<div class="pw-event">💭 思考级别 → ${it.level}</div>`;
    case "ev-compaction": return html`<div class="pw-event" title=${it.summary || ""}>🧹 上下文已压缩（-${it.tokensBefore || "?"} tokens）</div>`;
    case "ev-branch": return html`<div class="pw-event">🌿 分支摘要${it.summary ? `: ${it.summary.slice(0, 60)}` : ""}</div>`;
    default: return nothing;
  }
}

// pi-web .msg 消息卡片样式
const msgStyles = css`
  ${PW}
  :host { display: block; max-width: 100%; min-width: 0; }
  .msg { max-width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pw-border); border-radius: 10px; background: var(--pw-surface); overflow: visible; color: var(--pw-text); font-size: 14px; line-height: 1.6; }
  .msg.user { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); }
  .msg.streaming { border-color: var(--pw-success-border); box-shadow: 0 0 0 1px var(--pw-success-ring); }
  .msg-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; margin-bottom: 8px; }
  .msg-header .who { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; color: var(--pw-text-secondary); }
  .msg-header .when { color: var(--pw-dim); font-size: 11.5px; }
  .msg.user .msg-header .who { color: var(--pw-accent); }
  .msg .ph-md :is(p, ul, ol) { margin: 4px 0; }
  .msg .ph-md h1, .msg .ph-md h2, .msg .ph-md h3, .msg .ph-md h4 { font-size: 14.5px; margin: 8px 0 4px; }
  .msg .ph-md blockquote { border-left: 3px solid var(--pw-border); margin: 4px 0; padding-left: 8px; color: var(--pw-muted); }
  .msg .ph-md code { background: var(--pw-surface-hover); border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
  .msg .ph-md a { color: var(--pw-accent); }
  .ph-code { background: var(--pw-terminal-bg); color: var(--pw-text-secondary); border: 1px solid var(--pw-border-muted); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
  .ph-md pre { margin: 6px 0; }
  .thinking { border: 1px solid var(--pw-purple-border); background: var(--pw-purple-surface); border-radius: 8px; padding: 6px 10px; margin: 6px 0; font-size: 13px; color: var(--pw-purple); }
  .thinking summary { cursor: pointer; font-weight: 600; }
  .usage { font-size: 11.5px; color: var(--pw-dim); margin-top: 4px; }
  .stop-aborted { color: var(--pw-danger); font-size: 11.5px; }
  .pw-event { text-align: center; font-size: 11.5px; color: var(--pw-dim); padding: 10px 0; }
`;

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class PhMsgUser extends LitElement {
  static styles = msgStyles;
  static properties = { msg: { attribute: false } };
  render() {
    const m = this.msg || {};
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    return html`<div class="msg user">
      <div class="msg-header"><span class="who">你</span><span class="when">${fmtTime(m.timestamp)}</span></div>
      <div class="ph-md">${blocks.map(b => b.type === "image"
        ? html`<img src=${`data:${b.mimeType || "image/png"};base64,${b.data}`} style="max-width:200px;border-radius:8px">`
        : html`<div>${md(b.text || "")}</div>`)}</div>
    </div>`;
  }
}
customElements.define("ph-msg-user", PhMsgUser);

class PhMsgAssistant extends LitElement {
  static styles = [msgStyles, css`
    .events { border: 1px solid var(--pw-border); border-radius: 8px; margin: 8px 0 4px; overflow: hidden; }
    .events summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; color: var(--pw-muted); background: var(--pw-bg); user-select: none; }
    .events summary:hover { background: var(--pw-surface-hover); color: var(--pw-text-secondary); }
    .events[open] summary { border-bottom: 1px solid var(--pw-border); }
    .events .count { font-weight: 700; }
    .events-body { padding: 6px 8px; background: var(--pw-bg); }
  `];
  static properties = { msg: { attribute: false }, toolLive: { attribute: false }, toolResults: { attribute: false }, streaming: { attribute: false } };
  render() {
    const m = this.msg || {};
    const streaming = this.streaming || m.stopReason === "pending";
    const blocks = Array.isArray(m.content) ? m.content : [];
    const texts = [], tools = [];
    for (const b of blocks) {
      if (b.type === "text") texts.push(md(b.text || ""));
      else if (b.type === "thinking") texts.push(html`<details class="thinking"><summary>💭 思考（${(b.thinking || "").length} 字）</summary><div class="ph-md">${md(b.thinking)}</div></details>`);
      else if (b.type === "toolCall") tools.push(b);
    }
    const model = m.model || "";
    const toolResults = this.toolResults;
    // pi-web 结构：工具调用折叠在 events 区（"N events · M tool"），默认折叠。
    const events = tools.length
      ? html`<details class="events" ${streaming ? "open" : ""}>
          <summary><span>▸ events</span><span class="count">${tools.length} tool</span></summary>
          <div class="events-body">${tools.map(t => html`<ph-tool-card .call=${t} .result=${(toolResults && toolResults.get(t.id)) || null}></ph-tool-card>`)}</div>
        </details>`
      : "";
    return html`<div class="msg assistant ${streaming ? "streaming" : ""}">
      <div class="msg-header">
        <span class="who">${model ? model.split("/").pop() : "Agent"}${streaming ? html`<span style="color:var(--pw-success);font-weight:400">…</span>` : ""}</span>
        <span class="when">${fmtTime(m.timestamp)}${m.stopReason === "aborted" ? html`<span class="stop-aborted"> · 已中止</span>` : ""}</span>
      </div>
      <div class="ph-md">${texts}</div>
      ${events}
      ${m.usage ? html`<div class="usage">tokens: ${m.usage.totalTokens || 0}${m.usage.cost ? ` · $${m.usage.cost.total || 0}` : ""}</div>` : ""}
    </div>`;
  }
}
customElements.define("ph-msg-assistant", PhMsgAssistant);

class PhMsgBash extends LitElement {
  static styles = css`
    ${PW}
    :host { display: block; margin: 0 0 14px; }
    .bash { border: 1px solid var(--pw-border); border-radius: 10px; background: var(--pw-terminal-bg); color: var(--pw-text-secondary); font-family: ui-monospace, monospace; font-size: 12.5px; overflow: hidden; }
    .cmd { padding: 9px 12px; color: var(--pw-text); border-bottom: 1px solid var(--pw-border-muted); }
    .cmd .prompt { color: var(--pw-success); }
    .out { padding: 9px 12px; white-space: pre-wrap; max-height: 320px; overflow-y: auto; color: var(--pw-text-secondary); }
    .code { padding: 0 12px 9px; font-size: 11.5px; display: flex; gap: 8px; align-items: center; }
    .ok { color: var(--pw-success); } .err { color: var(--pw-danger); }
  `;
  static properties = { msg: { attribute: false } };
  render() {
    const m = this.msg || {};
    const err = m.isError || (m.exitCode !== undefined && m.exitCode !== null && m.exitCode !== 0);
    return html`<div class="bash">
      <div class="cmd"><span class="prompt">$ </span>${m.command || ""}</div>
      ${m.output ? html`<div class="out">${m.output}</div>` : ""}
      <div class="code"><span class="${err ? "err" : "ok"}">${err ? "✗ 失败" : "✓ 成功"}</span>${m.exitCode !== undefined && m.exitCode !== null ? ` · exit ${m.exitCode}` : ""}${m.truncated ? " · 已截断" : ""}</div>
    </div>`;
  }
}
customElements.define("ph-msg-bash", PhMsgBash);

class PhMsgCustom extends LitElement {
  static styles = css`
    ${PW}
    :host { display: block; margin: 0 0 14px; }
    .box { border: 1px solid var(--pw-purple-border); border-radius: 10px; padding: 8px 12px; font-size: 13px; background: var(--pw-purple-surface); color: var(--pw-text); }
    .t { font-weight: 700; color: var(--pw-purple); font-size: 11px; margin-bottom: 4px; }
  `;
  static properties = { msg: { attribute: false } };
  render() {
    const m = this.msg || {};
    return html`<div class="box"><div class="t">${m.customType || "custom"}</div><div class="ph-md">${md(typeof m.content === "string" ? m.content : "")}</div></div>`;
  }
}
customElements.define("ph-msg-custom", PhMsgCustom);

// pi-web .tool-card 工具卡片
class PhToolCard extends LitElement {
  static styles = css`
    ${PW}
    :host { display: block; width: 100%; max-width: 100%; min-width: 0; color: var(--pw-text); margin: 8px 0; }
    .tool-card { display: grid; gap: 8px; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-bg); padding: 9px; color: var(--pw-text); }
    .tool-card.success { border-color: var(--pw-success-border); background: var(--pw-success-bg); }
    .tool-card.error { border-color: var(--pw-danger); background: color-mix(in srgb, var(--pw-danger) 10%, var(--pw-bg)); }
    .tool-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; cursor: pointer; }
    .tool-title { flex: 1 1 auto; display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
    .status-icon { flex: 0 0 auto; color: var(--pw-muted); }
    .tool-title strong { flex: 0 0 auto; color: var(--pw-text); font-size: 13px; }
    .target { display: block; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pw-muted); font-size: 12.5px; font-family: ui-monospace, monospace; }
    .tool-meta { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; color: var(--pw-dim); font-size: 11.5px; }
    .tool-meta .ok { color: var(--pw-success); } .tool-meta .err { color: var(--pw-danger); }
    .body { border-top: 1px solid var(--pw-border-muted); padding-top: 8px; max-height: 320px; overflow-y: auto; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; color: var(--pw-text-secondary); }
  `;
  static properties = { call: { attribute: false }, result: { attribute: false }, open: { state: true } };
  constructor() { super(); this.open = false; }
  render() {
    const t = this.call || {};
    const r = this.result;
    const name = toolName(t);
    const arg = toolArg(name, t.arguments);
    const isErr = r && r.isError;
    const status = isErr ? "error" : "success";
    const icon = isErr ? "✗" : "✓";
    const body = r ? (Array.isArray(r.content) ? r.content.map(c => c.text || "").join("\n") : String(r.content || "")) : "";
    return html`
      <div class="tool-card ${status}">
        <div class="tool-header" @click=${() => this.open = !this.open}>
          <div class="tool-title">
            <span class="status-icon">${this.open ? "▾" : "▸"}</span>
            <strong>${name}</strong>
            ${arg ? html`<span class="target">${arg}</span>` : ""}
          </div>
          <div class="tool-meta"><span class="${isErr ? "err" : "ok"}">${icon}</span>${body ? (this.open ? "收起" : "展开") : ""}</div>
        </div>
        ${this.open && body !== "" ? html`<div class="body">${body}</div>` : ""}
      </div>`;
  }
}
customElements.define("ph-tool-card", PhToolCard);

// ---------------------------------------------------------------- 组件：终端式会话面板（S5）
export class PhSessionTerm extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; gap: 8px; background: var(--pw-bg); }
    .bar { font-size: 12px; color: var(--pw-muted); display: flex; align-items: center; gap: 8px; }
    .term-wrap { flex: 1; min-height: 240px; border: 1px solid var(--pw-border); border-radius: 10px; overflow: hidden; padding: 6px; background: var(--pw-terminal-bg); }
    .tip { font-size: 12px; color: var(--pw-dim); }
  `;
  static properties = { session: { attribute: false } };
  constructor() {
    super();
    this._term = null;
    this._fit = null;
    this._timer = null;
    this._dead = false;
  }
  connectedCallback() {
    super.connectedCallback();
    this._init();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._resizeTimer) clearInterval(this._resizeTimer);
    if (this._term) { try { this._term.dispose(); } catch (_) {} }
    this._term = null;
  }
  async _init() {
    const id = this.session.id;
    const wrap = this.shadowRoot.querySelector(".term-wrap");
    if (!wrap || !globalThis.Terminal) return;
    this._term = new Terminal({ fontSize: 13, fontFamily: "ui-monospace, monospace", theme: { background: "#05070a", foreground: "#e6edf3", cursor: "#58a6ff" }, scrollback: 5000 });
    if (globalThis.FitAddon) {
      this._fit = new globalThis.FitAddon.FitAddon();
      this._term.loadAddon(this._fit);
    }
    this._term.open(wrap);
    if (this._fit) this._fit.fit();
    this._term.onData((data) => {
      api(`/api/sessions/${id}/terminal/input`, { method: "POST", body: JSON.stringify({ text: data, raw: true }) }).catch(() => {});
    });
    if (this._fit) {
      const fit = this._fit;
      const pushResize = () => {
        if (this._term && !this._dead) {
          api(`/api/sessions/${id}/terminal/resize`, { method: "POST", body: JSON.stringify({ cols: this._term.cols, rows: this._term.rows }) }).catch(() => {});
        }
      };
      try { fit.fit(); pushResize(); } catch (_) {}
      this._resizeTimer = setInterval(() => {
        try { fit.fit(); pushResize(); } catch (_) {}
      }, 3000);
    }
    this._timer = setInterval(async () => {
      try {
        const r = await api(`/api/sessions/${id}/terminal/output`);
        if (r.output) this._term.write(r.output);
        if (r.alive === false) { this._dead = true; if (this._timer) clearInterval(this._timer); }
      } catch (_) {}
    }, 700);
  }
  render() {
    const s = this.session;
    return html`
      <div class="bar">终端式会话（${s.cli}）· 输出由 tmux 实时捕获</div>
      <div class="term-wrap"></div>
      <div class="tip">点击终端直接输入 · 输入 /exit 退出 · 挂起后恢复将重建窗口</div>
    `;
  }
}
customElements.define("ph-session-term", PhSessionTerm);

// ---------------------------------------------------------------- 组件：输入区（pi-web prompt-editor footer）
export class PhSessionInput extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 0 0 auto; color: var(--pw-text); font: 14px system-ui, sans-serif; }
    footer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 12px; border-top: 1px solid var(--pw-border); }
    footer.shell-mode { border-top-color: var(--pw-success); background: var(--pw-success-bg); }
    textarea { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow-y: auto; border-radius: 8px; border: 1px solid var(--pw-border); background: var(--pw-bg); color: var(--pw-text); font: 15px/1.4 system-ui, sans-serif; padding: 8px 10px; }
    textarea:focus { outline: none; border-color: var(--pw-accent-border); }
    .shell-mode textarea { border-color: var(--pw-success); box-shadow: 0 0 0 1px var(--pw-success-ring); }
    textarea:disabled { opacity: .5; cursor: not-allowed; }
    .hint { font-size: 12px; color: var(--pw-dim); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mode { display: flex; border: 1px solid var(--pw-border); border-radius: 7px; overflow: hidden; }
    .mode span { padding: 3px 9px; font-size: 11.5px; cursor: pointer; color: var(--pw-muted); }
    .mode span.on { background: var(--pw-selection-bg); color: var(--pw-accent); }
    .mode-hint { border: 1px solid var(--pw-success-border); border-radius: 999px; background: var(--pw-success-surface); color: var(--pw-success); padding: 2px 9px; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: flex-end; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-surface); color: var(--pw-text); padding: 7px 12px; cursor: pointer; font-size: 13px; }
    button:hover { background: var(--pw-surface-hover); }
    button.primary { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); color: var(--pw-accent); font-weight: 600; }
    button.primary:hover { background: var(--pw-accent-border); color: #fff; }
    button.danger { color: var(--pw-danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
  static properties = { session: { attribute: false }, running: { attribute: false }, value: { state: true }, mode: { state: true } };
  constructor() {
    super();
    this.value = "";
    this.mode = "steer";
  }
  _send() {
    const msg = this.value.trim();
    if (!msg) return;
    const id = this.session.id;
    const body = { message: msg };
    if (this.running) body.streaming_behavior = this.mode === "followUp" ? "followUp" : "steer";
    api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify(body) })
      .then(() => {
        this.value = "";
        this.requestUpdate();
        // pi RPC 流不为 user 消息发事件：发送成功后立即回显，避免“发了没反应”。
        window.dispatchEvent(new CustomEvent("ph-session-message", {
          detail: {
            session_id: id,
            event: {
              type: "user_echo",
              message: { role: "user", content: [{ type: "text", text: msg }], timestamp: Date.now() },
            },
          },
        }));
        this.dispatchEvent(new CustomEvent("refresh", { bubbles: true, composed: true }));
      })
      .catch(e => toastErr(e.message || String(e)));
  }
  _abort() {
    api(`/api/sessions/${this.session.id}/abort`, { method: "POST" })
      .then(() => window.dispatchEvent(new CustomEvent("ph-session-updated")))
      .catch(e => toastErr(e.message || String(e)));
  }
  render() {
    const s = this.session;
    const disabled = s.status === "delivered" || s.status === "deleted" || s.status === "created";
    const shellMode = this.running && s.status === "active";
    const hint =
      s.status === "delivered" ? "已交付为任务，会话冻结（只读）" :
      s.status === "created" ? "点击「启动」开始会话" :
      s.status === "suspended" ? "会话已挂起，点击「恢复」继续对话" :
      shellMode ? "agent 正在处理…" :
      "Enter 发送 · Shift+Enter 换行";
    return html`
      <footer class=${shellMode ? "shell-mode" : ""}>
        ${shellMode ? html`<div class="hint">
          <span class="mode">
            <span class=${this.mode === "steer" ? "on" : ""} @click=${() => this.mode = "steer"}>插入</span>
            <span class=${this.mode === "followUp" ? "on" : ""} @click=${() => this.mode = "followUp"}>排队</span>
          </span>
          <span class="mode-hint">运行中 · 消息将排队</span>
          <span class="spacer"></span>
          <button class="danger" @click=${this._abort}>■ 中止</button>
        </div>` : html`<div class="hint">${hint}</div>`}
        <div class="row">
          <textarea .value=${this.value} ?disabled=${disabled} @input=${(e) => this.value = e.target.value}
            @keydown=${(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this._send(); } }}
            placeholder=${disabled ? hint : "输入指令，与 agent 协作…"}></textarea>
          <button class="primary" ?disabled=${disabled || !this.value.trim()} @click=${this._send} title="发送 (Enter)">↑ 发送</button>
        </div>
      </footer>`;
  }
}
customElements.define("ph-session-input", PhSessionInput);

// ---------------------------------------------------------------- 工具
export function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}
