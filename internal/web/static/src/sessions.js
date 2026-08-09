// 会话页面（S-2/S-3）：lit 组件实现，UI 并入全站设计系统（Carbon lattice v4）。
// 结构保留 pi-web 的成熟模式：.msg 卡片（吸顶 header/label/meta）、
// tool-execution-view 状态工具卡片、prompt-editor 输入区（shell-mode 运行中态）；
// 视觉 token 全部经 PW 别名映射到 app.css 全局变量（b7de0d6 的 pi-web-dark
// 独立调色板已废弃），一处改动全站生效。
// 数据源：全量 = GET /api/sessions/{id}/transcript（pi 会话 JSONL 解析）；
// 增量 = SSE session.message 事件（RPC 事件流透传）。
import { LitElement, html, css, nothing } from "lit";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ref } from "lit/directives/ref.js";
import { api, toast } from "./core.js";

// ---------------------------------------------------------------- 会话页设计 token
// 会话页与全站共用同一套设计系统（app.css 根变量 Carbon lattice v4）：
// 本层把组件内使用的 --pw-* 语义别名映射到全局 token，主题变化一处生效。
// 自 pi-web 复刻版（b7de0d6）起，配色从 pi-web-dark（#070912/#7c3cff）切换为
// 全站调色板（碳色背景 + lime→mint 品牌渐变 + 状态语义色）。
export const PW = css`
  :host {
  --pw-bg: var(--bg-page);
  --pw-surface: var(--surface);
  --pw-surface-hover: var(--hover);
  --pw-terminal-bg: var(--inset);
  --pw-terminal-text: var(--fg);
  --pw-border: var(--border);
  --pw-border-muted: var(--border);
  --pw-text: var(--fg);
  --pw-text-secondary: var(--fg-muted);
  --pw-text-bright: var(--fg);
  --pw-muted: var(--fg-muted);
  --pw-dim: var(--fg-faint);
  --pw-accent: var(--brand);
  --pw-accent-border: rgba(199, 243, 106, .38);
  --pw-selection-bg: var(--brand-dim);
  --pw-success: var(--success);
  --pw-success-border: var(--success);
  --pw-success-bg: rgba(121, 220, 164, .07);
  --pw-success-surface: rgba(121, 220, 164, .14);
  --pw-success-ring: rgba(121, 220, 164, .38);
  --pw-warning: var(--warning);
  --pw-warning-border: var(--warning);
  --pw-warning-surface: rgba(237, 195, 111, .08);
  --pw-danger: var(--danger);
  --pw-purple: var(--merge-accent);
  --pw-purple-border: rgba(185, 162, 241, .42);
  --pw-purple-surface: rgba(185, 162, 241, .09);
  --pw-overlay: var(--dialog-overlay);
  --pw-shadow-soft: rgba(0, 0, 0, .42);
  --pw-shadow: rgba(0, 0, 0, .55);
  --pw-shadow-strong: rgba(0, 0, 0, .7);
  --pw-bg-overlay: rgba(8, 11, 9, .78);
  --pw-success-bg-overlay: rgba(14, 29, 20, .86);
  }
`;

const STATUS_DOT = { created: "○", active: "◉", suspended: "○", delivered: "✓", deleted: "✕" };
const STATUS_LABEL = {
  created: "未启动", active: "活跃", suspended: "已挂起",
  delivered: "已交付", deleted: "已删除",
};

// ---------------------------------------------------------------- markdown 渲染
// OMP 的回答大量使用 GFM 表格、有序/嵌套列表和任务列表。旧的正则版
// “轻量 markdown”会产生游离在 <ul> 外的 <li>，也不识别表格和段落。
// 这里用 marked 按 GFM 解析，再用 DOMPurify 的显式白名单清洗后才交给 unsafeHTML。
const MD_ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "input", "kbd", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul",
];
const MD_ALLOWED_ATTR = [
  "aria-hidden", "aria-label", "checked", "class", "disabled", "href", "rel", "start", "target",
  "title", "type",
];

function safeMarkdownHref(raw) {
  const url = String(raw || "").trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return "#";
  if (/^(?:https?:|mailto:|#|\/(?!\/)|\.{1,2}\/)/i.test(url)) return url;
  // 无 scheme 的文档相对路径（例如 docs/guide.md）可用；//host 和其它
  // scheme 不允许，避免 javascript:/data:/file: 等协议注入。
  if (!/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith("//")) return url;
  return "#";
}

export function md(src) {
  if (!src) return "";
  // marked 文档特别指出文本开头的零宽字符会干扰块级语法。
  const source = String(src).replace(/^[\u200b-\u200f\ufeff]+/, "");
  const rendered = marked.parse(source, { async: false, breaks: false, gfm: true });
  const fragment = DOMPurify.sanitize(String(rendered), {
    ALLOWED_ATTR: MD_ALLOWED_ATTR,
    ALLOWED_TAGS: MD_ALLOWED_TAGS,
    RETURN_DOM_FRAGMENT: true,
  });

  // DOMPurify 先剔除事件属性/危险协议，再把链接收窄到产品明确支持的
  // http(s)/mailto/锚点/相对路径，并统一新窗口的隔离属性。
  for (const link of fragment.querySelectorAll("a")) {
    link.setAttribute("href", safeMarkdownHref(link.getAttribute("href")));
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }

  // 复制按钮在清洗之后由本地代码创建，不将消息原文里的 button/div
  // 放入白名单。同时兼容 fenced code 与缩进 code。
  for (const pre of [...fragment.querySelectorAll("pre")]) {
    const code = pre.querySelector("code");
    const languageClass = [...(code && code.classList || [])].find(name => name.startsWith("language-"));
    if (languageClass) code.dataset.lang = languageClass.slice("language-".length);
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy-button";
    button.title = "复制代码块";
    button.setAttribute("aria-label", "复制代码块");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⧉";
    button.append(icon);
    pre.replaceWith(wrapper);
    wrapper.append(pre, button);
  }

  const box = document.createElement("div");
  box.append(fragment);
  return box.innerHTML;
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
// transcript 分页大小（首屏尾部一页 + 向上滚动逐页加载）。
const TRANSCRIPT_PAGE = 100;

export const sessionState = {
  list: [],
  selectedId: null,
  detail: null,
  entries: [],
  live: null,
  agentRunning: false,
  sending: false, // 提示发送中 → 尚未收到 message_start（activity-dock 显示）
  pending: null,
  loading: false,
  filter: "all",
  projectFilter: "",
  transcriptTotal: 0,
  transcriptLoaded: 0,
  transcriptExhausted: false, // 已翻到会话开头（再往前没有可渲染条目）
  _firstEntryId: "",
};

// ---------------------------------------------------------------- 组件：会话页面
export class PhSessionsPage extends LitElement {
  static styles = css`
    ${PW}
    :host {
      flex: 1; min-height: 0; /* 铺满 .page-content，与其他页面同构 */
      display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 0;
      background: var(--bg-page); color: var(--pw-text);
      font: 13px/1.45 var(--font-sans);
    }
    .col-list { border-right: 1px solid var(--pw-border); min-height: 0; background: var(--bg-page); }
    .col-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg-page); }
    .pw-empty { margin: auto; color: var(--pw-muted); font-size: 14px; }
    @media (max-width: 860px) {
      :host { grid-template-columns: 1fr; grid-template-rows: 1fr; height: 100%; min-height: 0; }
      /* 移动端 master-detail：未选中只显示会话列表（全高可滚动），
         选中后只显示聊天（返回按钮在会话头部）。 */
      .col-list { border-right: 0; border-bottom: 0; min-height: 0; overflow: hidden; }
      .col-main { display: none; height: 100%; }
      :host(.detail-open) .col-list { display: none; }
      :host(.detail-open) .col-main { display: flex; }
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
    if (q.has("agent") || q.has("project") || q.has("title") || q.has("body")) {
      this.prefill = {
        agent: q.get("agent") || "", project: q.get("project") || "",
        title: q.get("title") || "", body: q.get("body") || "",
      };
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
    sessionState.transcriptExhausted = false;
    this.requestUpdate();
    await this._loadDetail(id);
  }

  async _loadDetail(id) {
    try {
      const ss = await api(`/api/sessions/${id}`);
      sessionState.detail = ss;
      const tr = await api(`/api/sessions/${id}/transcript?limit=${TRANSCRIPT_PAGE}`);
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
  // 游标 = 当前最早条目的 entry id（pi 会话 entry 有唯一 id）。
  async loadEarlier() {
    const id = sessionState.detail?.id;
    if (!id || !sessionState.entries.length) return 0;
    const before = sessionState.entries[0]?._id || "";
    if (!before) return 0;
    try {
      const tr = await api(`/api/sessions/${id}/transcript?limit=${TRANSCRIPT_PAGE}&before=${encodeURIComponent(before)}`);
      const raw = (tr && tr.entries) ? tr.entries : [];
      const older = buildRenderItems(raw);
      const prevLen = sessionState.entries.length;
      const known = new Set(sessionState.entries.map(e => e._id));
      const merged = [...older.filter(e => !known.has(e._id)), ...sessionState.entries];
      // 翻到底：返回页不足一页（已到文件开头），或本页没有新增任何条目
      // （剩余全是不可渲染条目）→ 标记加载完，避免滚到顶部反复请求空页。
      if (raw.length < TRANSCRIPT_PAGE || merged.length === prevLen) {
        sessionState.transcriptExhausted = true;
      }
      if (merged.length === prevLen) return 0;
      sessionState.entries = merged;
      sessionState.transcriptTotal = tr ? tr.total : merged.length;
      sessionState.transcriptLoaded = merged.length;
      // entries 引用已变化，但 ph-session-view/stream 的属性绑定只在自身
      // 重渲染时重新求值：派发事件让消息流/状态栏同步刷新（进度条等）。
      window.dispatchEvent(new CustomEvent("ph-session-transcript"));
      return merged.length - prevLen; // 新增条数（滚动位置修正用）
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
    this.classList.toggle("detail-open", !!sessionState.detail);
    return html`
      <div class="col-list">
        <ph-session-list .list=${sessionState.list} .selectedId=${this.selectedId} @select=${(e) => this.select(e.detail)} @create=${() => { this.showCreate = true; this.prefill = null; this.requestUpdate(); }}></ph-session-list>
      </div>
      <div class="col-main">
        ${sessionState.detail
          ? html`<ph-session-view .sessionId=${this.selectedId} @close=${() => { this.selectedId = null; sessionState.detail = null; this.requestUpdate(); }}></ph-session-view>`
          : html`<div class="pw-empty">选择或新建一个会话开始协作</div>`}
      </div>
      ${this.showCreate ? html`<ph-session-create .prefill=${this.prefill} @close=${() => { this.showCreate = false; this.requestUpdate(); }} @created=${(e) => { this._onCreated(e.detail); }}></ph-session-create>` : ""}
    `;
  }

  // 创建完成：刷新列表并选中；带初始指令时等待视图自动启动完成后
  // 发送第一条消息（启动统一由会话视图负责，避免重复 start）。
  _onCreated(detail) {
    const id = detail.id;
    const firstMsg = (detail.body || "").trim();
    this.showCreate = false;
    this.prefill = null;
    this.refreshList();
    this.requestUpdate();
    this.select(id);
    if (!firstMsg) return;
    (async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const ss = await api(`/api/sessions/${id}`);
          if (ss.status === "active") break;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
      }
      try {
        await api(`/api/sessions/${id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ message: firstMsg }),
        });
      } catch (e) { toastErr(`发送初始指令失败: ${e.message || e}`); }
    })();
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
      case "custom_message": {
        // pi 交互式对话的落盘记录（如 pi-web.ask.answers：agent 提问后
        // 用户的回答）。display=false 是内部回执，不渲染。
        if (e.display === false) break;
        items.push(attach({ kind: "custom", msg: { customType: e.customType, content: e.content, details: e.details } }));
        break;
      }
      case "custom": {
        // 扩展自定义块（如 web-search-results）：没有 content 字段，
        // 内容在 data 里，转成可读文本。
        items.push(attach({ kind: "custom", msg: { customType: e.customType, content: customDataText(e.data) } }));
        break;
      }
      default: break;
    }
  }
  return items;
}

// custom 条目（无 content 字段）→ 可读文本。目前见到的是 web-search-results：
// data.queries（搜索词+摘要）/ data.urls（抓取列表）。
function customDataText(data) {
  if (!data || typeof data !== "object") return "";
  const out = [];
  if (Array.isArray(data.queries)) {
    for (const q of data.queries) {
      if (!q) continue;
      if (q.query) out.push(`> ${q.query}`);
      if (q.answer) out.push(q.answer);
    }
  }
  if (Array.isArray(data.urls)) {
    for (const u of data.urls) {
      if (!u) continue;
      let line = `- ${u.url || ""}`;
      if (u.error) line += `（${u.error}）`;
      out.push(line);
      if (u.title) out.push(`  ${u.title}`);
    }
  }
  return out.join("\n\n");
}

// 交互式提问答案的显示文本（details.questions 结构）。
function askAnsweredText(q) {
  const vals = Array.isArray(q.values) ? q.values : [];
  if (!vals.length) return "（未回答）";
  const opts = Array.isArray(q.question && q.question.options) ? q.question.options : [];
  return vals.map(v => {
    const o = opts.find(o => o && o.value === v);
    return o && o.label ? o.label : v;
  }).join("、");
}

// 实时事件新增条目时同步已加载/总数计数：否则顶部进度条与状态栏
// 的「N 条消息」停留在初载快照，要刷新页面才同步（服务端 total 是
// 文件行数，实时追加的条目最终也会落盘，计数保持一致）。
function trackAppended() {
  const st = sessionState;
  st.transcriptLoaded += 1;
  st.transcriptTotal += 1;
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
    case "agent_start": st.agentRunning = true; st.sending = false; break;
    case "agent_settled":
    case "agent_end": { // omp 用 agent_end（带完整 messages），pi 用 agent_settled；语义相同
      st.agentRunning = false;
      st.sending = false;
      // 回合已结束：此时仍未应答的提问必然已失效（pi 的扩展提问会阻塞
      // 当前回合，超时/中止后才走到 settled），清掉挂起状态并把卡片替换
      // 为「已跳过」，避免输入框永久冻结、卡片残留。
      if (st.pendingAsk) {
        const askId = st.pendingAsk.id;
        const idx = st.entries.findIndex(it => it.kind === "ask" && it.ask && String(it.ask.id) === String(askId));
        if (idx >= 0) {
          st.entries[idx] = {
            kind: "custom",
            msg: { customType: "ask-skipped", content: "提问已跳过（超时或中止）" },
            _id: "ask-" + askId,
          };
        }
        st.pendingAsk = null;
      }
      break;
    }
    case "turn_start": st.agentRunning = true; break;
    case "message_start": {
      st.sending = false;
      const msg = ev.message || {};
      if (msg.role === "assistant") {
        st.pending = { kind: "assistant", msg, toolResults: new Map(), streaming: true };
        st.entries.push(st.pending);
        trackAppended();
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
      trackAppended();
      break;
    }
    case "extension_ui_request": {
      // pi agent 交互式提问（ask_user 等扩展）：select/confirm/input/editor
      // 会阻塞等待应答（extension_ui_response），追加问答卡片；
      // notify 是即发即忘通知，toast 提示。其余（setStatus/setWidget 等）
      // 是 TUI 装饰，RPC 下无渲染目标，忽略。
      const method = ev.method || "";
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        st.sending = false;
        st.pendingAsk = {
          id: ev.id, method, title: ev.title || "",
          options: Array.isArray(ev.options) ? ev.options : [],
          message: typeof ev.message === "string" ? ev.message : "",
          placeholder: ev.placeholder || "",
        };
        st.entries.push({ kind: "ask", ask: st.pendingAsk, _id: "ask-" + ev.id });
        trackAppended();
      } else if (method === "notify" && ev.message) {
        import("./core.js").then(m => m.toast(String(ev.message), false)).catch(() => {});
      }
      break;
    }
    default: break;
  }
}

function toastErr(msg) {
  import("./core.js").then(m => m.toast(msg, true)).catch(() => alert(msg));
}

// 把完整模板作为独立段落插入输入框选区。选区两侧已有内容时自动补空行，
// 避免模板与用户草稿粘连；返回光标位置，供 Lit 更新 DOM 后恢复编辑焦点。
export function insertTemplateText(value, body, selectionStart, selectionEnd) {
  const current = String(value || "");
  const snippet = String(body || "");
  const clamp = n => Math.max(0, Math.min(current.length, Number.isFinite(n) ? n : current.length));
  let start = clamp(selectionStart);
  let end = clamp(selectionEnd);
  if (start > end) [start, end] = [end, start];
  const before = current.slice(0, start);
  const after = current.slice(end);
  const prefix = before && snippet && !/\s$/.test(before) && !/^\s/.test(snippet) ? "\n\n" : "";
  const suffix = after && snippet && !/\s$/.test(snippet) && !/^\s/.test(after) ? "\n\n" : "";
  return {
    value: before + prefix + snippet + suffix + after,
    cursor: before.length + prefix.length + snippet.length,
  };
}

// ---------------------------------------------------------------- 组件：会话列表（左侧导航面板）
export class PhSessionList extends LitElement {
  static styles = css`
    ${PW}
    :host { display: flex; flex-direction: column; height: 100%; background: var(--pw-bg); }
    section { box-sizing: border-box; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 10px; }
    h2 { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 0 0 8px; color: var(--pw-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    h2 .count { color: var(--pw-dim); font-size: 12px; }
    .toolbar { flex: 0 0 auto; margin-bottom: 4px; }
    select { border: 1px solid var(--pw-border); background: var(--pw-surface); color: var(--pw-text); border-radius: 8px; padding: 4px 8px; font-size: 12.5px; }
    select:focus { outline: none; border-color: var(--pw-accent); }
    .list-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .action-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 6px 0; cursor: pointer; }
    .action-main { position: relative; box-sizing: border-box; min-width: 0; width: 100%; border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-surface); color: var(--pw-text); padding: 8px 10px; text-align: left; }
    .action-row:not(.selected):hover .action-main { background: var(--pw-surface-hover); }
    .action-row.selected .action-main { border-color: var(--pw-accent); background: var(--pw-selection-bg); }
    .action-name { display: -webkit-box; max-height: 2.5em; overflow: hidden; overflow-wrap: anywhere; line-height: 1.25; font-size: 13.5px; font-weight: 600; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .action-row.selected .action-name { color: var(--pw-text-bright); }
    .row-meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; color: var(--pw-muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { font-size: 11px; flex: 0 0 auto; }
    .dot.st-active { color: var(--info); } /* 活跃 = 任务执行中语义色 */
    .dot.st-delivered { color: var(--success); }
    .dot.st-failed { color: var(--danger); }
    .dot.st-created, .dot.st-suspended, .dot.st-deleted, .dot.st-cancelled { color: var(--fg-faint); }
    .cli { flex: 0 0 auto; border: 1px solid var(--pw-border); border-radius: 4px; padding: 0 5px; font-size: 10px; font-weight: 700; color: var(--pw-text-secondary); }
    .row-meta a { color: var(--pw-accent); text-decoration: none; }
    .row-meta a:hover { text-decoration: underline; }
    .new { display: block; width: 100%; text-align: left; margin: 6px 0; padding: 7px 9px; border: 1px dashed var(--pw-border); border-radius: 8px; background: transparent; color: var(--pw-muted); font-size: 13px; cursor: pointer; }
    .new:hover { color: var(--pw-text); border-color: var(--pw-border); background: var(--pw-surface-hover); }
    .pw-empty-sm { color: var(--pw-dim); text-align: center; padding: 28px 0; font-size: 12.5px; }
  `;
  static properties = { list: { attribute: false }, selectedId: { attribute: false }, filter: { state: true } };
  constructor() {
    super();
    this.list = [];
    this.selectedId = null;
    this.filter = "all";
  }
  _filtered() {
    let l = Array.isArray(this.list) ? this.list : [];
    if (this.filter !== "all") l = l.filter(x => x.status === this.filter);
    return l;
  }
  render() {
    const items = this._filtered();
    return html`
      <section>
        <h2>会话 <span class="count">${items.length}</span></h2>
        <div class="toolbar">
          <select .value=${this.filter} @change=${(e) => { this.filter = e.target.value; }}>
            <option value="all">全部</option>
            <option value="active">活跃</option>
            <option value="suspended">已挂起</option>
            <option value="delivered">已交付</option>
          </select>
        </div>
        <div class="list-body">
          ${items.map(s => html`
            <div class="action-row ${s.id === this.selectedId ? "selected" : ""}" @click=${() => this._emit("select", s.id)}>
              <div class="action-main">
                <div class="action-name" title=${s.title}>${s.title}</div>
                <div class="row-meta">
                  <span class="dot st-${s.status}">${STATUS_DOT[s.status] || "○"}</span>
                  <span class="cli">${s.cli || "?"}</span>
                  <span>${s.agent_name || ""}</span>
                  ${s.project_name ? html`<span>·</span><span>${s.project_name}</span>` : ""}
                  <span>·</span><span>${relTime(s.last_message_at || s.created_at)}</span>
                  ${s.message_count ? html`<span>·</span><span>${s.message_count} 条</span>` : ""}
                  ${s.task_id ? html`<span>·</span><a href="#/issue/${s.task_id}" @click=${(e) => e.stopPropagation()}>任务 #${s.task_id}</a>` : ""}
                </div>
              </div>
            </div>`)}
          ${!items.length ? html`<div class="pw-empty-sm">暂无会话</div>` : ""}
        </div>
        <button class="new" @click=${() => this._emit("create")}>＋ 新建会话</button>
      </section>
    `;
  }
  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}
customElements.define("ph-session-list", PhSessionList);

// ---------------------------------------------------------------- 组件：新建会话（弹窗）
export class PhSessionCreate extends LitElement {
  static styles = css`
    ${PW}
    :host { position: fixed; inset: 0; background: var(--pw-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fadeIn var(--t-med) ease-out; }
    .box { background: linear-gradient(180deg, var(--raised), var(--surface)); border: 1px solid var(--border-strong); border-radius: var(--r-2xl); padding: 22px; width: 440px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--sh-floating); color: var(--pw-text); font: 13px/1.45 var(--font-sans); animation: popIn var(--t-med) var(--ease-out); }
    h3 { margin: 0 0 3px; font-size: 15.5px; font-weight: 700; letter-spacing: -.1px; }
    label { font-size: 12px; color: var(--pw-muted); display: flex; flex-direction: column; gap: 5px; }
    input, select, textarea { border: 1px solid var(--border-strong); border-radius: 10px; padding: 7px 11px; font-size: 13px; background: var(--inset); color: var(--pw-text); font-family: inherit; line-height: 18px; }
    textarea { resize: vertical; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(199, 243, 106, .11); }
    .hint { font-size: 12px; color: var(--pw-muted); }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--border-strong); cursor: pointer; font-size: 12.5px; font-weight: 580; background: rgba(244, 247, 241, .055); color: var(--pw-text); transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast), filter var(--t-fast); }
    button:hover { background: rgba(244, 247, 241, .09); border-color: rgba(228, 238, 226, .26); }
    button:active { transform: scale(.97); }
    button.primary { background: var(--brand-grad); border-color: transparent; color: #10140e; font-weight: 700; box-shadow: 0 8px 22px rgba(122, 177, 77, .14), inset 0 1px 0 rgba(255, 255, 255, .38); }
    button.primary:hover { filter: brightness(1.04); box-shadow: 0 10px 28px rgba(122, 177, 77, .2), inset 0 1px 0 rgba(255, 255, 255, .42); }
  `;
  static properties = { agents: { state: true }, projects: { state: true }, prefill: { attribute: false } };
  constructor() {
    super();
    this.agents = [];
    this.projects = [];
    this.agentId = "";
    this.projectId = "";
    this.title = "";
    this.body = "";
    this.submitting = false;
  }
  connectedCallback() {
    super.connectedCallback();
    const pf = this.prefill || {};
    Promise.all([api("/api/agents"), api("/api/projects")]).then(([a, p]) => {
      // 交互式会话只支持 pi / omp（RPC 消息流通道）；opencode / claude /
      // codex 无结构化消息通道，仅批处理执行，不进入会话创建表单。
      this.agents = a.filter(x => x.enabled && (x.cli === "pi" || x.cli === "omp"));
      this.projects = p;
      if (pf.agent && this.agents.some(x => String(x.id) === String(pf.agent))) this.agentId = String(pf.agent);
      else if (this.agents.length) this.agentId = String(this.agents[0].id);
      // 默认不选项目：不选择即不关联任何项目（会话在独立目录运行）。
      if (pf.project && this.projects.some(x => String(x.id) === String(pf.project))) this.projectId = String(pf.project);
      this.title = pf.title || "";
      this.body = pf.body || "";
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
      this.dispatchEvent(new CustomEvent("created", {
        detail: { id: ss.id, body: this.body.trim() },
        bubbles: true, composed: true,
      }));
    } catch (e) { toastErr(`创建失败: ${e.message || e}`); }
    this.submitting = false;
  }
  render() {
    const proj = this.projects.find(p => String(p.id) === this.projectId);
    return html`
      <div class="box" @click=${(e) => e.stopPropagation()}>
        <h3>新建会话</h3>
        <label>标题 <input .value=${this.title} @input=${(e) => this.title = e.target.value} placeholder="例如：修复登录失败" @keydown=${(e) => e.key === "Enter" && !e.isComposing && this.submit()}></label>
        <label>初始指令
          <textarea .value=${this.body} @input=${(e) => this.body = e.target.value} rows="3" placeholder="可选：创建后自动启动并发送第一条指令（与任务弹窗的「任务内容」一致）"></textarea>
        </label>
        <label>角色
          ${this.agents.length ? html`<select .value=${this.agentId} @change=${(e) => this.agentId = e.target.value}>
            ${this.agents.map(a => html`<option value=${a.id}>${a.name}（${a.cli}）</option>`)}
          </select>` : html`<div class="hint">交互式会话只支持 pi / omp 角色；请先在 Agents 页安装并创建 pi / omp 角色。</div>`}
        </label>
        <label>项目
          <select .value=${this.projectId} @change=${(e) => this.projectId = e.target.value}>
            <option value="">（无项目）</option>
            ${this.projects.map(p => html`<option value=${p.id}>${p.name}</option>`)}
          </select>
        </label>
        ${proj ? html`<div class="hint">${proj.is_git
          ? "git 项目：创建独立 worktree（sessions/<项目>/session-N）"
          : "非 git 项目：复制到专属会话目录（sessions/<项目>/session-N），不直接在原目录上工作"}，与任务互不污染。</div>` : html`<div class="hint">无项目：会话在独立目录（sessions/session-N）运行，不关联任何项目。</div>`}
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
    this._bootedFor = null;
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
  // 统一自动启动：created 会话打开即启动。pi/omp 挂起会话靠发送消息
  // 自动恢复（Prompt 触发），不提前拉起。
  updated() {
    const ss = sessionState.detail;
    if (!ss || this._bootedFor === ss.id) return;
    if (ss.status !== "created") return;
    this._bootedFor = ss.id;
    this._autoStart(ss.id);
  }
  async _autoStart(id) {
    try {
      await api(`/api/sessions/${id}/start`, { method: "POST" });
      window.dispatchEvent(new CustomEvent("ph-session-updated"));
      window.dispatchEvent(new CustomEvent("ph-session-detail-refresh", { detail: id }));
      setTimeout(() => window.dispatchEvent(new CustomEvent("ph-session-updated")), 400);
    } catch (e) {
      toastErr(`自动启动失败: ${e.message || e}`);
    }
  }
  render() {
    const st = sessionState;
    const ss = st.detail;
    if (!ss) return html`<div class="pw-empty">加载中…</div>`;
    // 交互式会话只支持 pi / omp：一律走 RPC 消息流视图。
    return html`
      <ph-session-header .session=${ss} .live=${st.live} .running=${st.agentRunning}></ph-session-header>
      <ph-message-stream .sessionId=${this.sessionId} .entries=${st.entries}></ph-message-stream>
      <ph-status-bar .live=${st.live} .running=${st.agentRunning}></ph-status-bar>
      <ph-session-input .session=${ss} .running=${st.agentRunning} @refresh=${() => this.requestUpdate()}></ph-session-input>
    `;
  }
}
customElements.define("ph-session-view", PhSessionView);

// ---------------------------------------------------------------- 组件：状态栏
// 底部细条：左侧活动指示（点 + 文本），右侧模型/思考级别/消息数。
export class PhStatusBar extends LitElement {
  static styles = css`
    ${PW}
    :host { display: block; color: var(--pw-muted); font: 12px var(--font-sans); }
    .bar { display: flex; justify-content: flex-end; gap: 12px; align-items: center; min-width: 0; padding: 7px 12px; border-top: 1px solid var(--pw-border); background: var(--pw-bg); white-space: nowrap; overflow: hidden; }
    .activity { margin-right: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--pw-muted); }
    .activity.active { color: var(--pw-success); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
    .activity.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
    .bar > span:not(.activity) { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: var(--pw-dim); }
    @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  `;
  static properties = { live: { attribute: false }, running: { attribute: false } };
  constructor() {
    super();
    // 分页加载更早消息/实时追加后：消息总数变化，状态栏同步刷新。
    this._onLive = () => this.requestUpdate();
    this._onTranscript = () => this.requestUpdate();
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("ph-session-message", this._onLive);
    window.addEventListener("ph-session-transcript", this._onTranscript);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("ph-session-message", this._onLive);
    window.removeEventListener("ph-session-transcript", this._onTranscript);
  }
  render() {
    const st = sessionState;
    const active = st.sending || this.running;
    const label = st.sending ? "发送中" : this.running ? "处理中" : "空闲";
    const model = this.live && this.live.model ? this.live.model.id || "" : (st.detail && st.detail.agent_name) || "";
    return html`<div class="bar">
      <span class="activity ${active ? "active" : ""}"><span class="dot"></span>${label}</span>
      ${model ? html`<span title="当前模型">${model}</span>` : ""}
      ${this.live && this.live.thinkingLevel ? html`<span>思考:${this.live.thinkingLevel}</span>` : ""}
      <span class="muted">${st.transcriptTotal} 条消息</span>
    </div>`;
  }
}
customElements.define("ph-status-bar", PhStatusBar);

// ---------------------------------------------------------------- 组件：会话头部
export class PhSessionHeader extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 0 0 auto; border-bottom: 1px solid var(--pw-border); background: var(--pw-bg); }
    .strip { display: flex; align-items: center; gap: 10px; padding: 12px; flex-wrap: wrap; }
    .title { font-weight: 600; font-size: 14px; color: var(--pw-text); display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; border-radius: 20px; padding: 1.5px 9px; font-weight: 550; border: 1px solid var(--pw-border); color: var(--fg-muted); background: color-mix(in srgb, var(--border) 45%, transparent); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .badge.running { color: var(--info); border-color: rgba(56, 189, 248, .35); background: rgba(56, 189, 248, .1); }
    .badge.delivered { color: var(--success); border-color: rgba(52, 211, 153, .35); background: rgba(52, 211, 153, .1); }
    .badge.failed, .badge.deleted { color: var(--danger); border-color: rgba(248, 113, 113, .35); background: rgba(248, 113, 113, .1); }
    .badge.suspended, .badge.created, .badge.active { color: var(--fg-faint); }
    .meta { color: var(--pw-muted); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
    .meta .cli { border: 1px solid var(--pw-border); border-radius: 4px; padding: 0 5px; font-size: 10px; font-weight: 700; }
    .spacer { flex: 1; }
    .back { display: none; }
    @media (max-width: 860px) { .back { display: inline-flex; } }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 29px; border: 1px solid var(--border-strong); border-radius: 8px; background: rgba(244, 247, 241, .055); color: var(--pw-text); padding: 0 10px; cursor: pointer; font-size: 12px; font-weight: 580; transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast), filter var(--t-fast); }
    button:hover { background: rgba(244, 247, 241, .09); border-color: rgba(228, 238, 226, .26); }
    button:active { transform: scale(.97); }
    button.primary { background: var(--brand-grad); border-color: transparent; color: #10140e; font-weight: 700; box-shadow: 0 8px 22px rgba(122, 177, 77, .14), inset 0 1px 0 rgba(255, 255, 255, .38); }
    button.primary:hover { filter: brightness(1.04); box-shadow: 0 10px 28px rgba(122, 177, 77, .2), inset 0 1px 0 rgba(255, 255, 255, .42); }
    button.danger { color: var(--danger); }
    button.danger:hover { background: var(--danger-dim); border-color: rgba(248, 113, 113, .4); }
    button:disabled { opacity: .45; pointer-events: none; }
    .link { color: var(--pw-accent); font-size: 12.5px; text-decoration: none; }
    .link:hover { text-decoration: underline; }
  `;
  static properties = { session: { attribute: false }, live: { attribute: false }, running: { attribute: false } };
  async act(action) {
    const id = this.session.id;
    try {
      if (action === "start") await api(`/api/sessions/${id}/start`, { method: "POST" });
      else if (action === "abort") await api(`/api/sessions/${id}/abort`, { method: "POST" });
      else if (action === "delete") {
        if (!confirm("丢弃该会话？（工作目录将被清理）")) return;
        await api(`/api/sessions/${id}`, { method: "DELETE" });
        // 会话已删除：关掉详情并刷新列表（不再触发 detail 刷新，
        // 否则会重新加载出已删除会话的详情，界面停留不关闭）。
        this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
        window.dispatchEvent(new CustomEvent("ph-session-updated"));
        return;
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
        <button class="back" title="返回会话列表" @click=${() => this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }))}>←</button>
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
        ${s.status === "created" ? html`<button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s.status === "active" ? html`
          ${running ? html`<button @click=${() => this.act("abort")}>中止</button>` : ""}
          <button class="primary" @click=${() => this.act("deliver")}>交付</button>
          <button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s.status === "suspended" ? html`
          <button class="primary" @click=${() => this.act("deliver")}>交付</button>
          <button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
        ${s.status === "delivered" ? html`
          ${s.task_id ? html`<a class="link" href="#/issue/${s.task_id}">查看任务 #${s.task_id} →</a>` : ""}
          <button class="danger" @click=${() => this.act("delete")}>丢弃</button>` : ""}
      </div>`;
  }
}
customElements.define("ph-session-header", PhSessionHeader);

// ---------------------------------------------------------------- 组件：消息流
export class PhMessageStream extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .chat-wrap { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
    .chat { --pw-chat-sticky-top: -26px; height: 100%; min-height: 0; overflow: auto; overflow-anchor: none; padding: 26px 16px 64px; box-sizing: border-box; }
    .pw-empty { margin: 60px auto; max-width: 420px; color: var(--pw-muted); text-align: center; font-size: 14px; line-height: 1.8; }
    /* conversation-meter：聊天区顶部位置进度条 */
    .conversation-rail { position: absolute; top: -4px; left: 16px; right: 16px; z-index: 6; display: block; height: 12px; opacity: .58; transition: opacity .15s ease; }
    .conversation-rail:hover { opacity: .92; }
    .rail-track { position: relative; height: 4px; margin-top: 4px; border-radius: 999px; background: color-mix(in srgb, var(--pw-border-muted) 34%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--pw-bg) 55%, transparent); }
    .rail-progress { position: absolute; left: 0; width: var(--rail-position, 100%); top: 0; bottom: 0; border-radius: 999px; background: color-mix(in srgb, var(--pw-accent) 42%, var(--pw-border-muted)); }
    .rail-marker { position: absolute; left: var(--rail-position, 100%); top: 50%; width: 10px; height: 10px; border: 2px solid var(--pw-bg); border-radius: 50%; background: var(--pw-accent); box-shadow: 0 2px 8px var(--pw-shadow); transform: translate(-50%, -50%); }
    /* pi-web history-boundary：顶部历史边界（自动加载中/会话起点 + 消息区间） */
    .history-boundary { position: relative; z-index: 5; display: grid; gap: 3px; justify-items: center; margin: 0 0 14px; color: var(--pw-muted); font-size: 12px; text-align: center; }
    .history-boundary small { color: var(--pw-dim); }
    /* activity-dock：右下悬浮运行状态药丸 */
    .activity-dock { position: absolute; left: 16px; right: 16px; bottom: 12px; z-index: 20; display: flex; align-items: center; gap: 8px; min-width: 0; box-sizing: border-box; border: 1px solid var(--pw-border); border-radius: 999px; background: var(--pw-bg-overlay); color: var(--pw-muted); padding: 8px 12px; font-size: 13px; pointer-events: none; box-shadow: 0 8px 28px var(--pw-shadow); backdrop-filter: blur(6px); }
    .activity-dock.active { border-color: var(--pw-success-border); color: var(--pw-success); background: var(--pw-success-bg-overlay); }
    .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
    .activity-dock.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
    @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  `;
  static properties = { entries: { attribute: false }, sessionId: { attribute: false } };
  constructor() {
    super();
    this.entries = [];
    this.sessionId = null;
    this._atBottom = true;
    this._loadingOlder = false;
    this._lastRailPercent = 100;
    // SSE 事件 → 强制重渲染（entries 原地变更，属性引用不变）
    this._onLive = () => this.requestUpdate();
    // loadEarlier 分页合并后：同步本地 entries 快照并重渲染。
    // （store 里是新数组，本组件属性绑定的是旧引用，lit 不会自动刷新。）
    this._onTranscript = () => {
      this.entries = sessionState.entries;
      this.requestUpdate();
    };
    // 问答卡片应答成功 → 把 ask 条目替换为用户消息回显。
    // 按 _id 查找而非 kind==="ask"：agent 可能比应答 fetch 回调先恢复
    // （agent_settled 已把卡片标为「已跳过」），此时要覆盖占位而不是丢回显。
    this._onAskAnswered = (e) => {
      const d = e.detail || {};
      const st = sessionState;
      const idx = st.entries.findIndex(it => it._id === "ask-" + d.askId);
      if (idx >= 0) {
        st.entries[idx] = {
          kind: "user",
          msg: { role: "user", content: [{ type: "text", text: d.text || "" }], timestamp: Date.now() },
          _id: "ask-" + d.askId,
        };
      }
      if (st.pendingAsk && String(st.pendingAsk.id) === String(d.askId)) st.pendingAsk = null;
      this.requestUpdate();
    };
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("ph-session-message", this._onLive);
    window.addEventListener("ph-session-ask-answered", this._onAskAnswered);
    window.addEventListener("ph-session-transcript", this._onTranscript);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("ph-session-message", this._onLive);
    window.removeEventListener("ph-session-ask-answered", this._onAskAnswered);
    window.removeEventListener("ph-session-transcript", this._onTranscript);
    cancelAnimationFrame(this._scrollRaf);
    cancelAnimationFrame(this._railRaf);
  }
  willUpdate(ch) {
    if (ch.has("sessionId")) {
      this._atBottom = true; // 切换会话后回到底部
      this._lastRailPercent = 100;
    }
  }
  updated() {
    if (this._atBottom) {
      // ph-msg-* 子组件的 shadow 内容在本组件 updated 之后才异步渲染完，
      // 此时 scrollHeight 还没长全；推迟到下一帧再滚，否则底部会被截断。
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = requestAnimationFrame(() => this.scrollToBottom());
    }
    // entries 更新、分页插入和子消息完成渲染都会改变 scrollHeight。
    // 下一帧按最终布局重新校准阅读位置；只改 rail 自身，避免滚动时
    // 重渲染整条消息列表。
    cancelAnimationFrame(this._railRaf);
    this._railRaf = requestAnimationFrame(() => this._syncRail());
    // 防御竞态：模板切换/高频重渲染下，个别 ph-msg-* 子组件的首次更新
    // 可能未执行（shadow 内容为空）。仅对从未渲染过的子组件强制刷新，
    // 正常路径零开销（hasUpdated 为 true 直接跳过）。
    const chat = this.renderRoot.querySelector(".chat");
    if (chat) {
      for (const el of chat.querySelectorAll("ph-msg-user, ph-msg-assistant, ph-msg-bash, ph-msg-custom, ph-ask-card, ph-tool-card")) {
        if (!el.hasUpdated) el.requestUpdate();
      }
    }
  }
  scrollToBottom() {
    // 滚动容器是 .chat，不是 host（host 无 overflow，设置 scrollTop 无效）
    const chat = this.renderRoot.querySelector(".chat");
    if (chat) {
      chat.scrollTop = chat.scrollHeight;
      this._syncRail(chat);
    }
  }
  onScroll(e) {
    const chat = e.currentTarget;
    this._atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    this._syncRail(chat);
    // 滚到顶部加载更早（pi-web：Scroll up to load earlier messages）
    if (chat.scrollTop <= 40) this._loadMore();
  }
  async _loadMore() {
    if (this._loadingOlder || !this._hasOlder()) return;
    const chat = this.renderRoot.querySelector(".chat");
    if (!chat) return;
    this._loadingOlder = true;
    const prevHeight = chat.scrollHeight;
    try {
      const page = document.querySelector("ph-sessions-page");
      await page.loadEarlier();
      if (!chat.isConnected) return;
      // ph-msg-* 子组件的 shadow 内容在本组件更新后还要等一帧才渲染完
      // （同 scrollToBottom），此时 scrollHeight 还没长全：等两帧再补偿
      // 滚动位置，把视口拉回原来阅读的内容处。
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!chat.isConnected) return;
      chat.scrollTop = chat.scrollHeight - prevHeight + 40;
      this._syncRail(chat);
    } finally {
      this._loadingOlder = false;
    }
  }
  _hasOlder() {
    const st = sessionState;
    return !st.transcriptExhausted && st.transcriptLoaded < st.transcriptTotal;
  }
  // pi-web formatted-text 代码块复制按钮（事件委托，全消息流共享）。
  // 注意：composed 事件在 shadow 边界外观察时 e.target 会被 retarget 成
  // shadow host，必须走 composedPath() 才能拿到 shadow 内部的按钮。
  onChatClick(e) {
    const btn = e.composedPath().find(n => n instanceof Element && n.classList && n.classList.contains("code-copy-button"));
    if (!btn) return;
    const wrapper = btn.closest(".code-block-wrapper");
    const pre = wrapper && wrapper.querySelector("pre code");
    if (pre) copyText(pre.textContent, btn);
  }
  // 顶部 rail 表示「当前阅读位置」，不是「历史加载完成度」。首屏只加载
  // 尾部一页时，已加载 100/1000 代表可见窗口覆盖全文的 90%–100%，而
  // 不是阅读位置固定在 10%。窗口内再按真实 scrollTop 插值，滚动时同步。
  // state 参数仅供浏览器回归测试注入边界数据，生产路径使用 sessionState。
  _railPercent(chat, state = sessionState) {
    const total = Math.max(0, Number(state.transcriptTotal) || 0);
    if (!total) return 100;

    const loaded = Math.min(total, Math.max(0, Number(state.transcriptLoaded) || 0));
    // transcriptTotal 是原始 JSONL 条目数，entries 是可渲染条目数；翻到
    // 文件开头后两者可能不相等，此时仍应从全文 0% 起算。
    const hiddenBefore = state.transcriptExhausted ? 0 : Math.max(0, total - loaded);
    const visibleWindow = total - hiddenBefore;
    const maxScroll = chat
      ? Math.max(0, (Number(chat.scrollHeight) || 0) - (Number(chat.clientHeight) || 0))
      : 0;
    const local = maxScroll > 0
      ? Math.min(1, Math.max(0, (Number(chat.scrollTop) || 0) / maxScroll))
      : 1;
    const percent = ((hiddenBefore + visibleWindow * local) / total) * 100;
    return Math.min(100, Math.max(0, percent));
  }
  _syncRail(chat = this.renderRoot.querySelector(".chat")) {
    if (!chat) return;
    const rail = this.renderRoot.querySelector(".conversation-rail");
    const track = this.renderRoot.querySelector(".rail-track");
    if (!rail || !track) return;
    const percent = this._railPercent(chat);
    this._lastRailPercent = percent;
    track.style.setProperty("--rail-position", `${percent.toFixed(2)}%`);
    rail.setAttribute("aria-valuenow", String(Math.round(percent)));
    rail.title = `当前阅读位置：约 ${Math.round(percent)}%（已加载 ${sessionState.transcriptLoaded}/${sessionState.transcriptTotal}）`;
  }
  renderHistoryBoundary() {
    const st = sessionState;
    if (!st.entries.length) return null;
    const from = st.transcriptTotal - st.transcriptLoaded + 1;
    const to = st.transcriptTotal;
    const range = html`<small>显示第 ${Math.max(from, 1)}–${to} 条，共 ${to} 条</small>`;
    if (this._hasOlder()) {
      return html`<div class="history-boundary"><span>向上滚动自动加载更早消息</span>${range}</div>`;
    }
    return html`<div class="history-boundary"><span>已到会话开头</span>${range}</div>`;
  }
  renderDock() {
    const st = sessionState;
    if (!st.detail) return null;
    let cls = "", text = "空闲";
    if (st.sending) { cls = "active"; text = "发送中…"; }
    else if (st.agentRunning) { cls = "active"; text = "Agent 处理中…"; }
    return html`<div class=${cls ? "activity-dock active" : "activity-dock"} aria-live="polite">
      <span class="dot"></span>
      <span class="activity-text">${text}</span>
    </div>`;
  }
  render() {
    if (!this.entries.length) {
      return html`<div class="chat-wrap">
        <div class="chat"><div class="pw-empty">还没有消息。在下方输入第一条指令，开始与 agent 协作。<br>完成后可点「交付」转为任务，走审批 → 合并流程。</div></div>
        ${this.renderDock()}
      </div>`;
    }
    const railPercent = this._lastRailPercent;
    return html`<div class="chat-wrap">
      <div class="conversation-rail" role="progressbar" aria-label="当前阅读位置" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow=${Math.round(railPercent)}
        title=${`当前阅读位置：约 ${Math.round(railPercent)}%（已加载 ${sessionState.transcriptLoaded}/${sessionState.transcriptTotal}）`}>
        <div class="rail-track" style=${`--rail-position:${railPercent.toFixed(2)}%`}>
          <div class="rail-progress"></div>
          <div class="rail-marker"></div>
        </div>
      </div>
      <div class="chat" @scroll=${this.onScroll} @click=${this.onChatClick}>
        ${this.renderHistoryBoundary()}
        ${this.entries.map((it, i) => renderItem(it, i))}
      </div>
      ${this.renderDock()}
    </div>`;
  }
}
customElements.define("ph-message-stream", PhMessageStream);

function renderItem(it, key) {
  switch (it.kind) {
    case "user": return html`<ph-msg-user .msg=${it.msg}></ph-msg-user>`;
    case "assistant": return html`<ph-msg-assistant .msg=${it.msg} .toolLive=${it.toolLive} .toolResults=${it.toolResults} .streaming=${it.streaming}></ph-msg-assistant>`;
    case "bash": return html`<ph-msg-bash .msg=${it.msg}></ph-msg-bash>`;
    case "custom": return html`<ph-msg-custom .msg=${it.msg}></ph-msg-custom>`;
    case "ask": return html`<ph-ask-card .ask=${it.ask}></ph-ask-card>`;
    case "ev-model": return html`<div class="pw-event">模型切换 → ${it.provider}/${it.modelId}</div>`;
    case "ev-thinking": return html`<div class="pw-event">思考级别 → ${it.level}</div>`;
    case "ev-compaction": return html`<div class="pw-event" title=${it.summary || ""}>上下文已压缩（-${it.tokensBefore || "?"} tokens）</div>`;
    case "ev-branch": return html`<div class="pw-event">分支摘要${it.summary ? `: ${it.summary.slice(0, 60)}` : ""}</div>`;
    default: return nothing;
  }
}

// .msg 消息卡片样式：.msg 卡片（12px 内边距/全站圆角/1px 边框）、吸顶 msg-header
// （小号 label + 右侧 meta/复制操作，hover 渐显）、formatted-text 排版。
const msgStyles = css`
  ${PW}
  :host { display: block; max-width: 100%; min-width: 0; }
  .msg { max-width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pw-border); border-radius: var(--r-lg); background: var(--pw-surface); overflow: visible; color: var(--pw-text); font-size: 14px; line-height: 1.45; }
  .msg.user { border-color: var(--pw-accent-border); background: var(--pw-selection-bg); }
  .msg.assistant { background: var(--pw-surface); }
  .msg.streaming { border-color: var(--pw-success-border); }
  .msg.bash { border-color: var(--pw-success-border); background: var(--pw-success-bg); }
  .msg-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; margin-bottom: 8px; }
  .msg > .msg-header { position: sticky; top: -26px; z-index: 4; margin: -12px -12px 8px; padding: 7px 10px 6px; border-radius: var(--r-lg) var(--r-lg) 0 0; border-bottom: 1px solid color-mix(in srgb, var(--pw-border-muted) 35%, transparent); background: var(--pw-surface); box-shadow: 0 8px 18px var(--pw-shadow-soft); }
  .msg.user > .msg-header { border-bottom-color: color-mix(in srgb, var(--brand) 32%, transparent); background: color-mix(in srgb, var(--brand) 8%, var(--surface)); }
  .msg.assistant > .msg-header .label { color: var(--pw-text-secondary); }
  .msg.user > .msg-header .label { color: var(--brand); }
  .msg.bash > .msg-header { border-bottom-color: color-mix(in srgb, var(--success) 32%, transparent); background: color-mix(in srgb, var(--success) 8%, var(--surface)); }
  .label { display: block; color: var(--pw-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .02em; }
  .msg-header .label { margin: 0; }
  .msg-header-trailing { min-width: 0; flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .msg-actions { flex: 0 0 auto; display: inline-flex; gap: 6px; opacity: 0; transition: opacity .12s ease; }
  .msg-action { display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--pw-border); border-radius: 6px; background: var(--pw-surface); color: var(--pw-muted); padding: 0; font: 14px var(--font-sans); line-height: 1; cursor: pointer; }
  .msg-action:hover, .msg-action:focus { color: var(--pw-text); border-color: var(--pw-accent); }
  .msg:hover > .msg-header .msg-actions, .msg:focus-within > .msg-header .msg-actions { opacity: 1; }
  .msg-meta { min-width: 0; opacity: .28; border: 0; background: transparent; color: var(--pw-dim); padding: 0; font: 11px var(--font-sans); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity .12s ease; cursor: pointer; user-select: text; -webkit-user-select: text; }
  .msg:hover > .msg-header .msg-meta, .msg:focus-within > .msg-header .msg-meta, .msg-meta:focus, .msg-meta.expanded { opacity: 1; }
  .msg-meta.expanded { flex: 1 1 auto; max-width: 100%; white-space: normal; overflow: visible; overflow-wrap: anywhere; text-overflow: clip; }
  .stop-aborted { color: var(--pw-danger); }
  /* formatted-text 排版（pi-web formattedTextStyles） */
  .ph-md { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; text-align: start; unicode-bidi: plaintext; }
  .ph-md p, .ph-md ul, .ph-md ol, .ph-md pre, .ph-md blockquote, .ph-md .code-block-wrapper { margin: 0 0 10px; }
  .ph-md :is(p, ul, ol, pre, blockquote, .code-block-wrapper):last-child { margin-bottom: 0; }
  .ph-md ul, .ph-md ol { padding-left: 22px; }
  .ph-md li + li { margin-top: 3px; }
  .ph-md li > :is(p, ul, ol) { margin-top: 4px; margin-bottom: 4px; }
  .ph-md li > p:first-child { margin-top: 0; }
  .ph-md input[type="checkbox"] { margin: 0 6px 0 0; accent-color: var(--pw-accent); vertical-align: -1px; }
  .ph-md code { border: 1px solid var(--pw-border); border-radius: 4px; background: var(--pw-bg); padding: 1px 4px; font: 13px var(--font-mono); direction: ltr; text-align: left; unicode-bidi: isolate; }
  .ph-md .code-block-wrapper { position: relative; }
  .ph-md .code-block-wrapper pre { margin: 0; padding-right: 40px; }
  .ph-md pre { border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-bg); padding: 10px; overflow-x: auto; overflow-y: hidden; direction: ltr; text-align: left; unicode-bidi: isolate; font: 12.5px var(--font-mono); line-height: 1.5; }
  .ph-md pre code { border: 0; padding: 0; background: transparent; }
  .code-copy-button { position: absolute; top: 6px; right: 6px; z-index: 1; display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--pw-border); border-radius: 6px; background: var(--pw-surface); color: var(--pw-muted); padding: 0; font: 14px var(--font-sans); line-height: 1; cursor: pointer; }
  .code-copy-button:hover, .code-copy-button:focus { color: var(--pw-text); border-color: var(--pw-accent); }
  .ph-md blockquote { border-left: 3px solid var(--pw-border); padding-left: 10px; color: var(--pw-muted); margin-top: 4px; }
  .ph-md a { color: var(--pw-accent); }
  .ph-md hr { height: 1px; margin: 14px 0; border: 0; background: var(--pw-border); }
  .ph-md table { display: block; width: max-content; max-width: 100%; margin: 0 0 10px; border-collapse: collapse; overflow-x: auto; }
  .ph-md th, .ph-md td { min-width: 88px; border: 1px solid var(--pw-border); padding: 6px 9px; text-align: start; vertical-align: top; }
  .ph-md th { background: var(--pw-bg); color: var(--pw-text-bright); font-weight: 650; }
  .ph-md tr:nth-child(even) td { background: color-mix(in srgb, var(--pw-bg) 42%, transparent); }
  .ph-md del { color: var(--pw-muted); }
  .ph-md h1, .ph-md h2, .ph-md h3, .ph-md h4, .ph-md h5, .ph-md h6 { margin: 14px 0 8px; line-height: 1.2; font-weight: 600; }
  .ph-md h1:first-child, .ph-md h2:first-child, .ph-md h3:first-child, .ph-md h4:first-child, .ph-md h5:first-child, .ph-md h6:first-child { margin-top: 0; }
  .ph-md h1 { font-size: 20px; }
  .ph-md h2 { font-size: 17px; }
  .ph-md h3 { font-size: 15px; }
  .ph-md h4 { font-size: 14px; }
  .ph-md h5, .ph-md h6 { font-size: 13.5px; }
  .ph-md strong { font-weight: 700; }
  /* 消息 part（pi-web .part） */
  .part { max-width: 100%; min-width: 0; box-sizing: border-box; overflow: visible; }
  .part + .part { margin-top: 10px; }
  .part > summary { cursor: pointer; color: var(--pw-muted); }
  .thinking { border-top: 1px solid var(--pw-border); padding-top: 8px; margin: 10px 0 0; }
  .thinking > summary { font-size: 12px; text-transform: uppercase; letter-spacing: .02em; color: var(--pw-muted); }
  .shell-output { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pw-text); font: 13px var(--font-mono); line-height: 1.45; direction: ltr; text-align: left; unicode-bidi: isolate; }
  .tool-line { color: var(--pw-warning); }
  .tool-line .summary { color: var(--pw-muted); margin-left: 6px; }
  .chat-image { display: block; max-width: 100%; max-height: 320px; margin: 8px 0 0; border: 1px solid var(--pw-border-muted); border-radius: 8px; object-fit: contain; cursor: zoom-in; }
  .pw-event { text-align: center; font-size: 11.5px; color: var(--pw-dim); padding: 10px 0; }
  .usage { font-size: 11.5px; color: var(--pw-dim); margin-top: 4px; }
`;

// pi-web 消息 meta：medium date/time（同 ChatView messageTimestampFormatter）
const pwTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function pwTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  return pwTimeFmt.format(d);
}

// pi-web msg-meta：时间 · 模型 · 思考级别，用 " · " 连接
function pwMeta(msg) {
  const m = msg || {};
  const parts = [pwTime(m.timestamp), m.model, m.thinkingLevel].filter(Boolean);
  return parts.join(" · ");
}

// 复制消息文本（pi-web msg-action：⧉ → 1.2s 内显示 ✓）
async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const icon = btn.querySelector("span");
    if (icon) icon.textContent = "✓";
    btn.title = "已复制";
    setTimeout(() => {
      const i2 = btn.querySelector("span");
      if (i2) i2.textContent = "⧉";
      btn.title = "复制消息";
    }, 1200);
  } catch (_) {}
}

function msgTextOf(msg) {
  const m = msg || {};
  const blocks = Array.isArray(m.content) ? m.content : (typeof m.content === "string" ? [{ type: "text", text: m.content }] : []);
  return blocks.filter(b => b.type === "text").map(b => (b.text || "").trim()).filter(Boolean).join("\n\n");
}

class PhMsgUser extends LitElement {
  static styles = msgStyles;
  static properties = { msg: { attribute: false }, metaOpen: { state: true } };
  constructor() { super(); this.metaOpen = false; }
  render() {
    const m = this.msg || {};
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    return html`<div class="msg user">
      <div class="msg-header">
        <b class="label">用户</b>
        <div class="msg-header-trailing">
          <div class="msg-actions" aria-label="消息操作">
            <button type="button" class="msg-action" title="复制消息" aria-label="复制消息" @click=${(e) => copyText(msgTextOf(m), e.currentTarget)}><span aria-hidden="true">⧉</span></button>
          </div>
          <span class=${this.metaOpen ? "msg-meta expanded" : "msg-meta"} role="button" tabindex="0" title=${pwMeta(m)} aria-label=${pwMeta(m)} @click=${() => this.metaOpen = !this.metaOpen}>${pwMeta(m)}</span>
        </div>
      </div>
      <div class="ph-md">${blocks.map(b => b.type === "image"
        ? html`<img class="chat-image" src=${`data:${b.mimeType || "image/png"};base64,${b.data}`} alt="attached image">`
        : html`<div>${unsafeHTML(md(b.text || ""))}</div>`)}</div>
    </div>`;
  }
}
customElements.define("ph-msg-user", PhMsgUser);

class PhMsgAssistant extends LitElement {
  static styles = [msgStyles, css`
    .tool-card { margin: 10px 0 0; }
    .tool-card:first-child { margin-top: 0; }
  `];
  static properties = { msg: { attribute: false }, toolLive: { attribute: false }, toolResults: { attribute: false }, streaming: { attribute: false }, metaOpen: { state: true } };
  constructor() {
    super();
    this.metaOpen = false;
    // 流式消息的 msg 对象被原地累积（content 数组在同一个对象上变长），
    // 属性引用不变 → lit 不会触发重渲染 → 流式输出只能在 message_end 一次性
    // 出现。必须监听窗口事件主动刷新；仅在流式/工具执行期间刷新，完成后
    // message_end 会用新对象替换 msg 触发常规渲染，无需再监听。
    this._onLive = () => { if (this.streaming || this.toolLive) this.requestUpdate(); };
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("ph-session-message", this._onLive);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("ph-session-message", this._onLive);
  }
  render() {
    const m = this.msg || {};
    const streaming = this.streaming || m.stopReason === "pending";
    const blocks = Array.isArray(m.content) ? m.content : [];
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text") parts.push(html`<div class="part ph-md">${unsafeHTML(md(b.text || ""))}</div>`);
      else if (b.type === "thinking") parts.push(html`<details class="part thinking"><summary>思考</summary><div class="ph-md">${unsafeHTML(md(b.thinking || ""))}</div></details>`);
      else if (b.type === "toolCall") parts.push(html`<ph-tool-card class="part" .call=${b} .result=${(this.toolResults && this.toolResults.get(b.id)) || null}></ph-tool-card>`);
      else if (b.type === "toolExecution") parts.push(html`<ph-tool-card class="part" .call=${b} .result=${(this.toolResults && this.toolResults.get(b.id)) || null}></ph-tool-card>`);
    }
    const meta = pwMeta(m) + (m.stopReason === "aborted" ? " · 已中止" : "");
    return html`<div class="msg assistant ${streaming ? "streaming" : ""}">
      <div class="msg-header">
        <b class="label">助手</b>
        <div class="msg-header-trailing">
          <div class="msg-actions" aria-label="消息操作">
            <button type="button" class="msg-action" title="复制消息" aria-label="复制消息" @click=${(e) => copyText(msgTextOf(m), e.currentTarget)}><span aria-hidden="true">⧉</span></button>
          </div>
          <span class=${this.metaOpen ? "msg-meta expanded" : "msg-meta"} role="button" tabindex="0" title=${meta} aria-label=${meta} @click=${() => this.metaOpen = !this.metaOpen}>${meta}</span>
        </div>
      </div>
      ${parts}
      ${m.usage ? html`<div class="usage">tokens: ${m.usage.totalTokens || 0}${m.usage.cost ? ` · $${m.usage.cost.total || 0}` : ""}</div>` : ""}
    </div>`;
  }
}
customElements.define("ph-msg-assistant", PhMsgAssistant);

class PhMsgBash extends LitElement {
  static styles = msgStyles;
  static properties = { msg: { attribute: false } };
  render() {
    const m = this.msg || {};
    const err = m.isError || (m.exitCode !== undefined && m.exitCode !== null && m.exitCode !== 0);
    const lines = [];
    if (m.command) lines.push(`$ ${m.command}`);
    if (m.output) lines.push(m.output);
    lines.push(`${err ? "✗ 失败" : "✓ 成功"}${m.exitCode !== undefined && m.exitCode !== null ? ` · exit ${m.exitCode}` : ""}${m.truncated ? " · 已截断" : ""}`);
    return html`<div class="msg bash">
      <div class="msg-header">
        <b class="label">bash</b>
        <div class="msg-header-trailing">
          <span class="msg-meta" title=${pwMeta(m)}>${pwMeta(m)}</span>
        </div>
      </div>
      <pre class="part shell-output">${lines.join("\n")}</pre>
    </div>`;
  }
}
customElements.define("ph-msg-bash", PhMsgBash);

class PhMsgCustom extends LitElement {
  static styles = [msgStyles, css`
    ${PW}
    :host { display: block; margin: 0 0 14px; }
    .box { border: 1px solid var(--pw-purple-border); border-radius: var(--r-lg); padding: 12px; font-size: 14px; line-height: 1.45; background: var(--pw-purple-surface); color: var(--pw-text); }
    .t { font-size: 12px; text-transform: uppercase; letter-spacing: .02em; color: var(--pw-purple); margin-bottom: 6px; }
    .qa { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .q { border-left: 2px solid var(--pw-purple-border); padding-left: 8px; }
    .q-text { font-weight: 600; }
    .a { color: var(--pw-text-secondary); font-size: 13px; margin-top: 2px; }
    .a::before { content: "→ "; color: var(--pw-purple); }
  `];
  static properties = { msg: { attribute: false } };
  render() {
    const m = this.msg || {};
    const d = m.details;
    const qa = d && Array.isArray(d.questions) ? d.questions : null;
    return html`<div class="box"><div class="t">${m.customType || "custom"}</div>
      ${qa && qa.length ? html`<div class="qa">${qa.map(q => html`<div class="q">
        <div class="q-text ph-md">${unsafeHTML(md((q.question && q.question.question) || ""))}</div>
        <div class="a">${askAnsweredText(q)}</div>
      </div>`)}</div>` : html`<div class="ph-md">${unsafeHTML(md(typeof m.content === "string" ? m.content : ""))}</div>`}
    </div>`;
  }
}
customElements.define("ph-msg-custom", PhMsgCustom);

// pi agent 交互式提问卡片（extension_ui_request → extension_ui_response）：
// select 选项按钮 / confirm 确认 / input 单行 / editor 多行。应答成功后
// 由消息流把本条替换为用户消息回显（ph-session-ask-answered）。
class PhAskCard extends LitElement {
  static styles = css`
    ${PW}
    :host { display: block; margin: 0 0 14px; }
    .ask { border: 1px solid var(--pw-accent-border); border-radius: 10px; background: var(--pw-selection-bg); padding: 12px; color: var(--pw-text); }
    .t { font-size: 11px; font-weight: 700; color: var(--pw-accent); margin-bottom: 5px; }
    .title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .msg { font-size: 13.5px; color: var(--pw-text-secondary); margin-bottom: 10px; white-space: pre-wrap; }
    .opts { display: flex; flex-direction: column; gap: 6px; }
    .opt { text-align: left; border: 1px solid var(--pw-border); border-radius: 9px; background: var(--pw-surface); color: var(--pw-text); padding: 8px 12px; cursor: pointer; font-size: 13.5px; }
    .opt:hover { border-color: var(--brand); background: var(--pw-surface-hover); }
    .opt:disabled { opacity: .55; cursor: not-allowed; }
    input, textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--inset); color: var(--pw-text); padding: 8px 10px; font: 14px/1.4 var(--font-sans); resize: vertical; }
    input:focus, textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(199, 243, 106, .11); }
    .acts { display: flex; gap: 8px; margin-top: 10px; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; border: 1px solid var(--border-strong); border-radius: 9px; background: rgba(244, 247, 241, .055); color: var(--pw-text); padding: 0 13px; cursor: pointer; font-size: 12.5px; font-weight: 580; transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast), filter var(--t-fast); }
    button:hover { background: rgba(244, 247, 241, .09); border-color: rgba(228, 238, 226, .26); }
    button:active { transform: scale(.97); }
    button.primary { background: var(--brand-grad); border-color: transparent; color: #10140e; font-weight: 700; box-shadow: 0 8px 22px rgba(122, 177, 77, .14), inset 0 1px 0 rgba(255, 255, 255, .38); }
    button.primary:hover { filter: brightness(1.04); box-shadow: 0 10px 28px rgba(122, 177, 77, .2), inset 0 1px 0 rgba(255, 255, 255, .42); }
    button:disabled { opacity: .45; pointer-events: none; }
    .err { color: var(--pw-danger); font-size: 12.5px; margin-top: 8px; }
  `;
  static properties = { ask: { attribute: false }, value: { state: true }, busy: { state: true }, err: { state: true } };
  constructor() {
    super();
    this.ask = null;
    this.value = "";
    this.busy = false;
    this.err = "";
  }
  _displayText(value, confirmed, cancelled) {
    const a = this.ask || {};
    if (cancelled) return "已取消提问";
    if (confirmed != null) return confirmed ? "已确认" : "已拒绝";
    const v = value != null ? String(value) : "";
    if (a.method === "select") {
      const opt = Array.isArray(a.options) ? a.options.find(o => o === v) : null;
      return `[选择] ${opt != null ? opt : v}`;
    }
    return v;
  }
  async _submit(value, confirmed, cancelled) {
    if (this.busy) return;
    const a = this.ask;
    if (!a || !a.id) return;
    if (value != null && String(value).trim() === "") return;
    this.busy = true;
    this.err = "";
    try {
      const body = { id: a.id };
      if (cancelled) body.cancelled = true;
      else if (confirmed != null) body.confirmed = confirmed;
      else body.value = String(value);
      await api(`/api/sessions/${sessionState.detail ? sessionState.detail.id : ""}/ask`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      window.dispatchEvent(new CustomEvent("ph-session-ask-answered", {
        detail: { askId: a.id, text: this._displayText(value, confirmed, cancelled) },
      }));
    } catch (e) {
      this.err = e.message || String(e);
    }
    this.busy = false;
  }
  render() {
    const a = this.ask || {};
    const method = a.method || "select";
    const title = a.title || (method === "confirm" ? "请确认" : "请选择");
    return html`<div class="ask">
      <div class="t">agent 提问</div>
      <div class="title">${title}</div>
      ${method === "confirm" && a.message ? html`<div class="msg">${a.message}</div>` : ""}
      ${method === "select" && Array.isArray(a.options) && a.options.length ? html`<div class="opts">
        ${a.options.map(o => html`<button class="opt" ?disabled=${this.busy} @click=${() => this._submit(o, null, false)}>${o}</button>`)}
      </div>` : ""}
      ${method === "input" || method === "editor" ? html`
        ${method === "editor"
          ? html`<textarea rows="4" .value=${this.value} ?disabled=${this.busy} placeholder=${a.placeholder || "输入内容…"} @input=${e => this.value = e.target.value}></textarea>`
          : html`<input .value=${this.value} ?disabled=${this.busy} placeholder=${a.placeholder || "输入内容…"} @input=${e => this.value = e.target.value} @keydown=${e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); this._submit(this.value, null, false); } }}>`}
        <div class="acts">
          <button class="primary" ?disabled=${this.busy || !this.value.trim()} @click=${() => this._submit(this.value, null, false)}>发送</button>
          <button ?disabled=${this.busy} @click=${() => this._submit(null, null, true)}>取消</button>
        </div>` : ""}
      ${method === "confirm" ? html`<div class="acts">
        <button class="primary" ?disabled=${this.busy} @click=${() => this._submit(null, true, false)}>确认</button>
        <button ?disabled=${this.busy} @click=${() => this._submit(null, false, false)}>拒绝</button>
        <button ?disabled=${this.busy} @click=${() => this._submit(null, null, true)}>取消</button>
      </div>` : ""}
      ${this.err ? html`<div class="err">${this.err}</div>` : ""}
    </div>`;
  }
}
customElements.define("ph-ask-card", PhAskCard);

// 工具卡片：状态边框（pending/running/success/error）+ 标题行
// （状态图标 + 工具名 + 目标）+ 状态徽标，折叠结果/diff。
class PhToolCard extends LitElement {
  static styles = css`
    ${PW}
    :host { display: block; width: 100%; max-width: 100%; min-width: 0; color: var(--pw-text); }
    .tool-card { display: grid; gap: 8px; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; border: 1px solid var(--pw-border); border-radius: 8px; background: var(--pw-bg); padding: 9px; color: var(--pw-text); }
    .tool-card.pending { border-color: var(--pw-border); background: var(--pw-bg); }
    .tool-card.running { border-color: var(--pw-warning-border); background: var(--pw-warning-surface); }
    .tool-card.success { border-color: var(--pw-success-border); background: var(--pw-success-bg); }
    .tool-card.error { border-color: var(--pw-danger); background: color-mix(in srgb, var(--pw-danger) 10%, var(--pw-bg)); }
    .tool-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
    .tool-title { flex: 1 1 auto; display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
    .status-icon { flex: 0 0 auto; color: var(--pw-muted); }
    .tool-title strong { flex: 0 0 auto; color: var(--pw-text); font-size: 13px; font-weight: 600; }
    .path { display: block; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow-x: auto; overflow-y: hidden; white-space: pre; color: var(--pw-accent); font: 13px var(--font-mono); direction: ltr; text-align: left; }
    .summary { display: block; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pw-muted); font-size: 12.5px; }
    .tool-meta { flex: 0 0 auto; display: inline-flex; align-items: baseline; gap: 8px; color: var(--pw-muted); font-size: 12px; }
    .status-label { text-transform: uppercase; letter-spacing: .04em; color: var(--pw-muted); }
    .text-body { border-top: 1px solid var(--pw-border-muted); padding-top: 6px; }
    .text-body > summary { cursor: pointer; color: var(--pw-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .detail-result { display: grid; gap: 4px; margin-top: 8px; min-width: 0; }
    .detail-label { color: var(--pw-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .detail-result pre { box-sizing: border-box; max-width: 100%; overflow-x: auto; overflow-y: hidden; border: 1px solid var(--pw-border-muted); border-radius: 7px; background: var(--pw-bg); padding: 8px; margin: 0; white-space: pre; overflow-wrap: normal; font: 12px var(--font-mono); color: var(--pw-text); }
    .diff { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; margin: 8px 0 0; overflow-x: auto; border: 1px solid var(--pw-border-muted); border-radius: 7px; background: var(--pw-bg); padding: 8px 0; color: var(--pw-muted); font: 12px var(--font-mono); line-height: 1.45; }
    .diff span { display: block; min-height: 1.45em; padding: 0 8px; white-space: pre; }
    .diff .context { color: var(--pw-muted); }
    .diff .hunk { color: var(--pw-accent); }
    .diff .file { color: var(--pw-dim); }
    .diff .added { background: color-mix(in srgb, var(--pw-success) 12%, transparent); color: var(--pw-success); }
    .diff .removed { background: color-mix(in srgb, var(--pw-danger) 12%, transparent); color: var(--pw-danger); }
  `;
  static properties = { call: { attribute: false }, result: { attribute: false }, open: { state: true } };
  constructor() { super(); this.open = false; }
  render() {
    const t = this.call || {};
    const r = this.result;
    const name = toolName(t);
    const arg = toolArg(name, t.arguments);
    const isErr = !!(r && r.isError);
    const status = r ? (isErr ? "error" : "success") : "pending";
    const icon = status === "success" ? "✓" : status === "error" ? "✖" : status === "running" ? "●" : "○";
    const statusLabel = status === "success" ? "完成" : status === "error" ? "失败" : status === "running" ? "运行中" : "等待";
    const targetClass = name === "bash" || name === "grep" || name === "glob" || name === "execute_bash" ? "summary" : "path";
    const body = r ? (Array.isArray(r.content) ? r.content.map(c => (c && c.text) || "").join("\n") : String(r.content || "")) : "";
    const diff = (r && r.details && typeof r.details.diff === "string") ? r.details.diff : "";
    return html`
      <div class="tool-card ${status}">
        <div class="tool-header">
          <div class="tool-title">
            <span class="status-icon">${icon}</span>
            <strong>${name}</strong>
            ${arg ? html`<span class="${targetClass}" title=${arg}>${arg}</span>` : ""}
          </div>
          <div class="tool-meta"><span class="status-label">${statusLabel}</span></div>
        </div>
        ${diff ? html`<pre class="diff">${diff.split("\n").map(l => html`<span class=${diffLineClass(l)}>${l}</span>`)}</pre>` : ""}
        ${!diff && body !== "" ? html`
          <details class="text-body" ?open=${isErr}>
            <summary>详情</summary>
            <div class="detail-result">
              <span class="detail-label">结果</span>
              <pre>${body}</pre>
            </div>
          </details>` : ""}
      </div>`;
  }
}
customElements.define("ph-tool-card", PhToolCard);

function diffLineClass(line) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  return "context";
}

// ---------------------------------------------------------------- 组件：输入区
export class PhSessionInput extends LitElement {
  static styles = css`
    ${PW}
    :host { flex: 0 0 auto; color: var(--pw-text); font: 14px var(--font-sans); }
    footer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 12px; border-top: 1px solid var(--pw-border); }
    footer.shell-mode { border-top-color: var(--pw-success); background: var(--pw-success-bg); }
    .editor-wrap { position: relative; min-width: 0; }
    textarea { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow-y: auto; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--inset); color: var(--pw-text); font: 15px/1.4 var(--font-sans); padding: 8px 10px; transition: border-color var(--t-fast), box-shadow var(--t-fast); }
    textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(199, 243, 106, .11); }
    .shell-mode textarea { border-color: var(--pw-success); box-shadow: 0 0 0 1px var(--pw-success-ring); }
    textarea:disabled { opacity: .5; cursor: not-allowed; }
    .mode-hint { position: absolute; right: 12px; bottom: 10px; max-width: calc(100% - 24px); border: 1px solid var(--pw-success-border); border-radius: 999px; background: var(--pw-success-surface); color: var(--pw-success); padding: 2px 8px; font-size: 12px; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: nowrap; white-space: nowrap; }
    .hint { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--pw-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
    .template-picker { box-sizing: border-box; flex: 0 1 160px; width: 160px; min-width: 104px; height: 32px; border: 1px solid var(--border-strong); border-radius: 9px; background: rgba(244, 247, 241, .055); color: var(--pw-text); padding: 0 28px 0 10px; cursor: pointer; font: 12.5px var(--font-sans); text-overflow: ellipsis; }
    .template-picker:hover { background: rgba(244, 247, 241, .09); border-color: rgba(228, 238, 226, .26); }
    .template-picker:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(199, 243, 106, .11); }
    .template-picker:disabled { opacity: .45; cursor: not-allowed; }
    .mode { display: flex; border: 1px solid var(--pw-border); border-radius: 7px; overflow: hidden; flex: 0 0 auto; }
    .mode span { padding: 3px 9px; font-size: 11.5px; cursor: pointer; color: var(--pw-muted); user-select: none; }
    .mode span.on { background: var(--pw-selection-bg); color: var(--pw-accent); }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; border: 1px solid var(--border-strong); border-radius: 9px; background: rgba(244, 247, 241, .055); color: var(--pw-text); padding: 0 13px; cursor: pointer; font-size: 12.5px; font-weight: 580; transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast), filter var(--t-fast); }
    button:hover { background: rgba(244, 247, 241, .09); border-color: rgba(228, 238, 226, .26); }
    button:active { transform: scale(.97); }
    button.danger { color: var(--danger); }
    button.danger:hover { background: var(--danger-dim); border-color: rgba(248, 113, 113, .4); }
    button:disabled { opacity: .45; pointer-events: none; }
    .send-button { flex: 0 0 auto; display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; }
    .send-button:not(:disabled) { background: var(--brand-grad); border-color: transparent; color: #10140e; box-shadow: 0 8px 22px rgba(122, 177, 77, .14), inset 0 1px 0 rgba(255, 255, 255, .38); }
    .send-button:not(:disabled):hover { filter: brightness(1.04); box-shadow: 0 10px 28px rgba(122, 177, 77, .2), inset 0 1px 0 rgba(255, 255, 255, .42); }
    .send-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    @media (max-width: 600px) {
      .hint { display: none; }
      .template-picker { flex-basis: 88px; width: 88px; min-width: 0; padding-left: 8px; }
      button { padding-inline: 9px; }
    }
  `;
  static properties = {
    session: { attribute: false }, running: { attribute: false }, value: { state: true }, mode: { state: true },
    templates: { state: true }, templatesLoading: { state: true }, templatesFailed: { state: true },
  };
  constructor() {
    super();
    this.value = "";
    this.mode = "steer";
    this.templates = [];
    this.templatesLoading = true;
    this.templatesFailed = false;
  }
  connectedCallback() {
    super.connectedCallback();
    this._loadTemplates();
  }
  async _loadTemplates() {
    this.templatesLoading = true;
    this.templatesFailed = false;
    try {
      const templates = await api("/api/templates");
      this.templates = Array.isArray(templates) ? templates : [];
    } catch (_) {
      this.templates = [];
      this.templatesFailed = true;
    } finally {
      this.templatesLoading = false;
    }
  }
  _insertTemplate(event) {
    const select = event.currentTarget;
    const template = this.templates.find(item => String(item.id) === select.value);
    select.value = "";
    if (!template || !template.body) return;
    const editor = this.renderRoot.querySelector("textarea");
    const inserted = insertTemplateText(
      this.value,
      template.body,
      editor ? editor.selectionStart : this.value.length,
      editor ? editor.selectionEnd : this.value.length,
    );
    this.value = inserted.value;
    this.updateComplete.then(() => {
      const nextEditor = this.renderRoot.querySelector("textarea");
      if (!nextEditor || nextEditor.disabled) return;
      nextEditor.focus();
      nextEditor.setSelectionRange(inserted.cursor, inserted.cursor);
    });
    toast(`已插入模板「${template.name}」`);
  }
  _send() {
    const msg = this.value.trim();
    if (!msg) return;
    const id = this.session.id;
    const body = { message: msg };
    if (this.running) body.streaming_behavior = this.mode === "followUp" ? "followUp" : "steer";
    // 乐观触发：点击发送立即点亮 activity-dock（真实 message_start 到达时清除）
    sessionState.sending = true;
    window.dispatchEvent(new CustomEvent("ph-session-message", { detail: { session_id: id, event: { type: "queue_update" } } }));
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
      .catch(e => {
        sessionState.sending = false;
        window.dispatchEvent(new CustomEvent("ph-session-message", { detail: { session_id: id, event: { type: "queue_update" } } }));
        toastErr(e.message || String(e));
      });
  }
  _abort() {
    api(`/api/sessions/${this.session.id}/abort`, { method: "POST" })
      .then(() => window.dispatchEvent(new CustomEvent("ph-session-updated")))
      .catch(e => toastErr(e.message || String(e)));
  }
  render() {
    const s = this.session;
    // 交互式提问挂起时输入框冻结（答案必须走提问卡片，pi 的
    // extension_ui_response 是唯一应答通道，prompt 会被当作新回合）。
    const askPending = !!sessionState.pendingAsk;
    // 仅交付/删除冻结输入；created/suspended 发送时自动启动/恢复（pi-web 行为）。
    const disabled = s.status === "delivered" || s.status === "deleted" || askPending;
    const shellMode = this.running && s.status === "active";
    const hint =
      askPending ? "agent 正在等你回答问题（见上方提问卡片）" :
      s.status === "delivered" ? "已交付为任务，会话冻结（只读）" :
      s.status === "deleted" ? "会话已删除" :
      s.status === "created" ? "发送消息将自动启动会话" :
      s.status === "suspended" ? "空闲已自动挂起，发送消息将自动恢复" :
      shellMode ? "agent 正在处理…" :
      "Enter 发送 · Shift+Enter 换行";
    return html`
      <footer class=${shellMode && !askPending ? "shell-mode" : ""}>
        <div class="editor-wrap">
          <textarea .value=${this.value} ?disabled=${disabled} @input=${(e) => this.value = e.target.value}
            @keydown=${(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this._send(); } }}
            placeholder=${disabled ? hint : "输入指令，与 agent 协作…"}></textarea>
          ${shellMode && !askPending ? html`<span class="mode-hint">运行中 · 消息将排队</span>` : ""}
        </div>
        <div class="actions">
          ${shellMode && !askPending ? html`
            <span class="mode">
              <span class=${this.mode === "steer" ? "on" : ""} @click=${() => this.mode = "steer"}>插入</span>
              <span class=${this.mode === "followUp" ? "on" : ""} @click=${() => this.mode = "followUp"}>排队</span>
            </span>
            <button class="danger" @click=${this._abort}>■ 中止</button>` : ""}
          <select class="template-picker" aria-label="插入模板" title="将模板内容插入当前输入位置"
            ?disabled=${disabled || this.templatesLoading || !this.templates.length}
            @change=${this._insertTemplate}>
            <option value="">${this.templatesLoading ? "模板加载中…" : this.templatesFailed ? "模板加载失败" : this.templates.length ? "插入模板" : "暂无模板"}</option>
            ${this.templates.map(template => html`<option value=${template.id}>${template.name}</option>`)}
          </select>
          <span class="hint">${hint}</span>
          <button class="send-button" ?disabled=${disabled || !this.value.trim()} @click=${this._send} title="发送 (Enter)" aria-label="发送">
            <svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>
          </button>
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
