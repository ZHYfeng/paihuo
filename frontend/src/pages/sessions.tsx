import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, Layers, Copy, Pause, Send, Square, Trash2, Truck } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Markdown } from "../components/markdown";
import { PageHeader } from "../components/shell";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Project, Role, Session, TaskTemplate } from "../types";

const sessionTone: Record<string, "neutral" | "good" | "warn" | "info"> = { created: "neutral", active: "good", suspended: "warn", delivered: "info", deleted: "neutral" };
const sessionLabel: Record<string, string> = { created: "未启动", active: "活跃", suspended: "已挂起", delivered: "已交付", deleted: "已删除" };

const FILTERS: Array<[string, string]> = [["all", "全部"], ["active", "活跃"], ["suspended", "已挂起"], ["created", "未启动"], ["delivered", "已交付"]];

export function SessionsPage() {
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: () => api<Session[]>("/sessions"), refetchInterval: 15_000 });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [roleID, setRoleID] = useState("");
  const [projectID, setProjectID] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const create = useMutation({
    mutationFn: () => api<Session>("/sessions", { method: "POST", body: { role_id: Number(roleID), project_id: projectID ? Number(projectID) : null } }),
    onSuccess: async item => {
      await api(`/sessions/${item.id}/start`, { method: "POST" });
      const seed = initialPrompt.trim();
      setInitialPrompt("");
      setOpen(false);
      if (seed) {
        try {
          await api(`/sessions/${item.id}/prompt`, { method: "POST", body: { message: seed, streaming_behavior: "follow_up" } });
        } catch (error) {
          toast(error instanceof Error ? error.message : "初始指令发送失败", "bad");
        }
      }
      navigate(`/sessions/${item.id}`);
    }
  });
  const eligible = roles.data?.filter(role => role.enabled && ["pi", "omp"].includes(role.runtime_id)) || [];
  const filtered = useMemo(() => filter === "all" ? (sessions.data || []) : (sessions.data || []).filter(item => item.status === filter), [sessions.data, filter]);
  return <>
    <PageHeader title="会话" copy="常驻会话保存结构化消息与工作区；形成明确成果后再交付为任务。" actions={<Button variant="primary" onClick={() => setOpen(true)}><CirclePlus size={16} />新建会话</Button>} />
    <Card className="mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted">筛选</span>
      <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-elevated p-0.5">{FILTERS.map(([value, label]) => <button key={value} className={`rounded-[10px] px-2.5 py-1 text-[13px] ${filter === value ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <span className="text-sm text-muted sm:ml-auto">{filtered.length} 个会话</span>
    </Card>
    {sessions.isLoading ? <Spinner /> : filtered.length ? <div className="grid gap-3 lg:grid-cols-2">{filtered.map(item => <Link key={item.id} to={`/sessions/${item.id}`} className="rounded-xl border border-line bg-surface p-3.5 shadow-card transition hover:border-brand/35 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"><div className="flex items-center gap-2"><span className="text-xs text-faint">#{item.id}</span><h2 className="truncate font-semibold">{item.title}</h2><Badge tone={sessionTone[item.status] || "neutral"}>{sessionLabel[item.status] || item.status}</Badge></div><div className="mt-2 flex flex-wrap gap-2 text-sm text-muted"><span>{item.role_name}</span>{item.project_name && <span>· {item.project_name}</span>}<span>· {item.message_count} 条消息</span><span className="ml-auto">{formatTime(item.updated_at)}</span></div></Link>)}</div> : <Empty title={filter === "all" ? "还没有会话" : "没有匹配的会话"} copy="会话保存完整的结构化对话，可在后续交付为任务。" />}
    <Dialog open={open} onOpenChange={setOpen} title="新建会话"><form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}><Field label="角色"><select className={inputClass} required value={roleID} onChange={e => setRoleID(e.target.value)}><option value="">请选择</option>{eligible.map(role => <option key={role.id} value={role.id}>{role.name} · {role.runtime_id}</option>)}</select></Field><Field label="项目"><select className={inputClass} value={projectID} onChange={e => setProjectID(e.target.value)}><option value="">不绑定项目</option>{projects.data?.filter(p => p.status === "active").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><Field label="初始指令"><textarea className={inputClass + " min-h-20 py-3"} placeholder="可选：创建后自动启动并发起首条消息…" value={initialPrompt} onChange={e => setInitialPrompt(e.target.value)} /></Field><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button type="submit" variant="primary" disabled={create.isPending}>创建并启动</Button></div></form></Dialog>
  </>;
}

/* ============================================================
   详情页：消息渲染（自旧 sessions.js buildRenderItems/renderItem 移植）
   ============================================================ */

type RenderItem = { kind: "user" | "assistant" | "bash" | "custom"; msg: Record<string, unknown>; key: string };

function msgContentOf(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = msg.content;
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function customDataText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(record.queries)) {
    for (const q of record.queries as Array<Record<string, unknown>>) {
      if (!q) continue;
      if (q.query) out.push(`> ${String(q.query)}`);
      if (q.answer) out.push(String(q.answer));
    }
  }
  if (Array.isArray(record.urls)) {
    for (const u of record.urls as Array<Record<string, unknown>>) {
      if (!u) continue;
      let line = `- ${String(u.url || "")}`;
      if (u.error) line += `（${String(u.error)}）`;
      out.push(line);
      if (u.title) out.push(`  ${String(u.title)}`);
    }
  }
  return out.join("\n\n");
}

function askAnsweredText(q: Record<string, unknown>): string {
  const vals = Array.isArray(q.values) ? q.values as string[] : [];
  if (!vals.length) return "（未回答）";
  const question = q.question as Record<string, unknown> | undefined;
  const opts = question && Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
  return vals.map(v => {
    const o = opts.find(item => item && item.value === v);
    return o && o.label ? String(o.label) : String(v);
  }).join("、");
}

function buildRenderItems(entries: Array<Record<string, unknown>>): RenderItem[] {
  const items: RenderItem[] = [];
  const byToolId = new Map<string, unknown>();
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const key = typeof e.id === "string" && e.id ? e.id : JSON.stringify(e);
    switch (e.type) {
      case "message": {
        const msg = (e.message as Record<string, unknown>) || {};
        const role = String(msg.role || "");
        if (role === "toolResult") { byToolId.set(String(msg.toolCallId || ""), msg); break; }
        if (role === "assistant") { items.push({ kind: "assistant", msg, key }); continue; }
        if (role === "bashExecution") { items.push({ kind: "bash", msg, key }); continue; }
        items.push({ kind: role === "user" ? "user" : "custom", msg, key });
        break;
      }
      case "model_change": items.push({ kind: "custom", msg: { customType: "model-change", content: `模型切换 → ${String(e.provider || "")}/${String(e.modelId || "")}` }, key }); break;
      case "thinking_level_change": items.push({ kind: "custom", msg: { customType: "thinking-change", content: `思考级别 → ${String(e.thinkingLevel || "")}` }, key }); break;
      case "compaction": items.push({ kind: "custom", msg: { customType: "compaction", content: `上下文已压缩（-${String(e.tokensBefore ?? "?")} tokens）`, summary: String(e.summary || "") }, key }); break;
      case "branch_summary": items.push({ kind: "custom", msg: { customType: "branch", content: `分支摘要${e.summary ? `: ${String(e.summary).slice(0, 60)}` : ""}` }, key }); break;
      case "custom_message": {
        if (e.display === false) break;
        items.push({ kind: "custom", msg: { customType: e.customType, content: e.content, details: e.details }, key });
        break;
      }
      case "custom": {
        items.push({ kind: "custom", msg: { customType: e.customType, content: customDataText(e.data) }, key });
        break;
      }
      default: break;
    }
  }
  return items;
}

const pwTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function pwTime(ts: unknown): string {
  if (!ts) return "";
  const d = new Date(String(ts));
  if (Number.isNaN(d.getTime())) return "";
  return pwTimeFmt.format(d);
}

function pwMeta(msg: Record<string, unknown>): string {
  return [pwTime(msg.timestamp), msg.model, msg.thinkingLevel].filter(Boolean).join(" · ");
}

function msgTextOf(msg: Record<string, unknown>): string {
  return msgContentOf(msg).filter(b => b.type === "text").map(b => String(b.text || "").trim()).filter(Boolean).join("\n\n");
}

function toolArg(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const key = name === "read_file" || name === "write_file" || name === "edit" || name === "edit_file" ? "path"
    : name === "grep" || name === "glob" ? "pattern"
      : name === "bash" ? "command" : "";
  if (key && record[key] != null) return String(record[key]).slice(0, 80);
  return "";
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  return "context";
}

function ToolCard({ call, result }: { call: Record<string, unknown>; result: unknown }) {
  const name = String(call.name || call.toolName || "tool");
  const arg = toolArg(name, call.arguments);
  const r = (result as Record<string, unknown>) || null;
  const isErr = Boolean(r && r.isError);
  const status = r ? (isErr ? "error" : "success") : "pending";
  const statusLabel = status === "success" ? "完成" : status === "error" ? "失败" : "等待";
  const targetClass = name === "bash" || name === "grep" || name === "glob" || name === "execute_bash" ? "summary" : "path";
  const body = r ? (Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>).map(c => String((c && c.text) || "")).join("\n") : String(r.content || "")) : "";
  const details = (r && r.details as Record<string, unknown>) || null;
  const diff = typeof details?.diff === "string" ? details.diff : "";
  return <div className={`tool-card ${status}`}>
    <div className="flex items-baseline justify-between gap-3"><div className="flex min-w-0 flex-1 items-baseline gap-2"><strong className="shrink-0 text-[13px] text-ink">{name}</strong>{arg ? <span className={`${targetClass} min-w-0 truncate font-mono text-xs ${targetClass === "path" ? "text-brand-soft" : "text-muted"}`} title={arg}>{arg}</span> : null}</div><span className="text-xs uppercase tracking-wide text-faint">{statusLabel}</span></div>
    {diff ? <pre className="tool-diff mt-2 overflow-x-auto rounded-lg border border-line bg-[#080d15] px-2 py-1">{diff.split("\n").map((line, index) => <span key={index} className={diffLineClass(line)}>{line}</span>)}</pre> : null}
    {!diff && body !== "" ? <details className="mt-2 border-t border-line pt-2" open={isErr}><summary className="cursor-pointer text-xs uppercase tracking-wide text-muted">详情</summary><pre className="mt-2 overflow-x-auto whitespace-pre rounded-lg border border-line bg-[#080d15] p-2 font-mono text-xs text-slate-200">{body}</pre></details> : null}
  </div>;
}

function AssistantParts({ msg }: { msg: Record<string, unknown> }) {
  const parts: React.ReactNode[] = [];
  for (const b of msgContentOf(msg)) {
    const type = String(b.type || "");
    const partKey = String(b.id || `${type}-${parts.length}`);
    if (type === "text") parts.push(<div key={partKey} className="markdown mt-0"><Markdown>{String(b.text || "")}</Markdown></div>);
    else if (type === "thinking") parts.push(<details key={partKey} className="thinking mt-2 border-t border-line pt-2"><summary className="cursor-pointer text-xs uppercase tracking-wide text-muted">思考</summary><div className="markdown mt-2"><Markdown>{String(b.thinking || "")}</Markdown></div></details>);
    else if (type === "toolCall" || type === "toolExecution") parts.push(<div key={partKey} className="mt-2"><ToolCard call={b} result={msg.toolResults && typeof msg.toolResults === "object" ? (msg.toolResults as Record<string, unknown>)[String(b.id || "")] : null} /></div>);
  }
  if (!parts.length) return null;
  return <>{parts}</>;
}

function CopyButton({ text }: { text: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return <button type="button" title="复制消息" aria-label="复制消息" className="grid size-6 place-items-center rounded-md border border-line bg-surface text-muted hover:text-ink" onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); toast("已复制"); window.setTimeout(() => setCopied(false), 1200); }).catch(() => toast("复制失败", "bad")); }}>{copied ? <span className="text-xs text-success">✓</span> : <Copy size={13} />}</button>;
}

function MessageCard({ item }: { item: RenderItem }) {
  const { kind, msg } = item;
  const meta = pwMeta(msg);
  const streaming = kind === "assistant" && String(msg.stopReason || "") === "pending";
  if (kind === "bash") {
    const err = Boolean(msg.isError) || (msg.exitCode != null && msg.exitCode !== 0);
    const lines: string[] = [];
    if (msg.command) lines.push(`$ ${String(msg.command)}`);
    if (msg.output) lines.push(String(msg.output));
    lines.push(`${err ? "✗ 失败" : "✓ 成功"}${msg.exitCode != null ? ` · exit ${String(msg.exitCode)}` : ""}${msg.truncated ? " · 已截断" : ""}`);
    return <div className={`msg-card bash ${streaming ? "streaming" : ""}`}>
      <div className="msg-head"><b className="msg-label">bash</b><span className="msg-meta" title={meta}>{meta}</span></div>
      <pre className="shell-output">{lines.join("\n")}</pre>
    </div>;
  }
  if (kind === "custom") {
    const customType = String(msg.customType || "custom");
    const details = msg.details as Record<string, unknown> | undefined;
    const qa = details && Array.isArray(details.questions) ? details.questions as Array<Record<string, unknown>> : null;
    if (customType === "model-change" || customType === "thinking-change" || customType === "compaction" || customType === "branch") {
      return <div className="pw-event" title={String(msg.summary || "")}>{String(msg.content || "")}</div>;
    }
    return <div className="rounded-xl border border-line bg-elevated p-3">
      <div className="text-xs uppercase tracking-wide text-brand-soft">{customType}</div>
      {qa && qa.length ? <div className="mt-2 grid gap-2">{qa.map((q, index) => <div key={index} className="border-l-2 border-line pl-2"><div className="markdown font-semibold"><Markdown>{String((q.question as Record<string, unknown>)?.question || "")}</Markdown></div><div className="mt-0.5 text-sm text-muted">→ {askAnsweredText(q)}</div></div>)}</div> : <div className="markdown mt-1"><Markdown>{String(msg.content || "")}</Markdown></div>}
    </div>;
  }
  if (kind === "user") {
    return <div className="msg-card user">
      <div className="msg-head"><b className="msg-label">用户</b><div className="flex items-center gap-2"><CopyButton text={msgTextOf(msg)} /><span className="msg-meta" title={meta}>{meta}</span></div></div>
      <div className="grid gap-2">{msgContentOf(msg).map((b, index) => b.type === "image" ? <img key={index} className="max-h-80 rounded-lg border border-line object-contain" src={`data:${String(b.mimeType || "image/png")};base64,${String(b.data || "")}`} alt="附件图片" /> : <div key={index} className="markdown"><Markdown>{String(b.text || "")}</Markdown></div>)}</div>
    </div>;
  }
  const metaText = meta + (msg.stopReason === "aborted" ? " · 已中止" : "");
  const usage = msg.usage as Record<string, unknown> | undefined;
  return <div className={`msg-card assistant ${streaming ? "streaming" : ""}`}>
    <div className="msg-head"><b className="msg-label">助手</b><div className="flex items-center gap-2"><CopyButton text={msgTextOf(msg)} /><span className="msg-meta" title={metaText}>{metaText}</span></div></div>
    <AssistantParts msg={msg} />
    {usage ? <div className="mt-1 text-[11.5px] text-faint">tokens: {String(usage.totalTokens || 0)}{usage.cost ? ` · $${String((usage.cost as Record<string, unknown>).total || 0)}` : ""}</div> : null}
  </div>;
}

/* ============================================================
   详情页
   ============================================================ */

type TranscriptEntry = Record<string, unknown>;

export function SessionDetailPage() {
  const id = Number(useParams().id);
  const session = useQuery({ queryKey: [...keys.sessions, id], queryFn: () => api<Session>(`/sessions/${id}`), refetchInterval: 10_000 });
  const transcript = useQuery({ queryKey: ["sessions", id, "transcript"], queryFn: () => api<{ entries: TranscriptEntry[]; total: number }>(`/sessions/${id}/transcript?limit=200`), enabled: !!session.data, refetchInterval: session.data?.status === "active" ? 3_000 : false });
  const canInput = !!(session.data && !["delivered", "deleted"].includes(session.data.status));
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<TaskTemplate[]>("/templates"), enabled: canInput });
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [behavior, setBehavior] = useState<"follow_up" | "steer">("follow_up");
  const [older, setOlder] = useState<TranscriptEntry[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [liveAsks, setLiveAsks] = useState<TranscriptEntry[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prevMsgLen = useRef(0);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [delivery, setDelivery] = useState({ task_title: "", task_body: "", perm: "review" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["sessions", id] }); qc.invalidateQueries({ queryKey: keys.sessions }); };
  const action = useMutation({ mutationFn: (name: string) => api(`/sessions/${id}/${name}`, { method: "POST" }), onSuccess: refresh });
  const compact = useMutation({ mutationFn: () => api(`/sessions/${id}/command`, { method: "POST", body: { command: "compact" } }), onSuccess: () => { toast("已压缩上下文"); refresh(); }, onError: error => toast(error instanceof Error ? error.message : "压缩失败", "bad") });
  const prompt = useMutation({ mutationFn: () => api(`/sessions/${id}/prompt`, { method: "POST", body: { message, streaming_behavior: behavior } }), onSuccess: () => { setMessage(""); refresh(); qc.invalidateQueries({ queryKey: ["sessions", id, "transcript"] }); }, onError: error => toast(error instanceof Error ? error.message : "发送失败", "bad") });
  const abort = useMutation({ mutationFn: () => api(`/sessions/${id}/abort`, { method: "POST" }), onSuccess: () => { toast("已发送中止"); refresh(); }, onError: error => toast(error instanceof Error ? error.message : "中止失败", "bad") });
  const ask = useMutation({ mutationFn: (body: { id: string; value?: string; confirmed?: boolean }) => api(`/sessions/${id}/ask`, { method: "POST", body }), onSuccess: (_data, vars) => { setAnswered(prev => ({ ...prev, [vars.id]: true })); qc.invalidateQueries({ queryKey: ["sessions", id, "transcript"] }); }, onError: error => toast(error instanceof Error ? error.message : "应答失败", "bad") });
  const loadOlder = async () => {
    const loaded = [...older, ...(transcript.data?.entries ?? [])];
    const first = loaded[0];
    if (!first) return;
    const before = typeof first.id === "string" && first.id ? first.id : JSON.stringify(first);
    setLoadingOlder(true);
    const el = listRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    try {
      const page = await api<{ entries: TranscriptEntry[]; total: number }>(`/sessions/${id}/transcript?limit=200&before=${encodeURIComponent(before)}`);
      setOlder(prev => {
        const seen = new Set<string>();
        const merged: TranscriptEntry[] = [];
        for (const entry of [...page.entries, ...prev]) {
          const key = typeof entry.id === "string" && entry.id ? entry.id : JSON.stringify(entry);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(entry);
        }
        return merged;
      });
      // 更早消息插到列表顶部：滚动偏移增加对应高度，保持当前可视内容不动。
      if (el) requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - prevHeight; });
    } catch (error) {
      toast(error instanceof Error ? error.message : "加载更早消息失败", "bad");
    } finally {
      setLoadingOlder(false);
    }
  };
  const allEntries = useMemo(() => {
    const seen = new Set<string>();
    const out: TranscriptEntry[] = [];
    for (const entry of [...older, ...(transcript.data?.entries ?? [])]) {
      const key = typeof entry.id === "string" && entry.id ? entry.id : JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }, [older, transcript.data]);
  const renderItems = useMemo(() => buildRenderItems(allEntries), [allEntries]);
  // 消息窗口滚动：内容增长时若已在底部附近则跟随；首次打开直接滚到底部。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const first = prevMsgLen.current === 0;
    const atBottom = el.scrollTop >= max - 120;
    prevMsgLen.current = renderItems.length;
    if (first || atBottom) el.scrollTop = max;
  }, [renderItems.length, liveAsks.length]);
  // SSE 实时：session.message 事件 → 增量刷新 transcript 与运行状态
  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    const receive = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data);
        const payload = envelope?.payload as Record<string, unknown> | undefined;
        if (!payload || Number(payload.session_id) !== id) return;
        const ev = payload.event as Record<string, unknown> | undefined;
        if (!ev) return;
        const type = String(ev.type || "");
        if (type === "agent_start" || type === "turn_start") setAgentRunning(true);
        if (type === "agent_settled" || type === "agent_end") { setAgentRunning(false); setSending(false); setLiveAsks([]); }
        if (type === "extension_ui_request") {
          const method = String(ev.method || "");
          if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
            setSending(false);
            setLiveAsks(prev => {
              const askId = String(ev.id || "");
              if (prev.some(item => String(item.id || "") === askId)) return prev;
              return [...prev, ev];
            });
          }
        }
        if (type === "user_echo" || type === "message_end" || type === "extension_ui_request") {
          qc.invalidateQueries({ queryKey: ["sessions", id, "transcript"] });
          qc.invalidateQueries({ queryKey: keys.sessions });
        }
      } catch { /* ignore malformed events */ }
    };
    source.addEventListener("session.message", receive);
    return () => source.close();
  }, [id, qc]);
  const deliver = useMutation({ mutationFn: () => api(`/sessions/${id}/deliver`, { method: "POST", body: delivery }), onSuccess: () => { setDeliverOpen(false); refresh(); toast("会话已交付为任务"); } });
  const remove = useMutation({ mutationFn: () => api(`/sessions/${id}`, { method: "DELETE", revision: session.data?.revision }), onSuccess: () => navigate("/sessions") });
  if (session.isLoading) return <Spinner />;
  if (!session.data) return <Empty title="会话不存在" copy="它可能已经被删除。" />;
  const item = session.data;
  const send = () => { if (!message.trim() || prompt.isPending) return; setSending(true); prompt.mutate(undefined, { onSettled: () => setSending(false) }); };
  const insertTemplate = (body: string) => {
    const current = message;
    const snippet = String(body || "");
    const start = 0, end = current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before && snippet && !/\s$/.test(before) && !/^\s/.test(snippet) ? "\n\n" : "";
    const suffix = after && snippet && !/\s$/.test(snippet) && !/^\s/.test(after) ? "\n\n" : "";
    setMessage(before + prefix + snippet + suffix + after);
  };
  return <>
    <PageHeader title={item.title} copy={`${item.role_name || "角色"} · ${item.project_name || "无项目"}`} actions={<><Badge tone={sessionTone[item.status] || "neutral"}>{sessionLabel[item.status]}</Badge>{item.status === "active" && <Button onClick={() => action.mutate("suspend")}><Pause size={16} />挂起</Button>}{item.status === "active" && <Button onClick={() => compact.mutate()} disabled={compact.isPending} title="压缩会话上下文，降低后续 token 消耗"><Layers size={16} />压缩上下文</Button>}{["active", "suspended"].includes(item.status) && <Button onClick={() => setDeliverOpen(true)}><Truck size={16} />交付</Button>}{item.status === "active" && <Button variant="danger" onClick={() => abort.mutate()}><Square size={15} />中止</Button>}<Button variant="ghost" onClick={() => { if (confirm(`删除会话 #${item.id}？其消息记录与工作区将一并删除。`)) remove.mutate(); }}><Trash2 size={15} />删除</Button><Button variant="ghost" onClick={() => navigate(-1)}>返回</Button></>} />
    <div className="session-rail" aria-label="会话进度" aria-valuenow={scrollPct}>
      <div className="rail-track"><div className="rail-progress" style={{ width: `${scrollPct}%` }} />{agentRunning && <span className="rail-marker" style={{ left: `${scrollPct}%` }} />}</div>
    </div>
    <Card className="flex h-[calc(100dvh-17rem)] flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between"><h2 className="font-semibold">消息</h2><span className="flex items-center gap-2"><span className="text-xs text-muted">{transcript.data?.total || item.message_count} 条</span>{(agentRunning || sending || prompt.isPending) && <Badge tone="info">{agentRunning ? "Agent 运行中" : sending || prompt.isPending ? "正在处理…" : ""}</Badge>}</span></div>
      <div ref={listRef} onScroll={e => { const el = e.currentTarget; const max = el.scrollHeight - el.clientHeight; setScrollPct(max > 0 ? Math.min(100, Math.round(el.scrollTop / max * 100)) : 0); }} className="min-h-0 flex-1 overflow-y-auto">
        {transcript.isLoading ? <Spinner /> : renderItems.length || liveAsks.length ? <>
          <div className="mb-3 text-center"><Button size="sm" variant="ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "加载中…" : "加载更早消息"}</Button></div>
          <div className="grid gap-3">{renderItems.map(item => <MessageCard key={item.key} item={item} />)}{liveAsks.map((entry, index) => { const entryKey = String(entry.id || `ask-${index}`); return <ExtensionRequestCard key={`ask-${entryKey}`} entry={entry} answered={!!answered[entryKey]} onAsk={body => ask.mutate(body)} />; })}</div>
        {item.status === "active" && agentRunning ? <div className="activity-dock active"><span className="dot" />Agent 正在执行…</div> : null}
        </> : <Empty title="还没有消息" copy="会话启动后，消息会实时显示在这里。" />}
      </div>
    </Card>
    {canInput && <form className="sticky bottom-4 mt-3 flex gap-3 rounded-xl border border-line bg-surface/95 p-3 shadow-pop backdrop-blur" onSubmit={e => { e.preventDefault(); send(); }}>
      <div className="grid min-w-0 flex-1 gap-2">
        <textarea className={inputClass + " min-h-14 resize-y py-3"} required aria-label="发送消息" placeholder="输入消息…（Enter 发送，Shift+Enter 换行）" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="flex flex-wrap items-center gap-2"><select className="w-40 rounded-xl border border-line bg-elevated px-2 py-2 text-sm text-ink outline-none focus:border-brand" aria-label="插入模板" value="" onChange={e => { const tpl = templates.data?.find(t => t.id === Number(e.target.value)); if (tpl) insertTemplate(tpl.body); }}><option value="">插入模板…</option>{templates.data?.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select><span className="text-xs text-faint">模板内容插入到输入框末尾</span></div>
      </div>
      <div className="flex shrink-0 flex-col items-stretch justify-between gap-2">
        <select className="w-28 self-end rounded-xl border border-line bg-elevated px-2 py-2 text-sm text-ink outline-none focus:border-brand" aria-label="消息类型" value={behavior} onChange={e => setBehavior(e.target.value as "follow_up" | "steer")}><option value="follow_up">跟随</option><option value="steer">插入</option></select>
        <Button variant="primary" disabled={!message.trim() || prompt.isPending}><Send size={16} />发送</Button>
      </div>
    </form>}
    <Dialog open={deliverOpen} onOpenChange={setDeliverOpen} title="交付为任务"><form className="grid gap-4" onSubmit={e => { e.preventDefault(); deliver.mutate(); }}><Field label="任务标题"><input className={inputClass} value={delivery.task_title} onChange={e => setDelivery({ ...delivery, task_title: e.target.value })} placeholder={item.title} /></Field><Field label="补充说明"><textarea className={inputClass + " min-h-28 py-3"} value={delivery.task_body} onChange={e => setDelivery({ ...delivery, task_body: e.target.value })} /></Field><Field label="权限"><select className={inputClass} value={delivery.perm} onChange={e => setDelivery({ ...delivery, perm: e.target.value })}><option value="review">人工审批</option><option value="full">自动整合</option></select></Field><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setDeliverOpen(false)}>取消</Button><Button type="submit" variant="primary" disabled={deliver.isPending}>交付</Button></div></form></Dialog>
  </>;
}

function ExtensionRequestCard({ entry, answered, onAsk }: { entry: TranscriptEntry; answered: boolean; onAsk: (body: { id: string; value?: string; confirmed?: boolean }) => void }) {
  const raw = entry;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" && raw.title ? raw.title : "请求确认";
  const messageVal = raw.message;
  const body = typeof messageVal === "string" ? messageVal : messageVal && typeof messageVal === "object" && "content" in messageVal && typeof (messageVal as { content?: unknown }).content === "string" ? String((messageVal as { content: string }).content) : typeof raw.text === "string" ? raw.text : "";
  const method = typeof raw.method === "string" ? raw.method : "confirm";
  const placeholder = typeof raw.placeholder === "string" ? raw.placeholder : undefined;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === "string") : [];
  const [value, setValue] = useState("");
  const disabled = answered || !id;
  const ask = (extra: { value?: string; confirmed?: boolean }) => onAsk({ id, ...extra });
  return <div className="flex flex-col gap-3"><div className="flex items-center gap-2"><Badge tone="warn">交互请求</Badge><h3 className="font-semibold">{title}</h3></div>{body && <p className="whitespace-pre-wrap text-sm text-muted">{body}</p>}{method === "select" && <div className="grid gap-2">{options.map(option => <button key={option} type="button" disabled={disabled} className="rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm transition hover:border-brand/40 hover:bg-hover disabled:opacity-50" onClick={() => ask({ value: option })}>{option}</button>)}</div>}{method === "confirm" && <div className="flex gap-2"><Button variant="primary" size="sm" disabled={disabled} onClick={() => ask({ confirmed: true })}>确认</Button><Button size="sm" disabled={disabled} onClick={() => ask({ confirmed: false })}>拒绝</Button></div>}{(method === "input" || method === "editor") && <div className="flex gap-2"><input className={inputClass} placeholder={placeholder} value={value} disabled={disabled} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter") ask({ value }); }} /><Button size="sm" variant="primary" disabled={disabled || !value.trim()} onClick={() => ask({ value })}>提交</Button></div>}{answered && <p className="text-xs text-success">已应答</p>}</div>;
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
