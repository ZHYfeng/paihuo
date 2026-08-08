// 任务 diff 可视化审查器（R1 + R4）：
// 解析 unified diff → 文件列表（折叠）+ 逐文件行号视图 + 大 hunk 上下文折叠。
// 待审批任务在顶部显示审批操作条（批准/驳回，全程不离开 diff 视图）。
import { LitElement, html, css, nothing } from "lit";
import { api } from "./core.js";

// ---------------------------------------------------------------- unified diff 解析
// 返回 { files: [{name, oldName, status, added, removed, hunks: [{oldStart,oldLines,newStart,newLines,lines:[{kind,text}]}]}] }
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git")) {
      if (cur) files.push(cur);
      cur = { name: "", oldName: "", status: "M", added: 0, removed: 0, hunks: [] };
      const m = /diff --git a\/(\S+) b\/(\S+)/.exec(l);
      if (m) { cur.oldName = m[1]; cur.name = m[2]; }
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("new file")) { cur.status = "A"; cur.name = cur.name || lines[i + 1]?.replace(/^.*\s/, ""); continue; }
    if (l.startsWith("deleted file")) { cur.status = "D"; continue; }
    if (l.startsWith("rename")) { cur.status = "R"; continue; }
    if (l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("Binary") || l.startsWith("similarity") || l.startsWith("dissimilarity")) continue;
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      cur.hunks.push({
        oldStart: +h[1], oldLines: h[2] ? +h[2] : 1,
        newStart: +h[3], newLines: h[4] ? +h[4] : 1,
        lines: [],
      });
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    if (!hunk) continue;
    if (l.startsWith("+")) { hunk.lines.push({ kind: "add", text: l.slice(1) }); cur.added++; }
    else if (l.startsWith("-")) { hunk.lines.push({ kind: "del", text: l.slice(1) }); cur.removed++; }
    else if (l.startsWith(" ")) hunk.lines.push({ kind: "ctx", text: l.slice(1) });
    else hunk.lines.push({ kind: "ctx", text: l });
  }
  if (cur) files.push(cur);
  return files;
}

// ---------------------------------------------------------------- 组件
export class PhTaskDiff extends LitElement {
  static styles = css`
    :host { display: block; color: var(--pw-text); font: 14px system-ui, sans-serif; }
    .bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--pw-border); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap; background: var(--pw-surface); }
    .bar .stat { font-size: 12.5px; color: var(--pw-muted); display: flex; gap: 8px; align-items: center; }
    .add { color: var(--pw-success); font-weight: 700; }
    .del { color: var(--pw-danger); font-weight: 700; }
    .spacer { flex: 1; }
    button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pw-border); border-radius: 7px; background: var(--pw-surface); color: var(--pw-text); padding: 4px 10px; cursor: pointer; font-size: 12.5px; }
    button:hover { background: var(--pw-surface-hover); }
    button.ok { background: var(--pw-success); border-color: var(--pw-success-border); color: #fff; font-weight: 600; }
    button.no { background: var(--pw-danger); border-color: var(--pw-danger); color: #fff; font-weight: 600; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    textarea { border: 1px solid var(--pw-border); border-radius: 8px; padding: 6px 10px; font-size: 13px; width: 260px; background: var(--pw-bg); color: var(--pw-text); font-family: inherit; }
    textarea:focus { outline: none; border-color: var(--pw-accent-border); }
    .fhead { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--pw-border); border-radius: 8px; margin: 4px 0; cursor: pointer; background: var(--pw-surface); font-size: 13px; color: var(--pw-text); }
    .fhead:hover { border-color: var(--pw-accent-border); }
    .fname { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .fmeta { font-size: 11.5px; color: var(--pw-muted); }
    .status { font-weight: 700; font-size: 11px; border-radius: 4px; padding: 0 5px; }
    .st-A { color: var(--pw-success); } .st-D { color: var(--pw-danger); } .st-M { color: var(--pw-accent); }
    table { border-collapse: collapse; width: 100%; font-family: ui-monospace, monospace; font-size: 12.5px; margin-bottom: 8px; border: 1px solid var(--pw-border); border-radius: 8px; overflow: hidden; background: var(--pw-bg); }
    tr { border: none; }
    td { padding: 0; vertical-align: top; }
    .ln { width: 44px; text-align: right; padding-right: 8px; color: var(--pw-dim); user-select: none; background: var(--pw-surface); }
    .tx { white-space: pre-wrap; word-break: break-all; padding-left: 10px; }
    .add { background: var(--pw-success-bg); }
    .del { background: color-mix(in srgb, var(--pw-danger) 10%, var(--pw-bg)); }
    .add .tx { color: var(--pw-success); } .del .tx { color: var(--pw-danger); }
    .ctx .tx { color: var(--pw-text-secondary); opacity: .8; }
    .fold { text-align: center; font-size: 11.5px; color: var(--pw-dim); background: var(--pw-surface); cursor: pointer; padding: 3px; user-select: none; }
    .fold:hover { color: var(--pw-accent); }
    .empty { color: var(--pw-muted); font-size: 13px; padding: 8px 4px; }
    .jump { margin-left: auto; font-size: 11.5px; color: var(--pw-dim); }
  `;
  static properties = {
    taskId: { attribute: false }, files: { state: true }, note: { state: true },
    loading: { state: true }, reviewNote: { state: true }, busy: { state: true },
  };
  constructor() {
    super();
    this.taskId = null;
    this.files = [];
    this.note = "";
    this.loading = false;
    this.open = new Set();
    this.reviewNote = "";
    this.busy = false;
  }
  async updated(changed) {
    if (changed.has("taskId") && this.taskId) await this.load();
  }
  async load() {
    this.loading = true;
    this.files = [];
    this.note = "";
    this.requestUpdate();
    try {
      const d = await api(`/api/tasks/${this.taskId}/diff`);
      const parsed = parseUnifiedDiff(d.diff);
      // 大文件默认折叠：>60 行改动或 >3 hunks
      for (const f of parsed) {
        const big = f.added + f.removed > 60 || f.hunks.length > 3;
        this.open.add(f.name);
        if (big) this.open.delete(f.name);
      }
      this.files = parsed;
      this.note = d.note || "";
      this._stat = d.stat;
    } catch (_) {}
    this.loading = false;
    this.requestUpdate();
  }
  _toggle(name) {
    if (this.open.has(name)) this.open.delete(name); else this.open.add(name);
    this.requestUpdate();
  }
  async approve() {
    this.busy = true;
    try {
      await api(`/api/tasks/${this.taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "succeeded" }),
      });
      window.dispatchEvent(new CustomEvent("task-refresh"));
    } catch (e) { import("./core.js").then(m => m.toast(e.message || String(e), true)); }
    this.busy = false;
  }
  async reject() {
    if (!this.reviewNote.trim()) { import("./core.js").then(m => m.toast("请填写修改意见", true)); return; }
    this.busy = true;
    try {
      await api(`/api/tasks/${this.taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "queued", review_note: this.reviewNote }),
      });
      this.reviewNote = "";
      window.dispatchEvent(new CustomEvent("task-refresh"));
    } catch (e) { import("./core.js").then(m => m.toast(e.message || String(e), true)); }
    this.busy = false;
  }
  render() {
    if (this.loading) return html`<div class="empty">加载 diff…</div>`;
    if (!this.files.length) return html`<div class="empty">无文件改动或非 git 仓库${this.note ? `（${this.note}）` : ""}</div>`;
    const totalAdd = this.files.reduce((s, f) => s + f.added, 0);
    const totalDel = this.files.reduce((s, f) => s + f.removed, 0);
    return html`
      <div class="bar">
        <span class="stat">${this.files.length} 个文件 · <span class="add">+${totalAdd}</span> <span class="del">-${totalDel}</span></span>
        <span class="spacer"></span>
        <button @click=${() => this._toggleAll(true)}>全部展开</button>
        <button @click=${() => this._toggleAll(false)}>全部折叠</button>
      </div>
      ${this.renderReviewBar()}
      ${this.files.map(f => this.renderFile(f))}
    `;
  }
  _toggleAll(open) {
    if (open) for (const f of this.files) this.open.add(f.name);
    else for (const f of this.files) this.open.delete(f.name);
    this.requestUpdate();
  }
  renderReviewBar() {
    const st = this._taskStatus;
    if (st !== "awaiting_review") return nothing;
    return html`
      <div class="bar" style="border-color:var(--warning);background:rgba(234,191,101,.08)">
        <span class="stat">⏳ 待审批 — 请审查下方 diff 后决定</span>
        <span class="spacer"></span>
        <textarea .value=${this.reviewNote} @input=${(e) => this.reviewNote = e.target.value} placeholder="驳回时填写修改意见…"></textarea>
        <button class="no" ?disabled=${this.busy} @click=${this.reject}>驳回</button>
        <button class="ok" ?disabled=${this.busy} @click=${this.approve}>批准合并</button>
      </div>`;
  }
  renderFile(f) {
    const open = this.open.has(f.name);
    return html`
      <div class="fhead" @click=${() => this._toggle(f.name)}>
        <span>${open ? "▾" : "▸"}</span>
        <span class="status st-${f.status}">${f.status === "A" ? "新增" : f.status === "D" ? "删除" : f.status === "R" ? "改名" : "修改"}</span>
        <span class="fname" title=${f.name}>${f.name}</span>
        <span class="fmeta">+${f.added} -${f.removed}</span>
        <span class="jump">${f.hunks.length} 段</span>
      </div>
      ${open ? f.hunks.map(h => this.renderHunk(f, h)) : ""}`;
  }
  renderHunk(f, h) {
    // 上下文折叠：>16 行的连续上下文段折叠为分隔条（保留首尾 3 行）
    const MAX_CTX = 16;
    const out = [];
    let oldN = h.oldStart, newN = h.newStart;
    let ctxRun = [];
    const flushCtx = (folded) => {
      if (!ctxRun.length) return;
      if (folded) {
        out.push(html`<tr><td class="fold" colspan="2" @click=${this._expandAll}>⋯ 上下文折叠 ${ctxRun.length} 行（点击展开全部）⋯</td></tr>`);
      } else {
        for (const l of ctxRun) out.push(this.row(l, oldN++, newN++));
      }
      ctxRun = [];
    };
    for (const l of h.lines) {
      if (l.kind === "ctx") {
        ctxRun.push(l);
        if (ctxRun.length > MAX_CTX) flushCtx(true); // 折叠：行号不前进（重新渲染时从头算）
        continue;
      }
      flushCtx(ctxRun.length > MAX_CTX && false);
      if (l.kind === "add") { out.push(this.row(l, null, newN++)); }
      else if (l.kind === "del") { out.push(this.row(l, oldN++, null)); }
    }
    flushCtx(false);
    return html`<table><tbody>${out}</tbody></table>`;
  }
  row(l, oldN, newN) {
    return html`<tr class=${l.kind}>
      <td class="ln">${oldN ?? ""}</td><td class="ln">${newN ?? ""}</td>
      <td class="tx">${l.text}</td></tr>`;
  }
}
customElements.define("ph-task-diff", PhTaskDiff);

// 供 task.js 挂载：把 <ph-task-diff> 填入 diffBox。
export function mountTaskDiff(el, taskId, taskStatus) {
  el.innerHTML = "";
  const node = document.createElement("ph-task-diff");
  node.taskId = taskId;
  node._taskStatus = taskStatus;
  el.appendChild(node);
  return node;
}
