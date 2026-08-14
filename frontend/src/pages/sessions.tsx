import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, Pause, Play, Send, Square, Trash2, Truck } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Markdown } from "../components/markdown";
import { PageHeader } from "../components/shell";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Project, Role, Session } from "../types";

const sessionTone: Record<string, "neutral" | "good" | "warn" | "info"> = { created: "neutral", active: "good", suspended: "warn", delivered: "info", deleted: "neutral" };
const sessionLabel: Record<string, string> = { created: "未启动", active: "活跃", suspended: "已挂起", delivered: "已交付", deleted: "已删除" };

export function SessionsPage() {
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: () => api<Session[]>("/sessions"), refetchInterval: 15_000 });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
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
  return <>
    <PageHeader kicker="Structured conversations" title="会话" copy="常驻会话保存结构化消息与工作区；形成明确成果后再交付为任务。" actions={<Button variant="primary" onClick={() => setOpen(true)}><CirclePlus size={16} />新建会话</Button>} />
    {sessions.isLoading ? <Spinner /> : sessions.data?.length ? <div className="grid gap-3 lg:grid-cols-2">{sessions.data.map(item => <Link key={item.id} to={`/sessions/${item.id}`} className="rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:border-brand/35 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"><div className="flex items-center gap-2"><span className="text-xs text-faint">#{item.id}</span><h2 className="truncate font-semibold">{item.title}</h2><Badge tone={sessionTone[item.status] || "neutral"}>{sessionLabel[item.status] || item.status}</Badge></div><div className="mt-3 flex flex-wrap gap-2 text-sm text-muted"><span>{item.role_name}</span>{item.project_name && <span>· {item.project_name}</span>}<span>· {item.message_count} 条消息</span></div></Link>)}</div> : <Empty title="没有会话" copy="选择支持 session 能力的角色，开始一次可挂起、恢复和交付的对话。" />}
    <Dialog open={open} onOpenChange={setOpen} title="新建会话"><form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}><Field label="角色"><select className={inputClass} required value={roleID} onChange={e => setRoleID(e.target.value)}><option value="">请选择</option>{eligible.map(role => <option key={role.id} value={role.id}>{role.name} · {role.runtime_id}</option>)}</select></Field><Field label="项目"><select className={inputClass} value={projectID} onChange={e => setProjectID(e.target.value)}><option value="">不绑定项目</option>{projects.data?.filter(p => p.status === "active").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><Field label="初始指令"><textarea className={inputClass + " min-h-20 py-3"} placeholder="可选：创建并启动后发送给会话的第一条指令" value={initialPrompt} onChange={e => setInitialPrompt(e.target.value)} /></Field>{!eligible.length && <p className="text-sm text-warning">请先创建启用的 pi 或 omp 角色。</p>}{create.error instanceof Error && <p className="text-sm text-danger">{create.error.message}</p>}<div className="flex justify-end"><Button variant="primary" disabled={!eligible.length || create.isPending}><Play size={16} />创建并启动</Button></div></form></Dialog>
  </>;
}

type TranscriptEntry = { id?: string; type?: string; role?: string; content?: unknown; text?: string; message?: { content?: unknown }; timestamp?: string };

export function SessionDetailPage() {
  const id = Number(useParams().id);
  const session = useQuery({ queryKey: [...keys.sessions, id], queryFn: () => api<Session>(`/sessions/${id}`), refetchInterval: 10_000 });
  const transcript = useQuery({ queryKey: ["sessions", id, "transcript"], queryFn: () => api<{ entries: TranscriptEntry[]; total: number }>(`/sessions/${id}/transcript?limit=200`), enabled: !!session.data, refetchInterval: session.data?.status === "active" ? 2_000 : false });
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [behavior, setBehavior] = useState<"follow_up" | "steer">("follow_up");
  const [older, setOlder] = useState<TranscriptEntry[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [delivery, setDelivery] = useState({ task_title: "", task_body: "", perm: "review" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["sessions", id] }); qc.invalidateQueries({ queryKey: keys.sessions }); };
  const action = useMutation({ mutationFn: (name: string) => api(`/sessions/${id}/${name}`, { method: "POST" }), onSuccess: refresh });
  const prompt = useMutation({ mutationFn: () => api(`/sessions/${id}/prompt`, { method: "POST", body: { message, streaming_behavior: behavior } }), onSuccess: () => { setMessage(""); qc.invalidateQueries({ queryKey: ["sessions", id, "transcript"] }); } });
  const abort = useMutation({ mutationFn: () => api(`/sessions/${id}/abort`, { method: "POST" }), onSuccess: () => { toast("已发送中止"); refresh(); }, onError: error => toast(error instanceof Error ? error.message : "中止失败", "bad") });
  const ask = useMutation({ mutationFn: (body: { id: string; value?: string; confirmed?: boolean }) => api(`/sessions/${id}/ask`, { method: "POST", body }), onSuccess: (_data, vars) => { setAnswered(prev => ({ ...prev, [vars.id]: true })); qc.invalidateQueries({ queryKey: ["sessions", id, "transcript"] }); }, onError: error => toast(error instanceof Error ? error.message : "应答失败", "bad") });
  const loadOlder = async () => {
    const loaded = [...older, ...(transcript.data?.entries ?? [])];
    const first = loaded[0];
    if (!first) return;
    const before = typeof first.id === "string" && first.id ? first.id : JSON.stringify(first);
    setLoadingOlder(true);
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
  const deliver = useMutation({ mutationFn: () => api(`/sessions/${id}/deliver`, { method: "POST", body: delivery }), onSuccess: () => { setDeliverOpen(false); refresh(); toast("会话已交付为任务"); } });
  const remove = useMutation({ mutationFn: () => api(`/sessions/${id}`, { method: "DELETE", revision: session.data?.revision }), onSuccess: () => navigate("/sessions") });
  if (session.isLoading) return <Spinner />;
  if (!session.data) return <Empty title="会话不存在" copy="它可能已经被删除。" />;
  const item = session.data;
  const recentActivity = (() => {
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const ts = allEntries[i].timestamp;
      if (ts) return Date.now() - new Date(ts).getTime() < 60_000;
    }
    return false;
  })();
  return <>
    <PageHeader kicker={`Session #${item.id}`} title={item.title} copy={`${item.role_name || "角色"} · ${item.project_name || "无项目"} · ${item.runtime_id}`} actions={<><Badge tone={sessionTone[item.status] || "neutral"}>{sessionLabel[item.status]}</Badge>{item.status === "created" && <Button variant="primary" onClick={() => action.mutate("start")}><Play size={16} />启动</Button>}{item.status === "suspended" && <Button variant="primary" onClick={() => action.mutate("resume")}><Play size={16} />恢复</Button>}{item.status === "active" && <Button onClick={() => action.mutate("suspend")}><Pause size={16} />挂起</Button>}{["active", "suspended"].includes(item.status) && <Button onClick={() => setDeliverOpen(true)}><Truck size={16} />交付</Button>}{item.status === "active" && (prompt.isPending || recentActivity) && <Button variant="danger" disabled={abort.isPending} onClick={() => abort.mutate()}><Square size={16} />中止</Button>}<Button variant="danger" onClick={() => confirm("删除这个会话及其工作区？") && remove.mutate()}><Trash2 size={16} /></Button></>} />
    <Card className="min-h-[28rem]"><div className="mb-5 flex items-center justify-between"><h2 className="font-semibold">消息</h2><span className="flex items-center gap-2"><span className="text-xs text-muted">{transcript.data?.total || item.message_count} 条</span>{prompt.isPending && <Badge tone="info">正在处理…</Badge>}</span></div>{transcript.isLoading ? <Spinner /> : allEntries.length ? <><div className="grid gap-4">{allEntries.map((entry, index) => { const entryKey = typeof entry.id === "string" && entry.id ? entry.id : JSON.stringify(entry); return <article key={entry.id || index} className="rounded-xl border border-line bg-elevated p-4">{entry.type === "extension_ui_request" ? <ExtensionRequestCard entry={entry} answered={!!answered[entryKey]} onAsk={body => ask.mutate(body)} /> : <><div className="mb-3 flex items-center gap-2 text-xs text-muted"><Badge tone={entry.role === "assistant" ? "info" : "neutral"}>{entry.role === "assistant" ? "助手" : entry.role === "user" ? "用户" : entry.type || "事件"}</Badge>{entry.timestamp && <time>{new Date(entry.timestamp).toLocaleString("zh-CN")}</time>}</div><TranscriptContent entry={entry} /></>}</article>; })}</div>{(transcript.data?.total ?? allEntries.length) > allEntries.length && <div className="mt-4 flex justify-center"><Button size="sm" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "加载中…" : "加载更早"}</Button></div>}</> : <Empty title="还没有消息" copy="在下方输入第一条消息。" />}</Card>
    {item.status === "active" && <form className="sticky bottom-4 mt-5 flex gap-3 rounded-2xl border border-line bg-surface/95 p-3 shadow-xl backdrop-blur" onSubmit={e => { e.preventDefault(); prompt.mutate(); }}><textarea className={inputClass + " min-h-14 resize-y py-3"} required aria-label="发送消息" placeholder="输入消息…" value={message} onChange={e => setMessage(e.target.value)} /><select className="w-28 shrink-0 self-end rounded-xl border border-line bg-elevated px-2 py-2 text-sm text-ink outline-none focus:border-brand" aria-label="消息类型" value={behavior} onChange={e => setBehavior(e.target.value as "follow_up" | "steer")}><option value="follow_up">跟随</option><option value="steer">插入</option></select><Button variant="primary" disabled={prompt.isPending}><Send size={17} /><span className="hidden sm:inline">发送</span></Button></form>}
    <Dialog open={deliverOpen} onOpenChange={setDeliverOpen} title="交付为任务"><form className="grid gap-4" onSubmit={e => { e.preventDefault(); deliver.mutate(); }}><Field label="任务标题"><input className={inputClass} value={delivery.task_title} onChange={e => setDelivery({ ...delivery, task_title: e.target.value })} placeholder={item.title} /></Field><Field label="补充说明"><textarea className={inputClass + " min-h-28 py-3"} value={delivery.task_body} onChange={e => setDelivery({ ...delivery, task_body: e.target.value })} /></Field><Field label="权限"><select className={inputClass} value={delivery.perm} onChange={e => setDelivery({ ...delivery, perm: e.target.value })}><option value="review">人工审批</option><option value="full">自动整合</option></select></Field><div className="flex justify-end"><Button variant="primary">确认交付</Button></div></form></Dialog>
  </>;
}

function ExtensionRequestCard({ entry, answered, onAsk }: { entry: TranscriptEntry; answered: boolean; onAsk: (body: { id: string; value?: string; confirmed?: boolean }) => void }) {
  const raw = entry as unknown as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" && raw.title ? raw.title : "请求确认";
  const messageVal = raw.message;
  const body = typeof messageVal === "string" ? messageVal : messageVal && typeof messageVal === "object" && "content" in messageVal && typeof messageVal.content === "string" ? messageVal.content : typeof raw.text === "string" ? raw.text : "";
  const method = typeof raw.method === "string" ? raw.method : "confirm";
  const placeholder = typeof raw.placeholder === "string" ? raw.placeholder : undefined;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === "string") : [];
  const [value, setValue] = useState("");
  const disabled = answered || !id;
  const ask = (extra: { value?: string; confirmed?: boolean }) => onAsk({ id, ...extra });
  return <div className="flex flex-col gap-3"><div className="flex items-center gap-2"><Badge tone="warn">交互请求</Badge><h3 className="font-semibold">{title}</h3></div>{body && <p className="whitespace-pre-wrap text-sm text-muted">{body}</p>}{method === "select" && <div className="grid gap-2">{options.map(option => <button key={option} type="button" disabled={disabled} className="rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm transition hover:border-brand/40 hover:bg-hover disabled:opacity-50" onClick={() => ask({ value: option })}>{option}</button>)}</div>}{method === "confirm" && <div className="flex gap-2"><Button variant="primary" size="sm" disabled={disabled} onClick={() => ask({ confirmed: true })}>确认</Button><Button size="sm" disabled={disabled} onClick={() => ask({ confirmed: false })}>取消</Button></div>}{method === "input" && <div className="flex gap-2"><input className={inputClass + " min-w-0 flex-1"} placeholder={placeholder || "输入答案…"} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && value.trim() && !disabled) ask({ value: value.trim() }); }} /><Button size="sm" disabled={disabled || !value.trim()} onClick={() => ask({ value: value.trim() })}>提交</Button></div>}{method === "editor" && <div className="grid gap-2"><textarea className={inputClass + " min-h-28 py-3"} placeholder={placeholder || "输入内容…"} value={value} onChange={e => setValue(e.target.value)} /><div className="flex justify-end"><Button size="sm" disabled={disabled || !value.trim()} onClick={() => ask({ value: value.trim() })}>提交</Button></div></div>}{answered && <p className="text-xs"><Badge tone="good">已应答</Badge></p>}</div>;
}

function TranscriptContent({ entry }: { entry: TranscriptEntry }) {
  const content = entry.text ?? entry.content ?? entry.message?.content;
  if (typeof content === "string") return <Markdown>{content}</Markdown>;
  if (Array.isArray(content)) {
    const text = content.map(item => typeof item === "string" ? item : typeof item === "object" && item && "text" in item ? String((item as { text: unknown }).text) : JSON.stringify(item)).join("\n\n");
    return <Markdown>{text}</Markdown>;
  }
  return <pre className="overflow-auto whitespace-pre-wrap text-xs text-muted">{JSON.stringify(entry, null, 2)}</pre>;
}
