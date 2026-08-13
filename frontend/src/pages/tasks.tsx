import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePlus, FolderKanban, ListFilter, Play, RotateCcw, Square, TerminalSquare, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/shell";
import { TaskTerminal } from "../components/terminal";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Artifact, OverviewStats, Project, Role, Task, TaskLog, TaskTemplate } from "../types";

const statusLabel: Record<string, string> = { queued: "排队", claimed: "领取", running: "执行中", awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "取消" };
const statusTone: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = { queued: "neutral", claimed: "info", running: "info", awaiting_review: "warn", succeeded: "good", failed: "bad", cancelled: "neutral" };

export function TaskStatus({ status }: { status: string }) {
  return <Badge tone={statusTone[status] || "neutral"}>{statusLabel[status] || status}</Badge>;
}

function useTasks(query = "") {
  return useQuery({ queryKey: [...keys.tasks, query], queryFn: () => api<Task[]>(`/tasks${query}`), refetchInterval: 15_000 });
}

function TaskRow({ task }: { task: Task }) {
  return <Link to={`/tasks/${task.id}`} className="group grid gap-3 rounded-xl border border-line bg-elevated p-4 transition hover:border-brand/35 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus sm:grid-cols-[1fr_auto]">
    <div className="min-w-0"><div className="flex items-center gap-2"><span className="text-xs text-faint">#{task.id}</span><h3 className="truncate font-medium text-ink group-hover:text-brand-soft">{task.title}</h3></div><div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">{task.project_name && <span>{task.project_name}</span>}{task.role_name && <span>· {task.role_name}</span>}<span>· {formatTime(task.updated_at)}</span></div></div>
    <div className="flex items-center gap-2"><TaskStatus status={task.status} />{task.review_rounds > 0 && <Badge>{task.review_rounds} 轮</Badge>}</div>
  </Link>;
}

export function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => api<OverviewStats>("/stats/overview") });
  const tasks = useTasks("?limit=40");
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const active = tasks.data?.filter(task => ["queued", "claimed", "running", "awaiting_review"].includes(task.status)) || [];
  const metrics = [
    ["进行中", stats.data?.in_flight || 0], ["待审批", stats.data?.reviews || 0], ["已完成", stats.data?.succeeded || 0], ["成功率", `${Math.round(stats.data?.success_rate || 0)}%`]
  ];
  return <>
    <PageHeader kicker="Operations overview" title="工作台" copy="从审批、执行和项目进展开始，所有状态都由持久事件流同步。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value]) => <Card key={label as string}><div className="text-sm text-muted">{label}</div><div className="mt-3 text-3xl font-semibold tracking-tight text-ink">{value}</div></Card>)}</div>
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,.75fr)]">
      <Card><div className="mb-4 flex items-center"><div><h2 className="font-semibold">待办与执行</h2><p className="mt-1 text-sm text-muted">先处理审批，再跟进运行任务</p></div><Link to="/board" className="ml-auto text-sm text-brand-soft hover:underline">完整任务板 →</Link></div>
        {tasks.isLoading ? <Spinner /> : active.length ? <div className="grid gap-2">{active.slice(0, 8).map(task => <TaskRow key={task.id} task={task} />)}</div> : <Empty title="当前没有待办" copy="创建一个任务，或让 Workflow Plan 实例化任务节点。" />}
      </Card>
      <Card><div className="mb-4 flex items-center"><div><h2 className="font-semibold">活跃项目</h2><p className="mt-1 text-sm text-muted">工作目标与本地目录</p></div><Link to="/projects" className="ml-auto text-sm text-brand-soft">管理 →</Link></div>
        {projects.isLoading ? <Spinner /> : <div className="grid gap-2">{projects.data?.filter(project => project.status === "active").slice(0, 6).map(project => <Link to={`/projects/${project.id}`} key={project.id} className="flex items-center gap-3 rounded-xl border border-line bg-elevated p-3 hover:bg-hover"><span className="grid size-9 place-items-center rounded-lg bg-brand/10 text-brand-soft"><FolderKanban size={17} /></span><span className="min-w-0"><b className="block truncate text-sm">{project.name}</b><small className="block truncate text-muted">{project.project_dir}</small></span>{project.is_git && <Badge tone="good">git</Badge>}</Link>)}</div>}
      </Card>
    </div>
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

export function BoardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [project, setProject] = useState("");
  const tasks = useTasks();
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const filtered = useMemo(() => (tasks.data || []).filter(task => (!status || task.status === status) && (!project || String(task.project_id) === project)), [tasks.data, status, project]);
  const columns = [
    ["queued", "待执行"], ["running", "执行中"], ["awaiting_review", "待审批"], ["failed", "需处理"]
  ] as const;
  return <>
    <PageHeader kicker="Delivery pipeline" title="任务" copy="任务状态机、依赖交付、审批和代码整合保持确定性。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-44"} value={project} onChange={event => setProject(event.target.value)} aria-label="按项目筛选"><option value="">全部项目</option>{projects.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-40"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <span className="text-sm text-muted sm:ml-auto">{filtered.length} 个任务</span>
    </Card>
    {tasks.isLoading ? <Spinner /> : <div className="grid gap-4 xl:grid-cols-4">{columns.map(([key, label]) => <section key={key} className="min-w-0 rounded-2xl border border-line bg-surface/60 p-3"><div className="mb-3 flex items-center px-1"><h2 className="text-sm font-semibold">{label}</h2><Badge tone={statusTone[key]}>{filtered.filter(task => key === "failed" ? ["failed", "cancelled"].includes(task.status) : task.status === key).length}</Badge></div><div className="grid gap-2">{filtered.filter(task => key === "failed" ? ["failed", "cancelled"].includes(task.status) : task.status === key).map(task => <TaskRow key={task.id} task={task} />)}</div></section>)}</div>}
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

export function HistoryPage() {
  const tasks = useTasks("?limit=300");
  const terminal = tasks.data?.filter(task => ["succeeded", "failed", "cancelled"].includes(task.status)) || [];
  return <><PageHeader kicker="Audit history" title="历史" copy="已结算任务及其退出原因、审批轮次和时间。" />{tasks.isLoading ? <Spinner /> : terminal.length ? <Card className="overflow-hidden p-0"><div className="divide-y divide-line">{terminal.map(task => <TaskRow key={task.id} task={task} />)}</div></Card> : <Empty title="还没有历史" copy="任务进入终态后会显示在这里。" />}</>;
}

export function TaskDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const task = useQuery({ queryKey: keys.task(id), queryFn: () => api<Task>(`/tasks/${id}`), refetchInterval: 5000 });
  const logs = useQuery({ queryKey: ["tasks", id, "logs"], queryFn: () => api<{ logs: TaskLog[] }>(`/tasks/${id}/logs?limit=500`), refetchInterval: task.data?.status === "running" ? 1500 : false });
  const diff = useQuery({ queryKey: ["tasks", id, "diff"], queryFn: () => api<{ stat: string; diff: string; note?: string }>(`/tasks/${id}/diff`), enabled: task.data?.status === "awaiting_review" });
  const artifacts = useQuery({ queryKey: ["tasks", id, "artifacts"], queryFn: () => api<Artifact[]>(`/artifacts?task_id=${id}`) });
  const mutate = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Task>(`/tasks/${id}`, { method: "PATCH", revision: task.data?.revision, body }), onSuccess: value => { queryClient.setQueryData(keys.task(id), value); void queryClient.invalidateQueries({ queryKey: keys.tasks }); toast("任务已更新"); }, onError: error => toast((error as Error).message, "bad") });
  const remove = useMutation({ mutationFn: () => api<void>(`/tasks/${id}`, { method: "DELETE", revision: task.data?.revision }), onSuccess: () => { toast("任务已删除"); navigate("/board"); }, onError: error => toast((error as Error).message, "bad") });
  if (task.isLoading) return <Spinner />;
  if (!task.data) return <Empty title="任务不存在" copy="该任务可能已被删除。" />;
  const value = task.data;
  return <>
    <PageHeader kicker={`Task #${value.id}`} title={value.title} copy={`${value.project_name || "无项目"} · ${value.role_name || "未指派"}`} actions={<><TaskStatus status={value.status} /><Button variant="ghost" onClick={() => navigate(-1)}>返回</Button></>} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid gap-6">
        <Card><h2 className="mb-3 font-semibold">任务目标</h2><p className="whitespace-pre-wrap text-sm leading-7 text-muted">{value.body || "未填写任务说明"}</p></Card>
        {value.status === "awaiting_review" && <Card><h2 className="font-semibold">审批差异</h2><pre className="mt-3 max-h-[32rem] overflow-auto rounded-xl bg-[#080d15] p-4 text-xs leading-5 text-slate-200">{diff.data?.diff || diff.data?.note || "没有检测到差异"}</pre><div className="mt-4 flex gap-2"><Button variant="primary" onClick={() => mutate.mutate({ status: "succeeded" })}><Check size={16} />通过</Button><Button variant="danger" onClick={() => mutate.mutate({ status: "queued", review_note: "请根据审批意见修正后重新提交" })}><X size={16} />驳回重做</Button></div></Card>}
        <Card><div className="mb-3 flex items-center"><h2 className="font-semibold">终端与日志</h2><Badge tone={value.run_mode === "interactive" ? "info" : "neutral"}>{value.run_mode}</Badge></div><TaskTerminal task={value} logs={logs.data?.logs || []} /></Card>
      </div>
      <aside className="grid content-start gap-4">
        <Card><h2 className="font-semibold">属性</h2><dl className="mt-4 grid gap-3 text-sm">{[["状态", statusLabel[value.status]], ["权限", value.perm], ["依赖", value.dependency_mode], ["创建", formatTime(value.created_at)], ["更新", formatTime(value.updated_at)]].map(([key, text]) => <div key={key} className="flex gap-3"><dt className="w-14 text-muted">{key}</dt><dd className="min-w-0 flex-1 break-words">{text}</dd></div>)}</dl></Card>
        {artifacts.data?.length ? <Card><h2 className="font-semibold">Artifacts</h2><div className="mt-3 grid gap-2">{artifacts.data.map(item => <a key={item.id} className="rounded-lg border border-line p-3 text-sm hover:border-brand/40" href={`/api/v1/artifacts/${item.id}/content`}><span className="block truncate font-medium">{item.name}</span><span className="mt-1 block text-xs text-muted">{item.media_type} · {formatBytes(item.size)}</span></a>)}</div></Card> : null}
        <Card><h2 className="font-semibold">操作</h2><div className="mt-4 grid gap-2">{["failed", "cancelled"].includes(value.status) && <Button onClick={() => mutate.mutate({ status: "queued" })}><RotateCcw size={16} />重试</Button>}{["queued", "claimed", "running"].includes(value.status) && <Button variant="danger" onClick={() => mutate.mutate({ status: "cancelled" })}><Square size={15} />取消</Button>}{value.run_mode === "interactive" && value.status === "running" && <Button onClick={() => api(`/tasks/${id}/end-session`, { method: "POST" })}><TerminalSquare size={16} />结束会话</Button>}<Button variant="danger" onClick={() => { if (confirm("确定删除这个任务及其工作空间？")) remove.mutate(); }}>删除任务</Button></div></Card>
      </aside>
    </div>
  </>;
}

function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles"), enabled: open });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects"), enabled: open });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<TaskTemplate[]>("/templates"), enabled: open });
  const [form, setForm] = useState({ title: "", body: "", role_id: "", project_id: "", perm: "full", run_mode: "batch", concurrent: false });
  const create = useMutation({ mutationFn: () => api<Task>("/tasks", { method: "POST", body: { ...form, role_id: Number(form.role_id), project_id: Number(form.project_id), concurrent: form.concurrent, dependency_mode: "weak", block_on_failure: false } }), onSuccess: task => { void queryClient.invalidateQueries({ queryKey: keys.tasks }); onOpenChange(false); toast(`已创建任务 #${task.id}`); navigate(`/tasks/${task.id}`); }, onError: error => toast((error as Error).message, "bad") });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return <Dialog open={open} onOpenChange={onOpenChange} title="新建任务" description="任务必须绑定 Role 与 Project；Runtime 只负责执行。"><form className="grid gap-4" onSubmit={submit}>
    <Field label="标题"><input className={inputClass} required value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} autoFocus /></Field>
    <Field label="从模板插入"><select className={inputClass} value="" onChange={event => { const item = templates.data?.find(value => value.id === Number(event.target.value)); if (item) setForm(current => ({ ...current, title: current.title || item.name, body: current.body ? `${current.body}\n\n${item.body}` : item.body })); }}><option value="">选择模板…</option>{templates.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field label="任务说明"><textarea className={inputClass + " min-h-32 py-3"} required value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} /></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="项目"><select className={inputClass} required value={form.project_id} onChange={event => setForm({ ...form, project_id: event.target.value })}><option value="">选择项目</option>{projects.data?.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="角色"><select className={inputClass} required value={form.role_id} onChange={event => setForm({ ...form, role_id: event.target.value })}><option value="">选择角色</option>{roles.data?.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="权限"><select className={inputClass} value={form.perm} onChange={event => setForm({ ...form, perm: event.target.value })}><option value="full">自动整合</option><option value="review">人工审批</option></select></Field><Field label="运行方式"><select className={inputClass} value={form.run_mode} onChange={event => setForm({ ...form, run_mode: event.target.value })}><option value="batch">批处理</option><option value="interactive">交互终端</option></select></Field></div>
    <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={form.concurrent} onChange={event => setForm({ ...form, concurrent: event.target.checked })} />允许与同项目其他任务并行</label>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="primary" disabled={create.isPending}><Play size={16} />创建并排队</Button></div>
  </form></Dialog>;
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
